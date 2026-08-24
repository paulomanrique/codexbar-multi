import { Context, Effect } from "effect";
import type {
  ProviderDescriptor,
  ProviderId,
  ProviderInstanceId,
  UsageSnapshot,
} from "@codexbar/contracts";
import type { PersistedCodexBarConfig } from "./config.ts";
import type {
  ProviderFetchContext,
  ProviderFetchError,
  ProviderFetchOutcome,
  ProviderFetchStrategy,
} from "./provider-fetch-pipeline.ts";

/** Errors emitted by the injected host capabilities. */
export class InfrastructureError extends Error {
  readonly _tag = "InfrastructureError";
  readonly operation: string;
  readonly causeValue: unknown;

  constructor(operation: string, message: string, causeValue?: unknown) {
    super(message);
    this.name = "InfrastructureError";
    this.operation = operation;
    this.causeValue = causeValue;
  }
}

/** Narrow nominal signal for a missing exported browser credential. */
export class MissingBrowserCredentialError extends Error {
  readonly _tag = "MissingBrowserCredentialError";

  constructor(message = "No exported browser credential is available") {
    super(message);
    this.name = "MissingBrowserCredentialError";
  }
}

export interface HttpRequest {
  readonly url: string;
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
  readonly timeoutMs?: number;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly url: string;
}

export interface HttpTransportService {
  readonly execute: (request: HttpRequest) => Effect.Effect<HttpResponse, InfrastructureError>;
}
export const HttpTransport = Context.Service<HttpTransportService>("@codexbar/core/HttpTransport");

export interface CredentialStoreService {
  readonly read: (key: string) => Effect.Effect<string | undefined, InfrastructureError>;
  readonly write: (key: string, value: string) => Effect.Effect<void, InfrastructureError>;
  readonly remove: (key: string) => Effect.Effect<void, InfrastructureError>;
}
export const CredentialStore = Context.Service<CredentialStoreService>(
  "@codexbar/core/CredentialStore",
);

/** Private files must be replaced atomically: readers observe either whole version, never a partial write. */
export interface PrivateFileStoreService {
  readonly read: (path: string) => Effect.Effect<Uint8Array | undefined, InfrastructureError>;
  readonly writeAtomic: (
    path: string,
    content: Uint8Array,
  ) => Effect.Effect<void, InfrastructureError>;
  readonly remove: (path: string) => Effect.Effect<void, InfrastructureError>;
}
export const PrivateFileStore = Context.Service<PrivateFileStoreService>(
  "@codexbar/core/PrivateFileStore",
);

/**
 * Persisted configuration is deliberately separate from credentials. Hosts own
 * its encoding and atomic replacement, while core only depends on this safe
 * serializable DTO.
 */
export interface AppPaths {
  readonly appData: string;
  readonly cache: string;
  readonly config: string;
  readonly logs: string;
  readonly temporary: string;
}

export interface PlatformPathsService {
  readonly resolve: Effect.Effect<AppPaths, InfrastructureError>;
}
export const PlatformPaths = Context.Service<PlatformPathsService>("@codexbar/core/PlatformPaths");

export interface ClockService {
  readonly now: Effect.Effect<number>;
  readonly sleep: (milliseconds: number) => Effect.Effect<void>;
}
export const Clock = Context.Service<ClockService>("@codexbar/core/Clock");

export interface ProviderRegistryService {
  readonly list: Effect.Effect<ReadonlyArray<ProviderDescriptor>>;
  readonly descriptor: (providerId: ProviderId) => Effect.Effect<ProviderDescriptor | undefined>;
  readonly strategies: (
    providerId: ProviderId,
    context: ProviderFetchContext,
  ) => Effect.Effect<ReadonlyArray<ProviderFetchStrategy>>;
}
export const ProviderRegistry = Context.Service<ProviderRegistryService>(
  "@codexbar/core/ProviderRegistry",
);

/** Fully composed provider execution. Hosts supply capabilities once, at the composition root. */
export interface ProviderRuntimeService {
  readonly fetch: (
    providerId: ProviderId,
    context: ProviderFetchContext,
  ) => Effect.Effect<ProviderFetchOutcome, ProviderFetchError>;
}
export const ProviderRuntime = Context.Service<ProviderRuntimeService>(
  "@codexbar/core/ProviderRuntime",
);

export interface RefreshCoordinatorService {
  readonly refresh: (
    providerId: ProviderId,
    context: ProviderFetchContext,
  ) => Effect.Effect<ProviderFetchOutcome, ProviderFetchError>;
  readonly refreshAll: (
    providerIds: ReadonlyArray<ProviderId>,
    context: ProviderFetchContext,
  ) => Effect.Effect<ReadonlyArray<ProviderFetchOutcome>, ProviderFetchError>;
  readonly cancel: (providerId?: ProviderId) => Effect.Effect<void>;
}
export const RefreshCoordinator = Context.Service<RefreshCoordinatorService>(
  "@codexbar/core/RefreshCoordinator",
);

export interface ConfigRepositoryService {
  readonly load: Effect.Effect<PersistedCodexBarConfig | undefined, InfrastructureError>;
  readonly save: (config: PersistedCodexBarConfig) => Effect.Effect<void, InfrastructureError>;
  readonly modify: <Value, Error = never, Requirements = never>(
    mutation: (
      config: PersistedCodexBarConfig | undefined,
    ) => Effect.Effect<
      { readonly config: PersistedCodexBarConfig; readonly value: Value },
      Error,
      Requirements
    >,
  ) => Effect.Effect<
    { readonly config: PersistedCodexBarConfig; readonly value: Value },
    Error | InfrastructureError,
    Requirements
  >;
}
export const ConfigRepository = Context.Service<ConfigRepositoryService>(
  "@codexbar/core/ConfigRepository",
);

export interface ProcessSpec {
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: Uint8Array;
  readonly timeoutMs?: number;
}

export interface ProcessResult {
  readonly exitCode: number | undefined;
  readonly signal: string | undefined;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

export interface ProcessRunnerService {
  readonly run: (spec: ProcessSpec) => Effect.Effect<ProcessResult, InfrastructureError>;
}
export const ProcessRunner = Context.Service<ProcessRunnerService>("@codexbar/core/ProcessRunner");

export interface PtySpec extends ProcessSpec {
  readonly columns?: number;
  readonly rows?: number;
}

export interface PtySession {
  readonly write: (input: Uint8Array) => Effect.Effect<void, InfrastructureError>;
  readonly read: Effect.Effect<Uint8Array, InfrastructureError>;
  readonly resize: (columns: number, rows: number) => Effect.Effect<void, InfrastructureError>;
  readonly close: Effect.Effect<void, InfrastructureError>;
}

export interface PtyRunnerService {
  readonly start: (spec: PtySpec) => Effect.Effect<PtySession, InfrastructureError>;
}
export const PtyRunner = Context.Service<PtyRunnerService>("@codexbar/core/PtyRunner");

export interface ProcessInfo {
  readonly pid: number;
  readonly parentPid: number | undefined;
  readonly command: string;
  readonly arguments: ReadonlyArray<string>;
}

export interface ProcessEnumeratorService {
  readonly list: Effect.Effect<ReadonlyArray<ProcessInfo>, InfrastructureError>;
}
export const ProcessEnumerator = Context.Service<ProcessEnumeratorService>(
  "@codexbar/core/ProcessEnumerator",
);

export interface BrowserSessionRequest {
  readonly browser: "chrome" | "chromium" | "edge" | "firefox" | "safari";
  readonly domain: string;
  readonly cookieNames?: ReadonlyArray<string>;
}

export interface BrowserSession {
  readonly cookies: Readonly<Record<string, string>>;
  readonly source: string;
}

export interface BrowserSessionBrokerService {
  readonly sessionFor: (
    request: BrowserSessionRequest,
  ) => Effect.Effect<BrowserSession | undefined, InfrastructureError>;
}
export const BrowserSessionBroker = Context.Service<BrowserSessionBrokerService>(
  "@codexbar/core/BrowserSessionBroker",
);

export interface HistoryRecord {
  /** First-party IDs and user plugin instance IDs share the durable history namespace. */
  readonly providerId: ProviderInstanceId;
  readonly recordedAt: number;
  readonly snapshot: UsageSnapshot;
}

export interface HistoryRepositoryService {
  readonly append: (record: HistoryRecord) => Effect.Effect<void, InfrastructureError>;
  /** Constant-size lookup for overview composition; history remains append-only. */
  readonly latest: (
    providerId: ProviderInstanceId,
  ) => Effect.Effect<HistoryRecord | undefined, InfrastructureError>;
  readonly list: (
    providerId: ProviderInstanceId,
    since: number,
    limit?: number,
  ) => Effect.Effect<ReadonlyArray<HistoryRecord>, InfrastructureError>;
  /** Deletes only one provider instance's snapshots; it never rebuilds the shared store. */
  readonly removeProvider: (
    providerId: ProviderInstanceId,
  ) => Effect.Effect<void, InfrastructureError>;
}
export const HistoryRepository = Context.Service<HistoryRepositoryService>(
  "@codexbar/core/HistoryRepository",
);

export interface CostUsageRecord {
  readonly providerId: ProviderId;
  readonly recordedAt: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
}

/** Main-process-only identity for a replaceable vendor daily-spend feed. */
export interface DailyCostUsageReplacement {
  readonly providerId: ProviderId;
  /** Never crosses IPC: it distinguishes independent vendor feeds for one provider. */
  readonly sourceKey: string;
  /** Inclusive UTC-day range covered by this vendor response. */
  readonly since: number;
  readonly until: number;
  /** A missing chart is unavailable; an empty chart is an available zero-spend response. */
  readonly availability: "available" | "unavailable";
  readonly coverage: "exact" | "estimated";
  readonly records: ReadonlyArray<CostUsageRecord>;
}

export interface DailyCostUsageSourceState {
  readonly availability: "available" | "unavailable";
  readonly coverage: "exact" | "estimated";
}

/**
 * One durable local-log scanner checkpoint and the rows it made billable.
 *
 * `sourceKey` identifies one immutable-at-a-time log source, while
 * `checkpointJson` remains host-owned so the portable core does not learn
 * about files, inodes, or a particular scanner implementation. A reset is
 * required when a source identity changes: old rows for that source are
 * replaced in the same transaction as its new checkpoint. The expected
 * checkpoint makes concurrent desktop/CLI commits compare-and-swap rather
 * than duplicating a scanned byte range.
 */
export interface LocalCostUsageScanCommit {
  readonly providerId: ProviderId;
  readonly sourceKey: string;
  /**
   * Exact checkpoint observed before scanning. Its absence means this commit
   * may create a checkpoint only when the source has no prior checkpoint.
   */
  readonly expectedCheckpointJson?: string;
  readonly checkpointJson: string;
  readonly records: ReadonlyArray<CostUsageRecord>;
  readonly reset?: boolean;
}

/**
 * A complete replacement of a related set of local log sources.
 *
 * A single source cursor is sufficient for append-only logs. Forked Codex
 * rollouts are different: every member's billable totals depend on the
 * family graph, so publishing any member independently can double-count a
 * copied prefix. The opaque manifest is the CAS owner for the selected
 * family; its contents remain platform-owned and must not cross IPC.
 */
export interface LocalCostUsageScanFamilyCommit {
  readonly providerId: ProviderId;
  readonly familyKey: string;
  /** Absence creates the family only when it has not been published before. */
  readonly expectedManifestJson?: string;
  readonly manifestJson: string;
  /** Every current member is a full replacement, never an incremental append. */
  readonly members: ReadonlyArray<LocalCostUsageScanCommit>;
  /**
   * Former manifest members to remove with the new family snapshot. Each
   * carries the checkpoint observed while scanning, so a stale inventory
   * cannot erase a concurrently refreshed source.
   */
  readonly removals: ReadonlyArray<{
    readonly sourceKey: string;
    readonly expectedCheckpointJson?: string;
  }>;
}

/** Bound durable scanner state before it reaches a platform persistence layer. */
export const LOCAL_COST_USAGE_SCAN_CHECKPOINT_MAX_BYTES = 1_048_576;

/** Rejects malformed or oversized host-owned checkpoint payloads consistently. */
export const assertLocalCostUsageScanCheckpointJson = (checkpointJson: string): void => {
  const byteLength = new TextEncoder().encode(checkpointJson).byteLength;
  if (byteLength === 0 || byteLength > LOCAL_COST_USAGE_SCAN_CHECKPOINT_MAX_BYTES) {
    throw new Error("local cost usage scan checkpoint is invalid");
  }
  let checkpoint: unknown;
  try {
    checkpoint = JSON.parse(checkpointJson);
  } catch {
    throw new Error("local cost usage scan checkpoint is invalid");
  }
  if (typeof checkpoint !== "object" || checkpoint === null || Array.isArray(checkpoint)) {
    throw new Error("local cost usage scan checkpoint is invalid");
  }
};

export interface CostUsageRepositoryService {
  readonly append: (record: CostUsageRecord) => Effect.Effect<void, InfrastructureError>;
  /**
   * Commits newly billable local-log rows and the cursor that covers them as
   * one unit. A crash therefore leaves either both the previous checkpoint
   * and rows, or both the next checkpoint and rows.
   */
  readonly commitLocalScan: (
    commit: LocalCostUsageScanCommit,
  ) => Effect.Effect<void, InfrastructureError>;
  /**
   * Atomically replaces all members of one local source family. It is the
   * only valid publication path for a scanner whose rows depend on sibling
   * sources (for example, a Codex active/archive fork lineage).
   */
  readonly commitLocalScanFamily: (
    commit: LocalCostUsageScanFamilyCommit,
  ) => Effect.Effect<void, InfrastructureError>;
  /** Main-process-only checkpoint; it never crosses the renderer bridge. */
  readonly localScanCheckpoint: (
    providerId: ProviderId,
    sourceKey: string,
  ) => Effect.Effect<string | undefined, InfrastructureError>;
  /**
   * Replaces one vendor's daily ledger atomically. This is deliberately
   * separate from append-only local/session accounting, whose rows may share
   * a day but are not cumulative vendor buckets.
   */
  readonly replaceDaily: (
    replacement: DailyCostUsageReplacement,
  ) => Effect.Effect<void, InfrastructureError>;
  /** Main-process-only availability/coverage metadata for a daily ledger. */
  readonly dailySourceState: (
    providerId: ProviderId,
    sourceKey: string,
  ) => Effect.Effect<DailyCostUsageSourceState | undefined, InfrastructureError>;
  readonly list: (
    providerId: ProviderId,
    since: number,
    limit?: number,
  ) => Effect.Effect<ReadonlyArray<CostUsageRecord>, InfrastructureError>;
}
export const CostUsageRepository = Context.Service<CostUsageRepositoryService>(
  "@codexbar/core/CostUsageRepository",
);
