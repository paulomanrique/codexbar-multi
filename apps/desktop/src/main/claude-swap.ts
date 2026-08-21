import type { DashboardAccountDTO } from "@codexbar/contracts";
import type {
  PersistedCodexBarConfig,
  PrivateFileStoreService,
  ProcessRunnerService,
} from "@codexbar/core";
import { refreshClaudeSwapAccounts, switchClaudeSwapAccount } from "@codexbar/platform";
import { resolveNodeClaudeSwapExecutablePath } from "@codexbar/platform/node";
import { CLAUDE_SWAP_SOURCE, type ClaudeSwapAccountSnapshot } from "@codexbar/providers";
import { Effect } from "effect";

export type DesktopClaudeSwapSettings = {
  readonly enabled: boolean;
  readonly executablePath: string;
};

const configuredString = (value: unknown): string => {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  )
    return trimmed.slice(1, -1).trim();
  return trimmed;
};

/** Claude Swap remains disabled unless both the provider and its explicit extension opt-in are enabled. */
export const desktopClaudeSwapSettings = (
  config: PersistedCodexBarConfig | undefined,
): DesktopClaudeSwapSettings => {
  const claude = config?.providers.find((provider) => provider.id === "claude");
  const configuredPath = configuredString(claude?.extensions.claudeSwapExecutablePath);
  return {
    enabled: claude?.enabled === true && claude.extensions.claudeSwapEnabled === true,
    executablePath:
      configuredPath === "" ? "" : resolveNodeClaudeSwapExecutablePath(configuredPath),
  };
};

const sameSettings = (left: DesktopClaudeSwapSettings, right: DesktopClaudeSwapSettings): boolean =>
  left.enabled === right.enabled && left.executablePath === right.executablePath;

const accountWindows = (
  snapshot: NonNullable<ClaudeSwapAccountSnapshot["snapshot"]>,
): DashboardAccountDTO["windows"] => {
  const standard = [
    ["primary", "Primary", snapshot.primary],
    ["secondary", "Secondary", snapshot.secondary],
    ["tertiary", "Tertiary", snapshot.tertiary],
  ] as const;
  return [
    ...standard.flatMap(([kind, label, window]) =>
      window === undefined
        ? []
        : [
            {
              kind,
              label,
              usedPercent: window.usedPercent,
              remainingPercent: Math.max(0, 100 - window.usedPercent),
              ...(window.resetsAt === undefined ? {} : { resetAt: window.resetsAt }),
            },
          ],
    ),
    ...(snapshot.extraRateWindows ?? []).map(({ id, title, window }) => ({
      kind: id,
      label: title,
      usedPercent: window.usedPercent,
      remainingPercent: Math.max(0, 100 - window.usedPercent),
      ...(window.resetsAt === undefined ? {} : { resetAt: window.resetsAt }),
    })),
  ];
};

/** Safe dashboard-only projection. Source errors are intentionally not relayed across IPC. */
export const desktopClaudeSwapAccounts = (
  accounts: readonly ClaudeSwapAccountSnapshot[],
): readonly DashboardAccountDTO[] =>
  accounts.map((account) => ({
    id: account.id.opaqueId,
    label: account.displayLabel,
    active: account.isActive,
    canActivate: account.canActivate,
    ...(account.snapshot?.identity === undefined ? {} : { identity: account.snapshot.identity }),
    windows: account.snapshot === undefined ? [] : accountWindows(account.snapshot),
    ...(account.snapshot?.updatedAt === undefined ? {} : { updatedAt: account.snapshot.updatedAt }),
  }));

class SerializedOperations {
  #tail: Promise<void> = Promise.resolve();

  run<Value>(operation: () => Promise<Value>): Promise<Value> {
    const next = this.#tail.then(operation, operation);
    this.#tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

export interface DesktopClaudeSwapControllerOptions {
  readonly config: () => PersistedCodexBarConfig | undefined;
  readonly processes: ProcessRunnerService;
  readonly files: PrivateFileStoreService;
  /** Private host-owned location. This path must never cross the renderer bridge. */
  readonly retentionPath: string;
}

/**
 * Desktop-only transaction boundary. It serializes list/switch/reconcile work
 * so a renderer request cannot overlap two external credential transactions.
 */
export class DesktopClaudeSwapController {
  readonly #config: () => PersistedCodexBarConfig | undefined;
  readonly #processes: ProcessRunnerService;
  readonly #files: PrivateFileStoreService;
  readonly #retentionPath: string;
  readonly #operations = new SerializedOperations();

  constructor(options: DesktopClaudeSwapControllerOptions) {
    this.#config = options.config;
    this.#processes = options.processes;
    this.#files = options.files;
    this.#retentionPath = options.retentionPath;
  }

  /** Failed read-only refreshes are intentionally represented as no account cards, not helper diagnostics. */
  refreshForOverview(): Promise<readonly DashboardAccountDTO[] | undefined> {
    return this.#operations.run(async () => {
      try {
        return desktopClaudeSwapAccounts(await this.#refreshCurrent());
      } catch {
        return undefined;
      }
    });
  }

  activate(accountId: string): Promise<{ readonly accountId: string; readonly switched: boolean }> {
    return this.#operations.run(async () => {
      const settings = this.#requireSettings();
      // Fresh host-issued list, never a renderer-supplied slot, authorizes the mutation.
      const accounts = await this.#refresh(settings);
      const account = accounts.find(
        (candidate) =>
          candidate.id.source === CLAUDE_SWAP_SOURCE && candidate.id.opaqueId === accountId,
      );
      if (account === undefined || !account.canActivate)
        throw new Error("Claude Swap account activation is not available.");
      // The listing performs its own freshness check, but configuration may
      // still change as that async operation hands control back to this
      // mutation. Recheck synchronously immediately before launching the
      // uninterruptible external credential transaction.
      if (!sameSettings(settings, desktopClaudeSwapSettings(this.#config())))
        throw new Error("Claude Swap settings changed before account activation.");
      const slot = this.#slotFor(account);
      const result = await Effect.runPromise(
        switchClaudeSwapAccount({
          processes: this.#processes,
          files: this.#files,
          executablePath: settings.executablePath,
          accountNumber: slot,
          retentionPath: this.#retentionPath,
        }),
      );
      if (!result.switched) throw new Error("Claude Swap account activation did not complete.");
      const refreshed = await this.#refresh(settings);
      if (!refreshed.some((candidate) => candidate.id.opaqueId === accountId && candidate.isActive))
        throw new Error("Claude Swap account activation could not be verified.");
      return { accountId, switched: result.switched };
    });
  }

  #requireSettings(): DesktopClaudeSwapSettings {
    const settings = desktopClaudeSwapSettings(this.#config());
    if (!settings.enabled || settings.executablePath === "")
      throw new Error("Claude Swap account activation is not enabled.");
    return settings;
  }

  #refreshCurrent(): Promise<readonly ClaudeSwapAccountSnapshot[]> {
    return this.#refresh(this.#requireSettings());
  }

  #refresh(settings: DesktopClaudeSwapSettings): Promise<readonly ClaudeSwapAccountSnapshot[]> {
    return Effect.runPromise(
      refreshClaudeSwapAccounts({
        processes: this.#processes,
        files: this.#files,
        executablePath: settings.executablePath,
        retentionPath: this.#retentionPath,
        isFresh: () => sameSettings(settings, desktopClaudeSwapSettings(this.#config())),
      }).pipe(
        Effect.flatMap((result) =>
          result.fresh
            ? Effect.succeed(result.accounts)
            : Effect.fail(new Error("Claude Swap settings changed during refresh.")),
        ),
      ),
    );
  }

  #slotFor(account: ClaudeSwapAccountSnapshot): number {
    if (account.id.source !== CLAUDE_SWAP_SOURCE || !/^[1-9][0-9]*$/u.test(account.id.opaqueId))
      throw new Error("Claude Swap account activation is not available.");
    const slot = Number(account.id.opaqueId);
    if (!Number.isSafeInteger(slot))
      throw new Error("Claude Swap account activation is not available.");
    return slot;
  }
}
