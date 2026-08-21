import {
  type InfrastructureError,
  type PrivateFileStoreService,
  type ProcessRunnerService,
} from "@codexbar/core";
import { Effect } from "effect";
import {
  deserializeClaudeSwapRetainedUsage,
  projectClaudeSwapAccounts,
  serializeClaudeSwapRetainedUsage,
  type ClaudeSwapAccountList,
  type ClaudeSwapAccountRow,
  type ClaudeSwapAccountSnapshot,
  type ClaudeSwapScopedUsageWindow,
  type ClaudeSwapUsageStatus,
  type ClaudeSwapUsageWindow,
} from "@codexbar/providers";

/** Same safety boundary as `ClaudeSwapAccountReader` in the Swift oracle. */
export const CLAUDE_SWAP_MAX_OUTPUT_BYTES = 262_144;
export const CLAUDE_SWAP_MAX_RETAINED_BYTES = 262_144;
export const CLAUDE_SWAP_DEFAULT_TIMEOUT_MS = 30_000;

export class ClaudeSwapAdapterError extends Error {
  readonly _tag = "ClaudeSwapAdapterError";

  constructor(message: string) {
    super(message);
    this.name = "ClaudeSwapAdapterError";
  }
}

export type ClaudeSwapAccountSwitchResult = {
  readonly switched: boolean;
  readonly fromAccountNumber?: number;
  readonly toAccountNumber: number;
  readonly reason: string;
};

const malformed = (details: string) =>
  new ClaudeSwapAdapterError(`claude-swap output is malformed: ${details}`);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const positiveSlot = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const finiteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** ISO-8601 forms accepted by Foundation's internet-date formatter. */
const parseTimestamp = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value))
    return undefined;
  return Number.isFinite(Date.parse(value)) ? value : undefined;
};

const usageStatus = (value: string): ClaudeSwapUsageStatus => {
  switch (value) {
    case "ok":
    case "token_expired":
    case "relogin_required":
    case "api_key":
    case "keychain_unavailable":
    case "no_credentials":
    case "unavailable":
      return value;
    default:
      return { unknown: value };
  }
};

const parseWindow = (
  value: unknown,
  slot: number,
  name: "fiveHour" | "sevenDay",
): ClaudeSwapUsageWindow | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw malformed(`slot ${slot} ${name} window is not an object`);
  if (!finiteNumber(value.pct))
    throw malformed(`slot ${slot} ${name} percent is not a finite number`);
  if (value.resetsAt !== undefined) {
    const resetsAt = parseTimestamp(value.resetsAt);
    if (resetsAt === undefined) throw malformed(`slot ${slot} ${name} resetsAt is not a timestamp`);
    return { usedPercent: Math.max(0, Math.min(100, value.pct)), resetsAt };
  }
  return { usedPercent: Math.max(0, Math.min(100, value.pct)) };
};

/** Scoped rows are additive: malformed rows cannot suppress account-wide usage. */
const parseScoped = (value: unknown): readonly ClaudeSwapScopedUsageWindow[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.name !== "string" || !finiteNumber(candidate.pct))
      return [];
    const name = candidate.name.trim();
    if (name === "") return [];
    const resetsAt =
      candidate.resetsAt === undefined ? undefined : parseTimestamp(candidate.resetsAt);
    if (candidate.resetsAt !== undefined && resetsAt === undefined) return [];
    return [
      {
        name,
        usedPercent: Math.max(0, Math.min(100, candidate.pct)),
        ...(resetsAt === undefined ? {} : { resetsAt }),
      },
    ];
  });
};

const parseRow = (value: unknown): ClaudeSwapAccountRow => {
  if (!isRecord(value)) throw malformed("account row is not an object");
  if (!positiveSlot(value.number)) throw malformed("account row has no numeric slot");
  const number = value.number;
  if (typeof value.active !== "boolean") throw malformed(`slot ${number} has no active flag`);
  if (typeof value.usageStatus !== "string") throw malformed(`slot ${number} has no usageStatus`);
  const usage = isRecord(value.usage) ? value.usage : undefined;
  const fiveHour =
    usage === undefined ? undefined : parseWindow(usage.fiveHour, number, "fiveHour");
  const sevenDay =
    usage === undefined ? undefined : parseWindow(usage.sevenDay, number, "sevenDay");
  return {
    number,
    email: typeof value.email === "string" ? value.email.trim() : "",
    organizationName:
      typeof value.organizationName === "string" ? value.organizationName.trim() : "",
    ...(typeof value.alias === "string" && value.alias.trim() !== ""
      ? { alias: value.alias.trim() }
      : {}),
    isActive: value.active,
    usageStatus: usageStatus(value.usageStatus),
    ...(fiveHour === undefined ? {} : { fiveHour }),
    ...(sevenDay === undefined ? {} : { sevenDay }),
    ...(usage?.scoped === undefined ? {} : { scoped: parseScoped(usage.scoped) }),
  };
};

/** Strict schema-v1 parser shared by Electron and the standalone CLI host. */
export const parseClaudeSwapAccountList = (bytes: Uint8Array): ClaudeSwapAccountList => {
  if (bytes.byteLength > CLAUDE_SWAP_MAX_OUTPUT_BYTES)
    throw new ClaudeSwapAdapterError(
      `claude-swap produced ${bytes.byteLength} bytes of output; refusing to parse more than ${CLAUDE_SWAP_MAX_OUTPUT_BYTES}.`,
    );
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new ClaudeSwapAdapterError("claude-swap returned output that is not a JSON object.");
  }
  if (!isRecord(raw))
    throw new ClaudeSwapAdapterError("claude-swap returned output that is not a JSON object.");
  if (!Number.isSafeInteger(raw.schemaVersion))
    throw new ClaudeSwapAdapterError("claude-swap output has no schemaVersion field.");
  if (raw.schemaVersion !== 1)
    throw new ClaudeSwapAdapterError(
      `claude-swap output uses unsupported schema version ${raw.schemaVersion}; CodexBar supports version 1.`,
    );
  if (isRecord(raw.error)) {
    const type = typeof raw.error.type === "string" ? raw.error.type : "Error";
    const message = typeof raw.error.message === "string" ? raw.error.message : "unknown error";
    throw new ClaudeSwapAdapterError(`claude-swap reported ${type}: ${message}`);
  }
  if (!Array.isArray(raw.accounts)) throw malformed("missing accounts array");
  if (!("activeAccountNumber" in raw)) throw malformed("missing activeAccountNumber");
  const activeAccountNumber =
    raw.activeAccountNumber === null
      ? undefined
      : positiveSlot(raw.activeAccountNumber)
        ? raw.activeAccountNumber
        : (() => {
            throw malformed("activeAccountNumber is not a numeric slot or null");
          })();
  const accounts = raw.accounts.map(parseRow);
  const seen = new Set<number>();
  for (const account of accounts) {
    if (seen.has(account.number)) throw malformed(`duplicate account slot ${account.number}`);
    seen.add(account.number);
  }
  const activeSlots = accounts
    .filter((account) => account.isActive)
    .map((account) => account.number);
  if (
    activeSlots.length !== (activeAccountNumber === undefined ? 0 : 1) ||
    activeSlots[0] !== activeAccountNumber
  )
    throw malformed("active account fields disagree");
  return {
    ...(activeAccountNumber === undefined ? {} : { activeAccountNumber }),
    accounts,
  };
};

/** Strict schema-v1 parser for `cswap --switch-to <slot> --json`. */
export const parseClaudeSwapAccountSwitch = (bytes: Uint8Array): ClaudeSwapAccountSwitchResult => {
  if (bytes.byteLength > CLAUDE_SWAP_MAX_OUTPUT_BYTES)
    throw new ClaudeSwapAdapterError(
      `claude-swap produced ${bytes.byteLength} bytes of output; refusing to parse more than ${CLAUDE_SWAP_MAX_OUTPUT_BYTES}.`,
    );
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new ClaudeSwapAdapterError(
      "claude-swap returned switch output that is not a JSON object.",
    );
  }
  if (!isRecord(raw))
    throw new ClaudeSwapAdapterError(
      "claude-swap returned switch output that is not a JSON object.",
    );
  if (!Number.isSafeInteger(raw.schemaVersion))
    throw new ClaudeSwapAdapterError("claude-swap switch output has no schemaVersion field.");
  if (raw.schemaVersion !== 1)
    throw new ClaudeSwapAdapterError(
      `claude-swap switch output uses unsupported schema version ${raw.schemaVersion}; CodexBar supports version 1.`,
    );
  if (isRecord(raw.error)) {
    const type = typeof raw.error.type === "string" ? raw.error.type : "Error";
    const message = typeof raw.error.message === "string" ? raw.error.message : "unknown error";
    throw new ClaudeSwapAdapterError(`claude-swap reported ${type}: ${message}`);
  }
  if (typeof raw.switched !== "boolean") throw malformed("switch output has no switched flag");
  if (typeof raw.reason !== "string" || raw.reason.trim() === "")
    throw malformed("switch output has no reason");
  const accountNumber = (
    value: unknown,
    field: "from" | "to",
    allowsNull: boolean,
  ): number | undefined => {
    if (value === null && allowsNull) return undefined;
    if (!isRecord(value)) throw malformed(`switch output has no ${field} account`);
    if (value.number === null && allowsNull) return undefined;
    if (!positiveSlot(value.number))
      throw malformed(`switch output ${field} account number is not a positive slot`);
    return value.number;
  };
  const fromAccountNumber = accountNumber(raw.from, "from", true);
  const toAccountNumber = accountNumber(raw.to, "to", false);
  if (toAccountNumber === undefined) throw malformed("switch output has no target account slot");
  return {
    switched: raw.switched,
    ...(fromAccountNumber === undefined ? {} : { fromAccountNumber }),
    toAccountNumber,
    reason: raw.reason.trim(),
  };
};

export const resolveClaudeSwapExecutablePath = (configuredPath: string): string => {
  const trimmed = configuredPath.trim();
  if (trimmed === "")
    throw new ClaudeSwapAdapterError("No claude-swap executable path is configured.");
  return trimmed;
};

/** Runs exactly `cswap --list --json`; the caller can never supply a shell or passthrough arguments. */
export const readClaudeSwapAccountList = (
  processes: ProcessRunnerService,
  configuredPath: string,
  timeoutMs = CLAUDE_SWAP_DEFAULT_TIMEOUT_MS,
): Effect.Effect<ClaudeSwapAccountList, InfrastructureError | ClaudeSwapAdapterError> =>
  Effect.gen(function* () {
    const command = resolveClaudeSwapExecutablePath(configuredPath);
    const result = yield* processes.run({
      command,
      args: ["--list", "--json"],
      timeoutMs,
    });
    // `cswap` intentionally emits a schema-v1 error envelope on stdout with a
    // non-zero exit. Parse stdout regardless of exit status, like Swift.
    return yield* Effect.try({
      try: () => parseClaudeSwapAccountList(result.stdout),
      catch: (cause) =>
        cause instanceof ClaudeSwapAdapterError
          ? cause
          : new ClaudeSwapAdapterError("claude-swap returned output that is not a JSON object."),
    });
  });

export interface ClaudeSwapSwitchRequest {
  readonly processes: ProcessRunnerService;
  readonly files: Pick<PrivateFileStoreService, "remove">;
  readonly executablePath: string;
  /** Source-issued slot from a freshly listed account; no labels or arbitrary arguments are accepted. */
  readonly accountNumber: number;
  /** Clears this private retained usage cache before the irreversible mutation. */
  readonly retentionPath: string;
}

/**
 * Runs exactly `cswap --switch-to <positive-slot> --json`.
 *
 * Once launched, a credential mutation deliberately becomes uninterruptible:
 * aborting a caller must not terminate the helper midway through its own
 * transaction. The preflight cache removal fails closed so no retained usage
 * from the prior active credential can survive a switch attempt.
 */
export const switchClaudeSwapAccount = (
  request: ClaudeSwapSwitchRequest,
): Effect.Effect<ClaudeSwapAccountSwitchResult, InfrastructureError | ClaudeSwapAdapterError> =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      if (!positiveSlot(request.accountNumber))
        return yield* Effect.fail(
          new ClaudeSwapAdapterError("claude-swap switch target must be a positive numeric slot."),
        );
      const command = resolveClaudeSwapExecutablePath(request.executablePath);
      // This is intentionally before launch. A helper may have committed even
      // when it later emits malformed output or exits non-zero.
      yield* request.files.remove(request.retentionPath);
      const result = yield* request.processes.run({
        command,
        args: ["--switch-to", String(request.accountNumber), "--json"],
      });
      const parsed = yield* Effect.try({
        try: () => parseClaudeSwapAccountSwitch(result.stdout),
        catch: (cause) =>
          cause instanceof ClaudeSwapAdapterError
            ? cause
            : new ClaudeSwapAdapterError(
                "claude-swap returned switch output that is not a JSON object.",
              ),
      });
      if (parsed.toAccountNumber !== request.accountNumber)
        return yield* Effect.fail(
          new ClaudeSwapAdapterError(
            `claude-swap reported account slot ${parsed.toAccountNumber} after CodexBar requested slot ${request.accountNumber}.`,
          ),
        );
      return parsed;
    }),
  );

export interface ClaudeSwapRefreshRequest {
  readonly processes: ProcessRunnerService;
  readonly files: Pick<PrivateFileStoreService, "read" | "writeAtomic">;
  readonly executablePath: string;
  /** Private, host-owned cache location; its records never contain emails. */
  readonly retentionPath: string;
  /** Guards config generation/cancellation before any retained data is published. */
  readonly isFresh: () => boolean;
  readonly now?: Date;
  readonly timeoutMs?: number;
}

export type ClaudeSwapRefreshResult =
  | { readonly fresh: false; readonly accounts: readonly [] }
  | { readonly fresh: true; readonly accounts: readonly ClaudeSwapAccountSnapshot[] };

/**
 * Reads the previous private cache only as a fallback for at-limit rows. A
 * successful list is persisted only after the host confirms the request still
 * belongs to the active configuration/generation.
 */
export const refreshClaudeSwapAccounts = (
  request: ClaudeSwapRefreshRequest,
): Effect.Effect<ClaudeSwapRefreshResult, InfrastructureError | ClaudeSwapAdapterError> =>
  Effect.gen(function* () {
    const cached = yield* request.files
      .read(request.retentionPath)
      .pipe(Effect.orElseSucceed(() => undefined));
    const previous =
      cached === undefined || cached.byteLength > CLAUDE_SWAP_MAX_RETAINED_BYTES
        ? []
        : deserializeClaudeSwapRetainedUsage(new TextDecoder("utf-8").decode(cached));
    const list = yield* readClaudeSwapAccountList(
      request.processes,
      request.executablePath,
      request.timeoutMs,
    );
    if (!request.isFresh()) return { fresh: false, accounts: [] };
    const accounts = projectClaudeSwapAccounts(list, {
      ...(request.now === undefined ? {} : { now: request.now }),
      previousAccounts: previous,
    });
    // Repeat the check immediately before the irreversible private write.
    if (!request.isFresh()) return { fresh: false, accounts: [] };
    yield* request.files.writeAtomic(
      request.retentionPath,
      new TextEncoder().encode(serializeClaudeSwapRetainedUsage(accounts)),
    );
    return { fresh: true, accounts };
  });
