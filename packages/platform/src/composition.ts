import { Layer } from "effect";
import {
  BrowserSessionBroker,
  type BrowserSessionBrokerService,
  Clock,
  type ClockService,
  ConfigRepository,
  type ConfigRepositoryService,
  CostUsageRepository,
  type CostUsageRepositoryService,
  CredentialStore,
  type CredentialStoreService,
  HistoryRepository,
  type HistoryRepositoryService,
  HttpTransport,
  type HttpTransportService,
  PlatformPaths,
  type PlatformPathsService,
  PrivateFileStore,
  type PrivateFileStoreService,
  ProcessEnumerator,
  type ProcessEnumeratorService,
  ProcessRunner,
  type ProcessRunnerService,
  PtyRunner,
  type PtyRunnerService,
} from "@codexbar/core";

/** The host supplies concrete adapters; composition never inspects the OS. */
export interface PlatformAdapters {
  readonly http: HttpTransportService;
  readonly credentials: CredentialStoreService;
  readonly files: PrivateFileStoreService;
  readonly paths: PlatformPathsService;
  readonly clock: ClockService;
  readonly config: ConfigRepositoryService;
  readonly processes: ProcessRunnerService;
  readonly pty: PtyRunnerService;
  readonly processEnumerator: ProcessEnumeratorService;
  readonly browserSessions: BrowserSessionBrokerService;
  readonly history: HistoryRepositoryService;
  readonly costs: CostUsageRepositoryService;
}

export const makePlatformLayer = (adapters: PlatformAdapters) =>
  Layer.mergeAll(
    Layer.succeed(HttpTransport, adapters.http),
    Layer.succeed(CredentialStore, adapters.credentials),
    Layer.succeed(PrivateFileStore, adapters.files),
    Layer.succeed(PlatformPaths, adapters.paths),
    Layer.succeed(Clock, adapters.clock),
    Layer.succeed(ConfigRepository, adapters.config),
    Layer.succeed(ProcessRunner, adapters.processes),
    Layer.succeed(PtyRunner, adapters.pty),
    Layer.succeed(ProcessEnumerator, adapters.processEnumerator),
    Layer.succeed(BrowserSessionBroker, adapters.browserSessions),
    Layer.succeed(HistoryRepository, adapters.history),
    Layer.succeed(CostUsageRepository, adapters.costs),
  );
