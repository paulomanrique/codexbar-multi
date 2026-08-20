import { Effect, Layer } from "effect";
import {
  BrowserSessionBroker,
  Clock,
  ConfigRepository,
  type CostUsageRecord,
  CostUsageRepository,
  CredentialStore,
  HistoryRepository,
  type HistoryRecord,
  HttpTransport,
  InfrastructureError,
  type HttpRequest,
  type HttpResponse,
  PlatformPaths,
  PrivateFileStore,
  ProcessEnumerator,
  ProcessRunner,
  PtyRunner,
} from "./services.ts";
import type { PersistedCodexBarConfig } from "./config.ts";

export const makeMemoryHttpTransport = (
  handler: (request: HttpRequest) => Effect.Effect<HttpResponse>,
) => Layer.succeed(HttpTransport, { execute: handler });

export const MemoryCredentialStore = Layer.sync(CredentialStore, () => {
  const entries = new Map<string, string>();
  return {
    read: (key: string) => Effect.sync(() => entries.get(key)),
    write: (key: string, value: string) => Effect.sync(() => void entries.set(key, value)),
    remove: (key: string) => Effect.sync(() => void entries.delete(key)),
  };
});

/** In-memory model of atomic replacement: content is copied before publication. */
export const MemoryPrivateFileStore = Layer.sync(PrivateFileStore, () => {
  const entries = new Map<string, Uint8Array>();
  return {
    read: (path: string) => Effect.sync(() => entries.get(path)?.slice()),
    writeAtomic: (path: string, content: Uint8Array) =>
      Effect.sync(() => void entries.set(path, content.slice())),
    remove: (path: string) => Effect.sync(() => void entries.delete(path)),
  };
});

export const TestClock = (initialNow = 0) =>
  Layer.sync(Clock, () => {
    let currentNow = initialNow;
    return {
      now: Effect.sync(() => currentNow),
      sleep: (milliseconds: number) =>
        Effect.sync(() => {
          currentNow += Math.max(0, milliseconds);
        }),
    };
  });

export const makeMemoryConfigRepository = (initial: PersistedCodexBarConfig) =>
  Layer.sync(ConfigRepository, () => {
    let config = structuredClone(initial);
    return {
      load: Effect.sync(() => structuredClone(config)),
      save: (next: PersistedCodexBarConfig) =>
        Effect.sync(() => {
          config = structuredClone(next);
        }),
    };
  });

export const MemoryHistoryRepository = Layer.sync(HistoryRepository, () => {
  const records: Array<HistoryRecord> = [];
  return {
    append: (record: HistoryRecord) =>
      Effect.sync(() => {
        records.push(record);
      }),
    latest: (providerId: HistoryRecord["providerId"]) =>
      Effect.sync(() =>
        records.reduce<HistoryRecord | undefined>((latest, record) => {
          if (record.providerId !== providerId) return latest;
          return latest === undefined || record.recordedAt >= latest.recordedAt ? record : latest;
        }, undefined),
      ),
    list: (providerId: HistoryRecord["providerId"], since: number, limit?: number) =>
      Effect.sync(() => {
        const matching = records.filter(
          (record) => record.providerId === providerId && record.recordedAt >= since,
        );
        return limit === undefined ? matching : matching.slice(0, limit);
      }),
  };
});

export const MemoryCostUsageRepository = Layer.sync(CostUsageRepository, () => {
  const records: Array<CostUsageRecord> = [];
  return {
    append: (record: CostUsageRecord) =>
      Effect.sync(() => {
        records.push(record);
      }),
    list: (providerId: CostUsageRecord["providerId"], since: number, limit?: number) =>
      Effect.sync(() => {
        const matching = records.filter(
          (record) => record.providerId === providerId && record.recordedAt >= since,
        );
        return limit === undefined ? matching : matching.slice(0, limit);
      }),
  };
});

export const EmptyHostCapabilities = Layer.mergeAll(
  Layer.succeed(PlatformPaths, {
    resolve: Effect.succeed({
      appData: "/data",
      cache: "/cache",
      config: "/config",
      logs: "/logs",
      temporary: "/tmp",
    }),
  }),
  Layer.succeed(ProcessRunner, {
    run: () => Effect.fail(new InfrastructureError("run", "Process runner not configured")),
  }),
  Layer.succeed(PtyRunner, {
    start: () => Effect.fail(new InfrastructureError("start", "PTY runner not configured")),
  }),
  Layer.succeed(ProcessEnumerator, { list: Effect.succeed([]) }),
  Layer.succeed(BrowserSessionBroker, { sessionFor: () => Effect.succeed(undefined) }),
  Layer.succeed(HistoryRepository, {
    append: () => Effect.void,
    latest: () => Effect.succeed(undefined),
    list: () => Effect.succeed([]),
  }),
  Layer.succeed(CostUsageRepository, { append: () => Effect.void, list: () => Effect.succeed([]) }),
);
