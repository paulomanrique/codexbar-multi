import { Effect, Layer } from "effect";
import {
  BrowserSessionBroker,
  assertLocalCostUsageScanCheckpointJson,
  Clock,
  ConfigRepository,
  type CostUsageRecord,
  type LocalCostUsageScanFamilyCommit,
  type LocalCostUsageScanCommit,
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
      modify: (mutation) =>
        Effect.gen(function* () {
          const result = yield* mutation(structuredClone(config));
          config = structuredClone(result.config);
          return result;
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
    removeProvider: (providerId: HistoryRecord["providerId"]) =>
      Effect.sync(() => {
        for (let index = records.length - 1; index >= 0; index -= 1) {
          if (records[index]?.providerId === providerId) records.splice(index, 1);
        }
      }),
  };
});

export const MemoryCostUsageRepository = Layer.sync(CostUsageRepository, () => {
  const appendedRecords: Array<CostUsageRecord> = [];
  const localScanRecords = new Map<string, Array<CostUsageRecord>>();
  const localScanCheckpoints = new Map<string, string>();
  const dailyRecords = new Map<string, Map<number, CostUsageRecord>>();
  const dailyStates = new Map<
    string,
    { availability: "available" | "unavailable"; coverage: "exact" | "estimated" }
  >();
  const dailyKey = (providerId: CostUsageRecord["providerId"], sourceKey: string) =>
    `${providerId}\u0000${sourceKey}`;
  const allRecords = (): CostUsageRecord[] => [
    ...appendedRecords,
    ...[...localScanRecords.values()].flat(),
    ...[...dailyRecords.values()].flatMap((records) => [...records.values()]),
  ];
  return {
    append: (record: CostUsageRecord) =>
      Effect.sync(() => {
        appendedRecords.push(record);
      }),
    commitLocalScan: (commit: LocalCostUsageScanCommit) =>
      Effect.try({
        try: () => {
          assertLocalCostUsageScanCheckpointJson(commit.checkpointJson);
          if (commit.expectedCheckpointJson !== undefined) {
            assertLocalCostUsageScanCheckpointJson(commit.expectedCheckpointJson);
          }
          const key = dailyKey(commit.providerId, commit.sourceKey);
          if (localScanCheckpoints.get(key) !== commit.expectedCheckpointJson) {
            throw new Error("Local cost usage scan checkpoint changed");
          }
          const existing = commit.reset ? [] : (localScanRecords.get(key) ?? []);
          localScanRecords.set(key, [...existing, ...commit.records]);
          localScanCheckpoints.set(key, commit.checkpointJson);
        },
        catch: (error) =>
          new InfrastructureError(
            "commit local cost usage scan",
            "Memory cost scan commit failed",
            error,
          ),
      }),
    commitLocalScanFamily: (commit: LocalCostUsageScanFamilyCommit) =>
      Effect.try({
        try: () => {
          assertLocalCostUsageScanCheckpointJson(commit.manifestJson);
          if (commit.expectedManifestJson !== undefined) {
            assertLocalCostUsageScanCheckpointJson(commit.expectedManifestJson);
          }
          const familyKey = dailyKey(commit.providerId, commit.familyKey);
          if (localScanCheckpoints.get(familyKey) !== commit.expectedManifestJson) {
            throw new Error("Local cost usage scan family checkpoint changed");
          }
          for (const member of commit.members) {
            assertLocalCostUsageScanCheckpointJson(member.checkpointJson);
            if (member.expectedCheckpointJson !== undefined) {
              assertLocalCostUsageScanCheckpointJson(member.expectedCheckpointJson);
            }
            const key = dailyKey(commit.providerId, member.sourceKey);
            if (localScanCheckpoints.get(key) !== member.expectedCheckpointJson) {
              throw new Error("Local cost usage scan checkpoint changed");
            }
          }
          for (const removal of commit.removals) {
            const key = dailyKey(commit.providerId, removal.sourceKey);
            if (localScanCheckpoints.get(key) !== removal.expectedCheckpointJson) {
              throw new Error("Local cost usage scan checkpoint changed");
            }
            localScanRecords.delete(key);
            localScanCheckpoints.delete(key);
          }
          for (const member of commit.members) {
            const key = dailyKey(commit.providerId, member.sourceKey);
            localScanRecords.set(key, [...member.records]);
            localScanCheckpoints.set(key, member.checkpointJson);
          }
          localScanCheckpoints.set(familyKey, commit.manifestJson);
        },
        catch: (error) =>
          new InfrastructureError(
            "commit local cost usage scan family",
            "Memory cost scan family commit failed",
            error,
          ),
      }),
    localScanCheckpoint: (providerId, sourceKey) =>
      Effect.succeed(localScanCheckpoints.get(dailyKey(providerId, sourceKey))),
    replaceDaily: (replacement) =>
      Effect.sync(() => {
        const key = dailyKey(replacement.providerId, replacement.sourceKey);
        dailyStates.set(key, {
          availability: replacement.availability,
          coverage: replacement.coverage,
        });
        if (replacement.availability === "available") {
          const records = dailyRecords.get(key) ?? new Map<number, CostUsageRecord>();
          for (const [recordedAt] of records) {
            if (recordedAt >= replacement.since && recordedAt <= replacement.until) {
              records.delete(recordedAt);
            }
          }
          for (const record of replacement.records) records.set(record.recordedAt, record);
          dailyRecords.set(key, records);
        }
      }),
    dailySourceState: (providerId, sourceKey) =>
      Effect.succeed(dailyStates.get(dailyKey(providerId, sourceKey))),
    list: (providerId: CostUsageRecord["providerId"], since: number, limit?: number) =>
      Effect.sync(() => {
        const matching = allRecords().filter(
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
    removeProvider: () => Effect.void,
  }),
  Layer.succeed(CostUsageRepository, {
    append: () => Effect.void,
    commitLocalScan: () => Effect.void,
    commitLocalScanFamily: () => Effect.void,
    localScanCheckpoint: () => Effect.succeed(undefined),
    replaceDaily: () => Effect.void,
    dailySourceState: () => Effect.succeed(undefined),
    list: () => Effect.succeed([]),
  }),
);
