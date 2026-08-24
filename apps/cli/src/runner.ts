import { Effect } from "effect";
import { dirname, join } from "node:path";
import {
  ClassifiedFetchFailure,
  InfrastructureError,
  NoAvailableStrategy,
  PlanUtilizationHistoryCoordinator,
  type ProviderFetchContext,
  type ProviderFetchOutcome,
  type ProviderRuntimeService,
  recordFirstPartyPlanUtilization,
} from "@codexbar/core";
import type { ProviderId, UsageSnapshot } from "@codexbar/contracts";
import { serializeUsageSnapshot } from "@codexbar/contracts";
import { FIRST_PARTY_PROVIDERS, PROVIDERS } from "@codexbar/providers";
import {
  makeCredentialBrowserSessions,
  makeFetchHttpTransport,
  makeNodeDiscoveredProviderSettings,
  makeFirstPartyProviderRuntime,
  makeNativeCredentialStore,
  makeNodeFirstPartyLocalCapabilities,
  makeNodeLocalCostUsageScanner,
  makeNodeProcessRunner,
  makeNodePrivateFileStore,
  resolveNodeClaudeOAuthHistoryOwner,
  resolveNodeClaudeSwapExecutablePath,
  makeNodeConfigRepository,
  makeNodeSqlitePersistence,
  makeSystemClock,
  inspectNodeLegacyImport,
  executeNodeLegacyImport,
  rollbackNodeLegacyImport,
  type NodeLegacyImportOptions,
  type NodeSqlitePersistence,
} from "@codexbar/platform/node";
import {
  makeClaudeOAuthHistoryOwnerCapture,
  selectedFirstPartyAccountFromConfig,
} from "@codexbar/platform";
import {
  CLAUDE_SWAP_MAX_OUTPUT_BYTES,
  makeNodeAgentSessionRuntime,
  makeNodePlanUtilizationHistoryStore,
  refreshClaudeSwapAccounts,
  switchClaudeSwapAccount,
} from "@codexbar/platform";
import { makeNodeCLIConfigStore, runConfig, type CLIConfigStore } from "./config.ts";
import { resolveCLIConfigPath } from "./config-path.ts";
import { runCost, type CLICostScanner, type CLICostStore } from "./cost.ts";
import { runCards } from "./cards.ts";
import {
  claudeSwapActivatableSlot,
  claudeSwapProcessEnvironment,
  type CLIClaudeSwapAdapter,
} from "./claude-swap.ts";
import { runCache, type CLICacheStore } from "./cache.ts";
import { runDashboard } from "./dashboard.ts";
import { runDiagnose } from "./diagnose.ts";
import { runGuard } from "./guard.ts";
import { runHooks, type HookProcessRequest } from "./hooks.ts";
import { runSessions, runSessionsFocus, type AgentSession } from "./sessions.ts";
import { runCookie, type CLICookieStore } from "./cookie.ts";
import { runPlugins, type CLIPluginStore } from "./plugins.ts";
import { NodeCLIPluginStore, pluginSecretKey } from "./node-plugin-store.ts";
import {
  decodePluginBrowserCredential,
  pluginBrowserCredentialKey,
} from "./plugin-browser-session.ts";
import { runServe } from "./serve.ts";
import { runLegacyImport, type CLILegacyImportStore } from "./legacy-import.ts";
import { encodeToon, type ToonValue } from "./toon.ts";

/** Values intentionally match the upstream CLIExitCode.swift numeric contract. */
export const CLIExitCode = {
  success: 0,
  failure: 1,
  binaryNotFound: 2,
  parseError: 3,
  timeout: 4,
  usage: 64,
  unavailable: 69,
} as const;
export type CLIExitCode = (typeof CLIExitCode)[keyof typeof CLIExitCode];

export type CLIErrorKind = "args" | "config" | "provider" | "runtime";
export type CLIOutputFormat = "text" | "json" | "toon";

export interface CLIIO {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  /** Secret material is accepted only from a non-interactive host input channel. */
  readonly readSecret?: () => Promise<string | undefined>;
}

/** Bounded stdin-only secret reader. Terminal sessions fail closed by design. */
export const readNonInteractiveSecret = async (
  input: AsyncIterable<Uint8Array | string>,
  isTTY: boolean | undefined,
): Promise<string | undefined> => {
  if (isTTY === true) return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of input) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > 64 * 1024) return undefined;
      chunks.push(bytes);
    }
    let value = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    while (value.endsWith("\n") || value.endsWith("\r")) value = value.slice(0, -1);
    return value === "" ? undefined : value;
  } catch {
    return undefined;
  }
};

export interface CLIProviderDescriptor {
  readonly id: ProviderId;
  readonly name: string;
  readonly status: "partial" | "unported";
  readonly isPrimaryProvider?: boolean;
}

export interface CLIProviderRuntime {
  readonly providers: readonly CLIProviderDescriptor[];
  readonly fetch: (
    providerId: ProviderId,
    context: ProviderFetchContext,
    signal?: AbortSignal,
  ) => Promise<ProviderFetchOutcome>;
  /** Best-effort host persistence for provider plan-utilization samples. */
  readonly recordPlanUtilization?: (
    providerId: ProviderId,
    outcome: ProviderFetchOutcome,
    signal?: AbortSignal,
  ) => Promise<void>;
  /** Optional in-memory/host-injected configuration store used by `config`. */
  readonly config?: CLIConfigStore;
  readonly costs?: CLICostStore;
  readonly costScanner?: CLICostScanner;
  readonly cache?: CLICacheStore;
  readonly runHook?: (request: HookProcessRequest) => Promise<{ readonly stdout: string }>;
  readonly scanSessions?: (signal: AbortSignal) => Promise<readonly AgentSession[]>;
  readonly focusSession?: (
    session: AgentSession,
    signal: AbortSignal,
  ) => Promise<"focused" | "activated" | "failed">;
  readonly cookies?: CLICookieStore;
  readonly plugins?: CLIPluginStore;
  /** Opt-in Claude multi-account adapter; it remains a host-owned subprocess capability. */
  readonly claudeSwap?: CLIClaudeSwapAdapter;
  /** Explicit, user-selected legacy import adapter; it never discovers sources. */
  readonly legacyImport?: CLILegacyImportStore;
  /** Optional host lifecycle cleanup; the renderer never receives this capability. */
  readonly dispose?: () => void | Promise<void>;
  readonly now?: () => number;
}

export interface CLICommandRunnerOptions {
  readonly argv: readonly string[];
  readonly io: CLIIO;
  readonly runtime: CLIProviderRuntime;
  /** Node entrypoints inject SIGINT/SIGTERM here; embedded callers own their signal. */
  readonly signal?: AbortSignal;
}

export interface CLICommandResult {
  readonly exitCode: CLIExitCode;
}

type ProviderPayload = {
  readonly provider: string;
  readonly account?: string;
  readonly version?: string;
  readonly source: string;
  readonly usage?: ReturnType<typeof serializeUsageSnapshot>;
  readonly error?: {
    readonly code: CLIExitCode;
    readonly message: string;
    readonly kind: CLIErrorKind;
  };
};

type OutputPreferences = {
  readonly format: CLIOutputFormat;
  readonly jsonOnly: boolean;
  readonly pretty: boolean;
};

export interface ParsedCLIArguments {
  readonly output: OutputPreferences;
  readonly provider: string | undefined;
  readonly positional: readonly string[];
}

export type CLIArgumentParseResult =
  | { readonly ok: true; readonly value: ParsedCLIArguments }
  | { readonly ok: false; readonly message: string };

const usageFlags = new Set(["--json", "--json-only", "--pretty"]);

/**
 * Parse the small argument surface currently implemented by the TypeScript
 * CLI.  Keeping this strict is important: Commander (the Swift oracle)
 * rejects unknown flags, missing option values, and invalid enum values with
 * the usage exit code instead of silently selecting a default.
 */
export const parseCLIArguments = (
  arguments_: readonly string[],
  allowsToon: boolean,
): CLIArgumentParseResult => {
  const positional: string[] = [];
  let provider: string | undefined;
  let providerSeen = false;
  let format: string | undefined;
  let formatSeen = false;
  let jsonOnly = false;
  let jsonShortcut = false;
  let pretty = false;

  const missingValue = (name: string): CLIArgumentParseResult => ({
    ok: false,
    message: `Missing value for ${name}`,
  });
  const duplicateOption = (name: string): CLIArgumentParseResult => ({
    ok: false,
    message: `Option ${name} may only be specified once`,
  });

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === undefined) continue;
    if (!argument.startsWith("-")) {
      positional.push(argument);
      continue;
    }

    if (usageFlags.has(argument)) {
      if (argument === "--json") jsonShortcut = true;
      if (argument === "--json-only") {
        jsonShortcut = true;
        jsonOnly = true;
      }
      if (argument === "--pretty") pretty = true;
      continue;
    }

    if (argument === "--provider" || argument.startsWith("--provider=")) {
      if (providerSeen) return duplicateOption("--provider");
      providerSeen = true;
      const value =
        argument === "--provider" ? arguments_[index + 1] : argument.slice("--provider=".length);
      if (value === undefined || value === "" || value.startsWith("-"))
        return missingValue("--provider");
      provider = value;
      if (argument === "--provider") index += 1;
      continue;
    }

    if (argument === "--format" || argument.startsWith("--format=")) {
      if (formatSeen) return duplicateOption("--format");
      formatSeen = true;
      const value =
        argument === "--format" ? arguments_[index + 1] : argument.slice("--format=".length);
      if (value === undefined || value === "" || value.startsWith("-"))
        return missingValue("--format");
      const normalized = value.toLowerCase();
      const valid =
        normalized === "text" || normalized === "json" || (allowsToon && normalized === "toon");
      if (!valid) {
        return {
          ok: false,
          message: `Invalid value '${value}' for --format (expected ${allowsToon ? "text, json, or toon" : "text or json"})`,
        };
      }
      format = normalized;
      if (argument === "--format") index += 1;
      continue;
    }

    return { ok: false, message: `Unknown option ${argument}` };
  }

  const selectedFormat = format ?? (jsonShortcut ? "json" : "text");
  return {
    ok: true,
    value: {
      output: {
        format: selectedFormat as CLIOutputFormat,
        jsonOnly,
        pretty,
      },
      provider,
      positional,
    },
  };
};

const outputFor = (arguments_: readonly string[], allowsToon: boolean): OutputPreferences => {
  let explicitFormat: string | undefined;
  let jsonShortcut = false;
  let jsonOnly = false;
  let pretty = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === undefined) continue;
    if (argument === "--json" || argument === "--json-only") {
      jsonShortcut = true;
      jsonOnly ||= argument === "--json-only";
    } else if (argument === "--pretty") {
      pretty = true;
    } else if (argument === "--format") {
      const next = arguments_[index + 1];
      if (next !== undefined) {
        explicitFormat = next;
        index += 1;
      }
    } else if (argument.startsWith("--format=") && argument.length > "--format=".length) {
      explicitFormat = argument.slice("--format=".length);
    }
  }
  const selected = explicitFormat?.toLowerCase();
  const format: CLIOutputFormat =
    allowsToon && selected === "toon"
      ? "toon"
      : selected === "json"
        ? "json"
        : selected === "text"
          ? "text"
          : jsonShortcut
            ? "json"
            : "text";
  return { format, jsonOnly, pretty };
};

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

type ClassifiedCLIError = {
  readonly code: CLIExitCode;
  readonly kind: string;
  readonly message: string;
};

const codeForFailureKind = (kind: string): CLIExitCode => {
  switch (kind) {
    case "binary-not-found":
    case "binaryNotFound":
      return CLIExitCode.binaryNotFound;
    case "parse-failure":
    case "parse-error":
    case "parseError":
      return CLIExitCode.parseError;
    case "timeout":
    case "timed-out":
    case "timeout-error":
      return CLIExitCode.timeout;
    default:
      return CLIExitCode.failure;
  }
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;

const errorText = (error: unknown): string => {
  const root = record(error);
  const cause = root?.cause;
  const causeRecord = record(cause);
  return [
    message(error),
    typeof root?.name === "string" ? root.name : "",
    typeof root?.operation === "string" ? root.operation : "",
    typeof root?.code === "string" ? root.code : "",
    typeof causeRecord?.message === "string" ? causeRecord.message : "",
    typeof causeRecord?.code === "string" ? causeRecord.code : "",
  ]
    .join(" ")
    .toLowerCase();
};

const classify = (error: unknown): ClassifiedCLIError => {
  if (error instanceof ClassifiedFetchFailure)
    return { code: codeForFailureKind(error.kind), kind: error.kind, message: error.message };
  if (error instanceof NoAvailableStrategy)
    return { code: CLIExitCode.failure, kind: "provider-unavailable", message: error.message };

  const root = record(error);
  const classified = record(root?.classified);
  const classifiedKind =
    typeof classified?.kind === "string"
      ? classified.kind
      : typeof root?.kind === "string"
        ? root.kind
        : undefined;
  if (classifiedKind !== undefined) {
    return {
      code: codeForFailureKind(classifiedKind),
      kind: classifiedKind,
      message:
        typeof classified?.message === "string"
          ? classified.message
          : typeof root?.message === "string"
            ? root.message
            : message(error),
    };
  }

  // Process and provider adapters may expose a conventional numeric exit
  // code or an ENOENT/timeout marker without using ClassifiedFetchFailure.
  const rawCode = root?.code;
  if (typeof rawCode === "number" && [1, 2, 3, 4, 64].includes(rawCode))
    return { code: rawCode as CLIExitCode, kind: "runtime", message: message(error) };
  const text = errorText(error);
  if (/enoent|binary.?not.?found|executable.+not found|command.+not found/.test(text))
    return { code: CLIExitCode.binaryNotFound, kind: "runtime", message: message(error) };
  if (/timed? ?out|timeout|etimedout|deadline exceeded/.test(text))
    return { code: CLIExitCode.timeout, kind: "runtime", message: message(error) };
  if (/parse error|parse failure|failed to parse|invalid json|malformed/.test(text))
    return { code: CLIExitCode.parseError, kind: "runtime", message: message(error) };
  if (error instanceof InfrastructureError)
    return { code: CLIExitCode.failure, kind: "network-failure", message: error.message };
  return { code: CLIExitCode.failure, kind: "api-failure", message: message(error) };
};

const textUsage = (
  descriptor: CLIProviderDescriptor,
  source: string,
  snapshot: UsageSnapshot,
): string => {
  const lines = [`${descriptor.name} (${source})`];
  const window = (label: string, value: UsageSnapshot["primary"]): void => {
    if (value === undefined) return;
    const reset = value.resetsAt === undefined ? "" : `, resets ${value.resetsAt}`;
    lines.push(`${label}: ${value.usedPercent}%${reset}`);
  };
  window("Primary", snapshot.primary);
  window("Secondary", snapshot.secondary);
  window("Tertiary", snapshot.tertiary);
  if (snapshot.providerCost !== undefined)
    lines.push(
      `Cost: ${snapshot.providerCost.used} ${snapshot.providerCost.currencyCode} of ${snapshot.providerCost.limit}`,
    );
  for (const section of snapshot.details) {
    if (section.title !== undefined) lines.push(section.title);
    for (const row of section.rows)
      lines.push(
        `${row.label}: ${row.value}${row.secondaryValue === undefined ? "" : ` ${row.secondaryValue}`}`,
      );
  }
  return lines.join("\n");
};

const emitPayloads = (
  io: CLIIO,
  output: OutputPreferences,
  payload: readonly ProviderPayload[],
  text: readonly string[],
): void => {
  if (output.format === "toon") {
    io.stdout(encodeToon(payload as unknown as ToonValue));
    return;
  }
  if (output.format === "json") {
    io.stdout(JSON.stringify(payload, undefined, output.pretty ? 2 : undefined));
    return;
  }
  if (!output.jsonOnly && text.length > 0) io.stdout(text.join("\n\n"));
};

const resolveProviders = (
  parsed: ParsedCLIArguments,
  runtime: CLIProviderRuntime,
): { readonly ids: readonly ProviderId[] } | { readonly error: string } => {
  const fromFlag = parsed.provider;
  const names = parsed.positional;
  const positionalProvider = names[0];
  if (names.length > 1) return { error: "usage accepts at most one provider" };
  if (fromFlag !== undefined && positionalProvider !== undefined)
    return { error: "provider must be supplied either positionally or with --provider" };
  const selected = fromFlag ?? positionalProvider ?? "all";
  if (selected === "all") return { ids: runtime.providers.map((provider) => provider.id) };
  if (selected === "both") {
    const primary = runtime.providers.filter((provider) => provider.isPrimaryProvider === true);
    return {
      ids: (primary.length > 0 ? primary : runtime.providers.slice(0, 2)).map(
        (provider) => provider.id,
      ),
    };
  }
  const normalized = selected.toLowerCase();
  const provider = runtime.providers.find((candidate) => candidate.id === normalized);
  return provider === undefined
    ? { error: `Unknown provider: ${selected}` }
    : { ids: [provider.id] };
};

const isError = <T extends object>(
  value: T | { readonly error: string },
): value is { readonly error: string } => "error" in value;

const usageHelp =
  "Usage: codexbar-multi [usage] [provider] [--provider <id|all>] [--format text|json|toon] [--json] [--json-only] [--pretty]\nCommands: usage, providers, cost, cards, dashboard, diagnose, cache, guard, hooks, cookie, plugins, sessions, config, legacy-import, serve";

const usageFailure = (io: CLIIO, output: OutputPreferences, error: string): CLICommandResult => {
  if (output.format === "text" && !output.jsonOnly) io.stderr(`Error: ${error}`);
  else
    emitPayloads(
      io,
      output,
      [
        {
          provider: "cli",
          source: "cli",
          error: { code: CLIExitCode.usage, message: error, kind: "args" },
        },
      ],
      [],
    );
  return { exitCode: CLIExitCode.usage };
};

const runProviders = (
  arguments_: readonly string[],
  io: CLIIO,
  runtime: CLIProviderRuntime,
): CLICommandResult => {
  const parsed = parseCLIArguments(arguments_, false);
  const output = outputFor(arguments_, false);
  if (!parsed.ok) return usageFailure(io, output, parsed.message);
  if (parsed.value.provider !== undefined || parsed.value.positional.length > 0)
    return usageFailure(io, output, "providers does not accept a provider selection");
  const rows = runtime.providers.map(({ id, name, status }) => ({ id, name, status }));
  if (output.format === "json")
    io.stdout(JSON.stringify(rows, undefined, output.pretty ? 2 : undefined));
  else io.stdout(rows.map((row) => `${row.id}\t${row.status}\t${row.name}`).join("\n"));
  return { exitCode: CLIExitCode.success };
};

const runUsage = async (
  arguments_: readonly string[],
  io: CLIIO,
  runtime: CLIProviderRuntime,
  signal?: AbortSignal,
): Promise<CLICommandResult> => {
  const parsed = parseCLIArguments(arguments_, true);
  const output = outputFor(arguments_, true);
  if (!parsed.ok) return usageFailure(io, output, parsed.message);
  const selection = resolveProviders(parsed.value, runtime);
  if (isError(selection)) {
    return usageFailure(io, output, selection.error);
  }
  const byId = new Map(runtime.providers.map((provider) => [provider.id, provider]));
  const payload: ProviderPayload[] = [];
  const text: string[] = [];
  let exitCode: CLIExitCode = CLIExitCode.success;
  for (const providerId of selection.ids) {
    const descriptor = byId.get(providerId);
    if (descriptor === undefined) continue;
    if (descriptor.status !== "partial") {
      const failure = `Provider '${providerId}' is mapped but not ported yet`;
      payload.push({
        provider: providerId,
        source: "auto",
        error: { code: CLIExitCode.failure, message: failure, kind: "provider" },
      });
      if (output.format === "text" && !output.jsonOnly) io.stderr(`Error: ${failure}`);
      exitCode = CLIExitCode.failure;
      continue;
    }
    try {
      const outcome = await runtime.fetch(
        providerId,
        { sourceMode: "auto", includeCredits: true },
        signal,
      );
      await runtime.recordPlanUtilization?.(providerId, outcome, signal).catch(() => {
        // The CLI usage result is already complete. History remains best
        // effort and cannot replace it with a storage error.
      });
      payload.push({
        provider: providerId,
        source: outcome.source,
        usage: serializeUsageSnapshot(outcome.snapshot),
      });
      text.push(textUsage(descriptor, outcome.source, outcome.snapshot));
    } catch (error) {
      const failure = classify(error);
      payload.push({
        provider: providerId,
        source: "auto",
        error: { code: failure.code, message: failure.message, kind: "provider" },
      });
      if (output.format === "text" && !output.jsonOnly) io.stderr(`Error: ${failure.message}`);
      exitCode = failure.code;
    }
  }
  emitPayloads(io, output, payload, text);
  return { exitCode };
};

/** Injectable command runner: tests and embedding hosts never need process/global credentials. */
export const runCLI = async (options: CLICommandRunnerOptions): Promise<CLICommandResult> => {
  const raw = [...options.argv];
  const command = raw[0];
  if ((command === "--help" || command === "-h" || command === "help") && raw.length === 1) {
    options.io.stdout(usageHelp);
    return { exitCode: CLIExitCode.success };
  }
  if (command === undefined || command.startsWith("-"))
    return runUsage(raw, options.io, options.runtime, options.signal);
  if (command === "usage")
    return runUsage(raw.slice(1), options.io, options.runtime, options.signal);
  if (command === "providers") return runProviders(raw.slice(1), options.io, options.runtime);
  if (command === "cost")
    return runCost(
      raw.slice(1),
      options.io,
      options.runtime.costs === undefined
        ? undefined
        : {
            costs: options.runtime.costs,
            providers: options.runtime.providers,
            ...(options.runtime.costScanner === undefined
              ? {}
              : { scanner: options.runtime.costScanner }),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            ...(options.runtime.now === undefined ? {} : { now: options.runtime.now }),
          },
    );
  if (command === "cards") return runCards(raw.slice(1), options.io, options.runtime);
  if (command === "dashboard") return runDashboard(raw.slice(1), options.io, options.runtime);
  if (command === "diagnose") return runDiagnose(raw.slice(1), options.io, options.runtime);
  if (command === "cache") return runCache(raw.slice(1), options.io, options.runtime);
  if (command === "guard") return runGuard(raw.slice(1), options.io, options.runtime);
  if (command === "hooks") return runHooks(raw.slice(1), options.io, options.runtime);
  if (command === "cookie") return runCookie(raw.slice(1), options.io, options.runtime);
  if (command === "plugins") return runPlugins(raw.slice(1), options.io, options.runtime);
  if (command === "legacy-import")
    return runLegacyImport(raw.slice(1), options.io, options.runtime.legacyImport);
  if (command === "serve") return runServe(raw.slice(1), options.io, options.runtime);
  if (command === "sessions") {
    const sessionArgs = raw.slice(1);
    if (sessionArgs[0] === "focus")
      return runSessionsFocus(sessionArgs.slice(1), options.io, options.runtime);
    const listArgs = sessionArgs[0] === "list" ? sessionArgs.slice(1) : sessionArgs;
    return runSessions(listArgs, options.io, options.runtime);
  }
  if (command === "config")
    return runConfig(
      raw.slice(1),
      options.io,
      options.runtime.config === undefined
        ? undefined
        : {
            config: options.runtime.config,
            providers: options.runtime.providers,
          },
    );
  if (
    command === "all" ||
    command === "both" ||
    options.runtime.providers.some((provider) => provider.id === command.toLowerCase())
  ) {
    return runUsage(raw, options.io, options.runtime, options.signal);
  }
  options.io.stderr(`Error: Unknown command '${command}'\n${usageHelp}`);
  return { exitCode: CLIExitCode.usage };
};

/**
 * Node composition root. This is the sole CLI path that owns HTTP, keyring,
 * environment and browser-session adapters; provider modules see only the
 * small shared host surface.
 */
export const makeNodeCLIProviderRuntime = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): CLIProviderRuntime => {
  const configPath = resolveCLIConfigPath(environment);
  const configRepository = makeNodeConfigRepository(configPath);
  const databasePath = join(dirname(configPath), "usage.sqlite");
  const planUtilizationHistory = new PlanUtilizationHistoryCoordinator(
    makeNodePlanUtilizationHistoryStore({
      directoryPath: join(dirname(configPath), "history"),
    }),
  );
  let costPersistencePromise: Promise<NodeSqlitePersistence> | undefined;
  const credentials = makeNativeCredentialStore();
  const claudeOAuthHistoryOwners = makeClaudeOAuthHistoryOwnerCapture({
    resolveOwner: (signal) =>
      Effect.runPromise(
        resolveNodeClaudeOAuthHistoryOwner({ credentialStore: credentials, environment }),
        signal === undefined ? {} : { signal },
      ),
  });
  const hookEnvironment = Object.fromEntries(
    [
      "PATH",
      "HOME",
      "USER",
      "LOGNAME",
      "SHELL",
      "LANG",
      "LC_ALL",
      "LC_CTYPE",
      "TERM",
      "TMPDIR",
    ].flatMap((key) =>
      environment[key] === undefined ? [] : ([[key, environment[key]]] as const),
    ),
  );
  const hookProcessRunner = makeNodeProcessRunner({ environment: hookEnvironment });
  const claudeSwapProcessRunner = makeNodeProcessRunner({
    environment: claudeSwapProcessEnvironment(environment),
    maximumOutputBytes: CLAUDE_SWAP_MAX_OUTPUT_BYTES,
  });
  const claudeSwapFiles = makeNodePrivateFileStore();
  const claudeSwapRetentionPath = join(dirname(configPath), "claude-swap-retained-usage.json");
  const agentSessions = makeNodeAgentSessionRuntime(environment);
  const runtime: ProviderRuntimeService = makeFirstPartyProviderRuntime({
    providers: FIRST_PARTY_PROVIDERS,
    http: makeFetchHttpTransport(),
    credentials,
    clock: makeSystemClock(),
    browserSessions: makeCredentialBrowserSessions(credentials),
    selectedAccounts: {
      resolve: (providerId) =>
        Effect.map(configRepository.load, (config) =>
          selectedFirstPartyAccountFromConfig(config, providerId),
        ),
    },
    local: makeNodeFirstPartyLocalCapabilities({
      environment,
      ...(environment.ANTIGRAVITY_CLI_PATH?.trim()
        ? { antigravityExternalCLIPath: environment.ANTIGRAVITY_CLI_PATH.trim() }
        : {}),
    }),
    settings: makeNodeDiscoveredProviderSettings({ environment }),
  });
  // Both the normal Node CLI and SEA use the same disposable QuickJS child.
  // The SEA bootstrap extracts a digest-bound ESM child asset before forking
  // the executable back into its private sandbox mode.
  const plugins = new NodeCLIPluginStore({
    storageRoot: dirname(configPath),
    reservedIds: new Set(PROVIDERS.map(({ id }) => id)),
    readSecret: (pluginId, key) =>
      Effect.runPromise(credentials.read(pluginSecretKey(pluginId, key))),
    writeSecret: (pluginId, key, value) =>
      Effect.runPromise(credentials.write(pluginSecretKey(pluginId, key), value)),
    removeSecret: (pluginId, key) =>
      Effect.runPromise(credentials.remove(pluginSecretKey(pluginId, key))),
    readBrowserCookie: async (pluginId, domain) => {
      const raw = await Effect.runPromise(
        credentials.read(pluginBrowserCredentialKey(pluginId, domain)),
      );
      return raw === undefined ? undefined : decodePluginBrowserCredential(raw, pluginId, domain);
    },
    removeBrowserCookie: (pluginId, domain) =>
      Effect.runPromise(credentials.remove(pluginBrowserCredentialKey(pluginId, domain))),
  });
  const claudeSwap: CLIClaudeSwapAdapter = {
    list: async ({ executablePath, signal }) => {
      const result = await Effect.runPromise(
        refreshClaudeSwapAccounts({
          processes: claudeSwapProcessRunner,
          files: claudeSwapFiles,
          executablePath: resolveNodeClaudeSwapExecutablePath(executablePath),
          retentionPath: claudeSwapRetentionPath,
          // The CLI has no mutable settings generation; cancellation is its
          // freshness boundary and prevents stale cache publication.
          isFresh: () => signal?.aborted !== true,
        }),
        signal === undefined ? {} : { signal },
      );
      return result.accounts;
    },
    activate: async ({ executablePath, account }) =>
      Effect.runPromise(
        switchClaudeSwapAccount({
          processes: claudeSwapProcessRunner,
          files: claudeSwapFiles,
          executablePath: resolveNodeClaudeSwapExecutablePath(executablePath),
          accountNumber: claudeSwapActivatableSlot(account),
          retentionPath: claudeSwapRetentionPath,
        }),
      ),
  };
  const costStore: CLICostStore = {
    list: async (providerId, since, limit) => {
      costPersistencePromise ??= Effect.runPromise(makeNodeSqlitePersistence({ databasePath }));
      const persistence = await costPersistencePromise;
      return Effect.runPromise(persistence.costs.list(providerId, since, limit));
    },
  };
  const costScanner: CLICostScanner = {
    refresh: async (providerId, signal) => {
      costPersistencePromise ??= Effect.runPromise(makeNodeSqlitePersistence({ databasePath }));
      const persistence = await costPersistencePromise;
      return makeNodeLocalCostUsageScanner({
        costs: persistence.costs,
        environment,
      }).refresh(providerId, signal);
    },
  };
  return {
    providers: PROVIDERS.map(({ id, name, status, isPrimaryProvider }) => ({
      id,
      name,
      status,
      ...(isPrimaryProvider === true ? { isPrimaryProvider: true } : {}),
    })),
    fetch: (providerId, context, signal) =>
      claudeOAuthHistoryOwners.captureFetch(
        providerId,
        () =>
          Effect.runPromise(
            runtime.fetch(providerId, context),
            signal === undefined ? {} : { signal },
          ),
        signal,
      ),
    recordPlanUtilization: async (providerId, outcome, signal) => {
      const claudeOAuthHistoryOwnerIdentifier = await claudeOAuthHistoryOwners.consume(
        providerId,
        outcome,
        signal,
      );
      await Effect.runPromise(
        recordFirstPartyPlanUtilization({
          coordinator: planUtilizationHistory,
          providerId,
          snapshot: outcome.snapshot,
          capturedAt: new Date(),
          strategyId: outcome.strategyId,
          ...(claudeOAuthHistoryOwnerIdentifier === undefined
            ? {}
            : { claudeOAuthHistoryOwnerIdentifier }),
        }),
        signal === undefined ? {} : { signal },
      );
    },
    config: makeNodeCLIConfigStore(configRepository, configPath),
    costs: costStore,
    costScanner,
    scanSessions: agentSessions.scan,
    focusSession: agentSessions.focus,
    cache: {
      clearCookies: async (provider) => {
        const ids = provider === undefined ? PROVIDERS.map(({ id }) => id) : [provider];
        let cleared = 0;
        let failed = 0;
        for (const id of ids) {
          try {
            await Effect.runPromise(credentials.remove(`browser-session/${id}/default`));
            cleared += 1;
          } catch {
            failed += 1;
          }
        }
        return failed === 0
          ? { cleared }
          : {
              cleared,
              error: `Cookie cache cleanup failed for ${failed} operation${failed === 1 ? "" : "s"}`,
            };
      },
      // Persisted cost records are history, not a derived scanner cache. Until
      // the JSONL scanner cache exists in TypeScript there is nothing safe to
      // delete here; never reinterpret `cache --cost` as history deletion.
      clearCost: async () => ({ cleared: 0 }),
    },
    ...(plugins === undefined ? {} : { plugins }),
    claudeSwap,
    legacyImport: {
      inspect: (options: NodeLegacyImportOptions) =>
        Effect.runPromise(inspectNodeLegacyImport(options)),
      execute: (options: NodeLegacyImportOptions) =>
        Effect.runPromise(executeNodeLegacyImport(options)),
      rollback: (options: NodeLegacyImportOptions & { readonly importId: string }) =>
        Effect.runPromise(rollbackNodeLegacyImport(options)),
    },
    dispose: () => plugins?.dispose(),
    runHook: async (request) => {
      const input = new TextEncoder().encode(request.input);
      if (input.byteLength > 4_096) throw new Error("hook payload too large");
      const result = await Effect.runPromise(
        hookProcessRunner.run({
          command: request.executable,
          args: request.arguments,
          env: request.environment,
          stdin: input,
          timeoutMs: request.timeoutMs,
        }),
        { signal: request.signal },
      );
      if (result.exitCode !== 0) throw new Error(`exit ${result.exitCode ?? "unknown"}`);
      return { stdout: new TextDecoder("utf-8", { fatal: true }).decode(result.stdout) };
    },
  };
};

export const nodeIO: CLIIO = {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
  readSecret: () => readNonInteractiveSecret(process.stdin, process.stdin.isTTY),
};
