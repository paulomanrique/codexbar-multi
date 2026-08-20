import { Context, Effect } from "effect";
import type { ProviderDescriptor, ProviderId, UsageSnapshot } from "@codexbar/contracts";
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
  readonly providerId: ProviderId;
  readonly recordedAt: number;
  readonly snapshot: UsageSnapshot;
}

export interface HistoryRepositoryService {
  readonly append: (record: HistoryRecord) => Effect.Effect<void, InfrastructureError>;
  /** Constant-size lookup for overview composition; history remains append-only. */
  readonly latest: (
    providerId: ProviderId,
  ) => Effect.Effect<HistoryRecord | undefined, InfrastructureError>;
  readonly list: (
    providerId: ProviderId,
    since: number,
    limit?: number,
  ) => Effect.Effect<ReadonlyArray<HistoryRecord>, InfrastructureError>;
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

export interface CostUsageRepositoryService {
  readonly append: (record: CostUsageRecord) => Effect.Effect<void, InfrastructureError>;
  readonly list: (
    providerId: ProviderId,
    since: number,
    limit?: number,
  ) => Effect.Effect<ReadonlyArray<CostUsageRecord>, InfrastructureError>;
}
export const CostUsageRepository = Context.Service<CostUsageRepositoryService>(
  "@codexbar/core/CostUsageRepository",
);
