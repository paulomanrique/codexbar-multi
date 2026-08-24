import { backup, DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Effect, Schema } from "effect";
import {
  decodeCodexBarConfig,
  DEFAULT_PROVIDER_CONFIG_NORMALIZERS,
  encodeCodexBarConfig,
  normalizeCodexBarConfig,
  type ConfigRepositoryService,
  type CostUsageRecord,
  type CostUsageRepositoryService,
  type DailyCostUsageReplacement,
  type DailyCostUsageSourceState,
  type LocalCostUsageScanCommit,
  type LocalCostUsageScanFamilyCommit,
  type HistoryRecord,
  type HistoryRepositoryService,
  InfrastructureError,
  type UsageRecordRetentionRequest,
  type UsageRecordRetentionResult,
  type UsageRecordRetentionService,
  assertUsageRecordRetentionRequest,
  assertLocalCostUsageScanCheckpointJson,
} from "@codexbar/core";
import { ProviderId, ProviderInstanceId, UsageSnapshot } from "@codexbar/contracts";
import { makeNodePrivateFileStore } from "./node.ts";
import {
  makeNodePrivateDirectoryRestriction,
  makeNodePrivateFileRestriction,
} from "./node-private-path-security.ts";

const SQLITE_BUSY_TIMEOUT_MS = 5_000;

/** A stale scanner cursor lost its compare-and-swap race; reload and retry. */
export class CostUsageScanCheckpointConflictError extends Error {
  constructor(providerId: string, sourceKey: string) {
    super(`Local cost usage scan checkpoint changed: ${providerId}/${sourceKey}`);
    this.name = "CostUsageScanCheckpointConflictError";
  }
}

/** A monotonically-versioned schema change. Destructive steps trigger a SQLite backup first. */
export interface NodeSqliteMigration {
  readonly version: number;
  readonly sql: string;
  readonly destructive?: boolean;
}

export const NODE_PERSISTENCE_MIGRATIONS: readonly NodeSqliteMigration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE providers (
        provider_id TEXT PRIMARY KEY NOT NULL
      );

      CREATE TABLE history_records (
        id INTEGER PRIMARY KEY,
        provider_id TEXT NOT NULL REFERENCES providers(provider_id),
        recorded_at INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json))
      );
      CREATE INDEX history_records_provider_recorded_at
        ON history_records(provider_id, recorded_at, id);

      CREATE TABLE cost_usage_records (
        id INTEGER PRIMARY KEY,
        provider_id TEXT NOT NULL REFERENCES providers(provider_id),
        recorded_at INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cost_usd REAL NOT NULL
      );
      CREATE INDEX cost_usage_records_provider_recorded_at
        ON cost_usage_records(provider_id, recorded_at, id);
    `,
  },
  {
    version: 2,
    sql: `
      ALTER TABLE cost_usage_records ADD COLUMN source_key TEXT NOT NULL DEFAULT 'append';
      CREATE INDEX cost_usage_records_provider_source_recorded_at
        ON cost_usage_records(provider_id, source_key, recorded_at, id);

      CREATE TABLE cost_usage_sources (
        provider_id TEXT NOT NULL REFERENCES providers(provider_id),
        source_key TEXT NOT NULL,
        availability TEXT NOT NULL CHECK (availability IN ('available', 'unavailable')),
        coverage TEXT NOT NULL CHECK (coverage IN ('exact', 'estimated')),
        PRIMARY KEY (provider_id, source_key)
      );
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE cost_usage_scan_checkpoints (
        provider_id TEXT NOT NULL REFERENCES providers(provider_id),
        source_key TEXT NOT NULL,
        checkpoint_json TEXT NOT NULL CHECK (json_valid(checkpoint_json)),
        PRIMARY KEY (provider_id, source_key)
      );
    `,
  },
];

export interface NodeSqlitePersistenceOptions {
  readonly databasePath: string;
  readonly migrations?: readonly NodeSqliteMigration[];
  /** Read-only mode is useful for diagnostics and never applies migrations. */
  readonly readOnly?: boolean;
}

export interface NodeSqlitePersistence {
  readonly history: HistoryRepositoryService;
  readonly costs: CostUsageRepositoryService;
  /** Shared history/cost retention, committed as one SQLite transaction. */
  readonly retention: UsageRecordRetentionService;
  readonly close: Effect.Effect<void, InfrastructureError>;
}

/**
 * Opens the local usage store with crash-safe SQLite settings. All database
 * operations pass through one FIFO, so writes never overlap and every append
 * is committed as one BEGIN IMMEDIATE transaction.
 */
export const makeNodeSqlitePersistence = (
  options: NodeSqlitePersistenceOptions,
): Effect.Effect<NodeSqlitePersistence, InfrastructureError> =>
  Effect.tryPromise({
    try: async () => {
      if (!options.readOnly) {
        await mkdir(dirname(options.databasePath), { recursive: true, mode: 0o700 });
        await restrictPrivateDirectory(dirname(options.databasePath));
      }

      const database = new DatabaseSync(options.databasePath, {
        allowExtension: false,
        enableForeignKeyConstraints: true,
        readOnly: options.readOnly ?? false,
        timeout: SQLITE_BUSY_TIMEOUT_MS,
      });

      try {
        if (!options.readOnly) await restrictPrivateDatabaseArtifacts(options.databasePath);
        configureConnection(database, options.readOnly ?? false);
        assertQuickCheck(database);
        if (!options.readOnly) {
          await applyMigrations(
            database,
            options.databasePath,
            options.migrations ?? NODE_PERSISTENCE_MIGRATIONS,
          );
          assertQuickCheck(database);
          // SQLite creates WAL/SHM files lazily. Secure all artifacts after
          // migrations have exercised the journal, rather than protecting
          // only the main database file.
          await restrictPrivateDatabaseArtifacts(options.databasePath);
        }

        // The writer owns migrations and every BEGIN IMMEDIATE transaction.
        // A separate read-only connection lets WAL readers in another desktop
        // or CLI process continue while this writer is waiting on a lock. It
        // is deliberately opened only after migration, so it never observes a
        // partially-updated schema.
        const reader = options.readOnly ? database : openReadConnection(options.databasePath);
        try {
          return makeRepositories(database, reader);
        } catch (error) {
          if (reader !== database) reader.close();
          throw error;
        }
      } catch (error) {
        database.close();
        throw error;
      }
    },
    catch: (error) =>
      new InfrastructureError(
        "open SQLite persistence",
        `Unable to open local usage store: ${options.databasePath}`,
        error,
      ),
  });

/**
 * Stores the schema-validated, non-secret configuration in an owner-only JSON
 * file. PrivateFileStore performs same-directory staging, fsync, and atomic
 * rename so a crash leaves either the old config or a complete new document.
 */
export interface NodeConfigRepositoryOptions {
  /** Plugin IDs known to the host at load time; unregistered plugin config is dropped safely. */
  readonly pluginProviderIds?: ReadonlySet<string>;
}

export const makeNodeConfigRepository = (
  path: string,
  options: NodeConfigRepositoryOptions = {},
): ConfigRepositoryService => {
  const files = makeNodePrivateFileStore();
  return {
    load: files.read(path).pipe(
      Effect.flatMap((content) => {
        if (content === undefined) return Effect.succeed(undefined);
        return Effect.try({
          try: () =>
            normalizeCodexBarConfig(
              decodeCodexBarConfig(JSON.parse(new TextDecoder().decode(content)), options),
              DEFAULT_PROVIDER_CONFIG_NORMALIZERS,
            ),
          catch: (error) =>
            new InfrastructureError(
              "read config",
              `Unable to validate config file: ${path}`,
              error,
            ),
        });
      }),
    ),
    save: (config) =>
      Effect.try({
        try: () => {
          const validated = normalizeCodexBarConfig(
            decodeCodexBarConfig(encodeCodexBarConfig(config), options),
            DEFAULT_PROVIDER_CONFIG_NORMALIZERS,
          );
          return new TextEncoder().encode(`${JSON.stringify(encodeCodexBarConfig(validated))}\n`);
        },
        catch: (error) =>
          new InfrastructureError("write config", `Unable to encode config file: ${path}`, error),
      }).pipe(Effect.flatMap((content) => files.writeAtomic(path, content))),
    modify: (mutation) =>
      Effect.gen(function* () {
        const current = yield* files.read(path).pipe(
          Effect.flatMap((content) => {
            if (content === undefined) return Effect.succeed(undefined);
            return Effect.try({
              try: () =>
                normalizeCodexBarConfig(
                  decodeCodexBarConfig(JSON.parse(new TextDecoder().decode(content)), options),
                  DEFAULT_PROVIDER_CONFIG_NORMALIZERS,
                ),
              catch: (error) =>
                new InfrastructureError(
                  "read config",
                  `Unable to validate config file: ${path}`,
                  error,
                ),
            });
          }),
        );
        const result = yield* mutation(current);
        yield* Effect.try({
          try: () => {
            const validated = normalizeCodexBarConfig(
              decodeCodexBarConfig(encodeCodexBarConfig(result.config), options),
              DEFAULT_PROVIDER_CONFIG_NORMALIZERS,
            );
            return new TextEncoder().encode(`${JSON.stringify(encodeCodexBarConfig(validated))}\n`);
          },
          catch: (error) =>
            new InfrastructureError("write config", `Unable to encode config file: ${path}`, error),
        }).pipe(Effect.flatMap((content) => files.writeAtomic(path, content)));
        return result;
      }),
  };
};

const configureConnection = (database: DatabaseSync, readOnly: boolean): void => {
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  if (!readOnly) {
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA synchronous = FULL");
  }
};

const openReadConnection = (databasePath: string): DatabaseSync => {
  const reader = new DatabaseSync(databasePath, {
    allowExtension: false,
    enableForeignKeyConstraints: true,
    readOnly: true,
    timeout: SQLITE_BUSY_TIMEOUT_MS,
  });
  try {
    configureConnection(reader, true);
    return reader;
  } catch (error) {
    reader.close();
    throw error;
  }
};

/** SQLite sidecars can contain the same sensitive snapshots as the main file. */
const restrictPrivateDatabaseArtifacts = async (databasePath: string): Promise<void> => {
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    try {
      await restrictExistingPrivateFile(path);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }
};

/**
 * SQLite may checkpoint and remove a sidecar between discovery and ACL setup.
 * On Windows `icacls` reports that race as exit code 2 (not Node's ENOENT), so
 * confirm the file still exists before treating it as a real ACL failure.
 */
const restrictExistingPrivateFile = async (path: string): Promise<void> => {
  try {
    await lstat(path);
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }
  try {
    await restrictPrivateFile(path);
  } catch (error) {
    try {
      await lstat(path);
    } catch (afterRestrictionError) {
      if (isMissingFile(afterRestrictionError)) return;
      throw error;
    }
    throw error;
  }
};

const isMissingFile = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

const assertQuickCheck = (database: DatabaseSync): void => {
  const rows = database.prepare("PRAGMA quick_check").all();
  if (rows.length !== 1 || rows[0]?.quick_check !== "ok") {
    throw new Error(`SQLite quick_check failed: ${JSON.stringify(rows)}`);
  }
};

const applyMigrations = async (
  database: DatabaseSync,
  databasePath: string,
  migrations: readonly NodeSqliteMigration[],
): Promise<void> => {
  assertMigrationsAreOrdered(migrations);
  const versionRow = database.prepare("PRAGMA user_version").get();
  const currentVersion = versionRow?.user_version;
  if (
    typeof currentVersion !== "number" ||
    !Number.isInteger(currentVersion) ||
    currentVersion < 0
  ) {
    throw new Error("SQLite user_version is invalid");
  }
  const latestVersion = migrations.at(-1)?.version ?? 0;
  if (currentVersion > latestVersion) {
    throw new Error(
      `SQLite schema version ${currentVersion} is newer than this application supports`,
    );
  }

  for (const migration of migrations) {
    if (migration.version <= currentVersion) continue;
    if (migration.destructive) {
      const backupPath = `${databasePath}.backup-v${migration.version}-${Date.now()}.sqlite`;
      await backup(database, backupPath);
      await restrictPrivateFile(backupPath);
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(migration.sql);
      database.exec(`PRAGMA user_version = ${migration.version}`);
      database.exec("COMMIT");
    } catch (error) {
      rollback(database);
      throw error;
    }
  }
};

const restrictPrivateFile = makeNodePrivateFileRestriction();
const restrictPrivateDirectory = makeNodePrivateDirectoryRestriction();

const assertMigrationsAreOrdered = (migrations: readonly NodeSqliteMigration[]): void => {
  let previousVersion = 0;
  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version <= previousVersion) {
      throw new Error("SQLite migrations must have strictly increasing positive versions");
    }
    previousVersion = migration.version;
  }
};

const makeRepositories = (database: DatabaseSync, reader: DatabaseSync): NodeSqlitePersistence => {
  const queue = new SerializedDatabaseQueue();
  const history: HistoryRepositoryService = {
    append: (record) =>
      queuedSqlite(queue, "append history record", () => {
        assertHistoryRecord(record);
        const snapshotJson = JSON.stringify(record.snapshot);
        if (snapshotJson === undefined) throw new Error("Usage snapshot is not JSON serializable");
        return inImmediateTransactionWithRetry(database, () => {
          ensureProvider(database, record.providerId);
          database
            .prepare(
              "INSERT INTO history_records (provider_id, recorded_at, snapshot_json) VALUES (?, ?, ?)",
            )
            .run(record.providerId, record.recordedAt, snapshotJson);
        });
      }),
    latest: (providerId) =>
      readSqlite("get latest history record", () => {
        assertProviderInstanceId(providerId);
        const row = reader
          .prepare(
            "SELECT provider_id, recorded_at, snapshot_json FROM history_records WHERE provider_id = ? ORDER BY recorded_at DESC, id DESC LIMIT 1",
          )
          .get(providerId);
        return row === undefined ? undefined : decodeHistoryRecord(row as Record<string, unknown>);
      }),
    list: (providerId, since, limit) =>
      readSqlite("list history records", () => {
        assertProviderInstanceId(providerId);
        assertListBounds(since, limit);
        return queryRows(
          reader,
          "SELECT provider_id, recorded_at, snapshot_json FROM history_records WHERE provider_id = ? AND recorded_at >= ? ORDER BY recorded_at, id",
          providerId,
          since,
          limit,
        ).map(decodeHistoryRecord);
      }),
    removeProvider: (providerId) =>
      queuedSqlite(queue, "remove provider history", () => {
        assertProviderInstanceId(providerId);
        return inImmediateTransactionWithRetry(database, () => {
          database.prepare("DELETE FROM history_records WHERE provider_id = ?").run(providerId);
        });
      }),
  };
  const costs: CostUsageRepositoryService = {
    append: (record) =>
      queuedSqlite(queue, "append cost usage record", () => {
        assertCostUsageRecord(record);
        return inImmediateTransactionWithRetry(database, () => {
          ensureProvider(database, record.providerId);
          database
            .prepare(
              "INSERT INTO cost_usage_records (provider_id, recorded_at, input_tokens, output_tokens, cost_usd) VALUES (?, ?, ?, ?, ?)",
            )
            .run(
              record.providerId,
              record.recordedAt,
              record.inputTokens,
              record.outputTokens,
              record.costUsd,
            );
        });
      }),
    commitLocalScan: (commit) =>
      queuedSqlite(queue, "commit local cost usage scan", () => {
        assertLocalCostUsageScanCommit(commit);
        return inImmediateTransactionWithRetry(database, () => {
          const existing = database
            .prepare(
              "SELECT checkpoint_json FROM cost_usage_scan_checkpoints WHERE provider_id = ? AND source_key = ?",
            )
            .get(commit.providerId, commit.sourceKey) as Record<string, unknown> | undefined;
          const currentCheckpoint =
            existing === undefined ? undefined : readString(existing, "checkpoint_json");
          if (currentCheckpoint !== commit.expectedCheckpointJson) {
            throw new CostUsageScanCheckpointConflictError(commit.providerId, commit.sourceKey);
          }
          ensureProvider(database, commit.providerId);
          if (commit.reset) {
            database
              .prepare("DELETE FROM cost_usage_records WHERE provider_id = ? AND source_key = ?")
              .run(commit.providerId, commit.sourceKey);
          }
          const insert = database.prepare(
            "INSERT INTO cost_usage_records (provider_id, recorded_at, input_tokens, output_tokens, cost_usd, source_key) VALUES (?, ?, ?, ?, ?, ?)",
          );
          for (const record of commit.records) {
            insert.run(
              record.providerId,
              record.recordedAt,
              record.inputTokens,
              record.outputTokens,
              record.costUsd,
              commit.sourceKey,
            );
          }
          database
            .prepare(
              `INSERT INTO cost_usage_scan_checkpoints (provider_id, source_key, checkpoint_json)
               VALUES (?, ?, ?)
               ON CONFLICT(provider_id, source_key) DO UPDATE SET
                 checkpoint_json = excluded.checkpoint_json`,
            )
            .run(commit.providerId, commit.sourceKey, commit.checkpointJson);
        });
      }),
    commitLocalScanFamily: (commit) =>
      queuedSqlite(queue, "commit local cost usage scan family", () => {
        assertLocalCostUsageScanFamilyCommit(commit);
        return inImmediateTransactionWithRetry(database, () => {
          const readCheckpoint = (sourceKey: string): string | undefined => {
            const existing = database
              .prepare(
                "SELECT checkpoint_json FROM cost_usage_scan_checkpoints WHERE provider_id = ? AND source_key = ?",
              )
              .get(commit.providerId, sourceKey) as Record<string, unknown> | undefined;
            return existing === undefined ? undefined : readString(existing, "checkpoint_json");
          };
          const assertExpected = (sourceKey: string, expected: string | undefined): void => {
            if (readCheckpoint(sourceKey) !== expected) {
              throw new CostUsageScanCheckpointConflictError(commit.providerId, sourceKey);
            }
          };

          // Check every CAS before mutating any member. BEGIN IMMEDIATE makes
          // this a single cross-process decision for desktop and CLI.
          assertExpected(commit.familyKey, commit.expectedManifestJson);
          for (const member of commit.members) {
            assertExpected(member.sourceKey, member.expectedCheckpointJson);
          }
          const priorManifest = familyManifestSourceKeys(commit.expectedManifestJson);
          for (const removal of commit.removals) {
            const expectedHash =
              removal.expectedCheckpointJson === undefined
                ? undefined
                : checkpointHash(removal.expectedCheckpointJson);
            if (priorManifest?.get(removal.sourceKey) !== expectedHash) {
              throw new CostUsageScanCheckpointConflictError(commit.providerId, removal.sourceKey);
            }
            assertExpected(removal.sourceKey, removal.expectedCheckpointJson);
          }

          ensureProvider(database, commit.providerId);
          const deleteSource = database.prepare(
            "DELETE FROM cost_usage_records WHERE provider_id = ? AND source_key = ?",
          );
          const deleteCheckpoint = database.prepare(
            "DELETE FROM cost_usage_scan_checkpoints WHERE provider_id = ? AND source_key = ?",
          );
          for (const removal of commit.removals) {
            deleteSource.run(commit.providerId, removal.sourceKey);
            deleteCheckpoint.run(commit.providerId, removal.sourceKey);
          }

          const insert = database.prepare(
            "INSERT INTO cost_usage_records (provider_id, recorded_at, input_tokens, output_tokens, cost_usd, source_key) VALUES (?, ?, ?, ?, ?, ?)",
          );
          const upsertCheckpoint = database.prepare(
            `INSERT INTO cost_usage_scan_checkpoints (provider_id, source_key, checkpoint_json)
             VALUES (?, ?, ?)
             ON CONFLICT(provider_id, source_key) DO UPDATE SET
               checkpoint_json = excluded.checkpoint_json`,
          );
          for (const member of commit.members) {
            // Family scans are complete replacements; this prevents stale
            // prefixes surviving a fork/replacement lineage change.
            deleteSource.run(commit.providerId, member.sourceKey);
            for (const record of member.records) {
              insert.run(
                record.providerId,
                record.recordedAt,
                record.inputTokens,
                record.outputTokens,
                record.costUsd,
                member.sourceKey,
              );
            }
            upsertCheckpoint.run(commit.providerId, member.sourceKey, member.checkpointJson);
          }
          upsertCheckpoint.run(commit.providerId, commit.familyKey, commit.manifestJson);
        });
      }),
    localScanCheckpoint: (providerId, sourceKey) =>
      readSqlite("get local cost usage scan checkpoint", () => {
        assertProviderId(providerId);
        assertDailySourceKey(sourceKey);
        const row = reader
          .prepare(
            "SELECT checkpoint_json FROM cost_usage_scan_checkpoints WHERE provider_id = ? AND source_key = ?",
          )
          .get(providerId, sourceKey) as Record<string, unknown> | undefined;
        return row === undefined ? undefined : readString(row, "checkpoint_json");
      }),
    replaceDaily: (replacement) =>
      queuedSqlite(queue, "replace daily cost usage records", () => {
        assertDailyCostUsageReplacement(replacement);
        return inImmediateTransactionWithRetry(database, () => {
          ensureProvider(database, replacement.providerId);
          database
            .prepare(
              `INSERT INTO cost_usage_sources (provider_id, source_key, availability, coverage)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(provider_id, source_key) DO UPDATE SET
                 availability = excluded.availability,
                 coverage = excluded.coverage`,
            )
            .run(
              replacement.providerId,
              replacement.sourceKey,
              replacement.availability,
              replacement.coverage,
            );
          // An unavailable analytics response deliberately retains prior rows:
          // source state hides them from publication until a fresh successful
          // chart atomically replaces its covered range.
          if (replacement.availability === "unavailable") return;
          database
            .prepare(
              "DELETE FROM cost_usage_records WHERE provider_id = ? AND source_key = ? AND recorded_at >= ? AND recorded_at <= ?",
            )
            .run(
              replacement.providerId,
              replacement.sourceKey,
              replacement.since,
              replacement.until,
            );
          const insert = database.prepare(
            "INSERT INTO cost_usage_records (provider_id, recorded_at, input_tokens, output_tokens, cost_usd, source_key) VALUES (?, ?, ?, ?, ?, ?)",
          );
          for (const record of replacement.records) {
            insert.run(
              record.providerId,
              record.recordedAt,
              record.inputTokens,
              record.outputTokens,
              record.costUsd,
              replacement.sourceKey,
            );
          }
        });
      }),
    dailySourceState: (providerId, sourceKey) =>
      readSqlite("get daily cost usage source state", () => {
        assertProviderId(providerId);
        assertDailySourceKey(sourceKey);
        const row = reader
          .prepare(
            "SELECT availability, coverage FROM cost_usage_sources WHERE provider_id = ? AND source_key = ?",
          )
          .get(providerId, sourceKey) as Record<string, unknown> | undefined;
        return row === undefined ? undefined : decodeDailyCostUsageSourceState(row);
      }),
    list: (providerId, since, limit) =>
      readSqlite("list cost usage records", () => {
        assertProviderId(providerId);
        assertListBounds(since, limit);
        return queryRows(
          reader,
          "SELECT provider_id, recorded_at, input_tokens, output_tokens, cost_usd FROM cost_usage_records WHERE provider_id = ? AND recorded_at >= ? ORDER BY recorded_at, id",
          providerId,
          since,
          limit,
        ).map(decodeCostUsageRecord);
      }),
  };
  const retention: UsageRecordRetentionService = {
    prune: (request: UsageRecordRetentionRequest) =>
      queuedSqlite(queue, "prune usage records", async () => {
        assertUsageRecordRetentionRequest(request);
        if (request.historyProviderId !== undefined)
          assertProviderInstanceId(request.historyProviderId);
        if (request.costProviderId !== undefined) assertProviderId(request.costProviderId);
        let result: UsageRecordRetentionResult = {
          deletedHistoryRecords: 0,
          deletedCostUsageRecords: 0,
        };
        await inImmediateTransactionWithRetry(database, () => {
          result = {
            deletedHistoryRecords: deleteRecordsBefore(
              database,
              "history_records",
              request.before,
              request.historyProviderId,
            ),
            deletedCostUsageRecords: deleteRecordsBefore(
              database,
              "cost_usage_records",
              request.before,
              request.costProviderId,
            ),
          };
        });
        return result;
      }),
  };

  return {
    history,
    costs,
    retention,
    close: queuedSqlite(queue, "close SQLite persistence", () => {
      if (reader !== database) reader.close();
      database.close();
    }),
  };
};

const deleteRecordsBefore = (
  database: DatabaseSync,
  table: "history_records" | "cost_usage_records",
  before: number,
  providerId: string | undefined,
): number => {
  const statement =
    providerId === undefined
      ? database.prepare(`DELETE FROM ${table} WHERE recorded_at < ?`)
      : database.prepare(`DELETE FROM ${table} WHERE provider_id = ? AND recorded_at < ?`);
  if (providerId === undefined) statement.run(before);
  else statement.run(providerId, before);
  const row = database.prepare("SELECT changes() AS deleted_rows").get() as Record<string, unknown>;
  return readNaturalRowValue(row, "deleted_rows");
};

class SerializedDatabaseQueue {
  private tail: Promise<void> = Promise.resolve();

  run<Value>(operation: () => Value | Promise<Value>): Promise<Awaited<Value>> {
    const next = this.tail.then(operation, operation);
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next as Promise<Awaited<Value>>;
  }
}

const queuedSqlite = <Value>(
  queue: SerializedDatabaseQueue,
  operation: string,
  run: () => Value | Promise<Value>,
): Effect.Effect<Awaited<Value>, InfrastructureError> =>
  Effect.tryPromise({
    try: () => queue.run(run),
    catch: (error) =>
      new InfrastructureError(operation, `SQLite operation failed: ${operation}`, error),
  });

/**
 * Reads intentionally do not enter the writer FIFO. In WAL mode the dedicated
 * read-only connection has its own SQLite snapshot and does not acquire the
 * writer's transaction lock. JavaScript remains single-threaded per worker;
 * this separation is about database locking, not parallel JS execution.
 */
const readSqlite = <Value>(
  operation: string,
  run: () => Value,
): Effect.Effect<Value, InfrastructureError> =>
  Effect.try({
    try: run,
    catch: (error) =>
      new InfrastructureError(operation, `SQLite operation failed: ${operation}`, error),
  });

const inImmediateTransaction = (database: DatabaseSync, work: () => void): void => {
  database.exec("BEGIN IMMEDIATE");
  try {
    work();
    database.exec("COMMIT");
  } catch (error) {
    rollback(database);
    throw error;
  }
};

/**
 * `node:sqlite` waits synchronously for its busy timeout. That would stall
 * all messages in the dedicated worker, including independent WAL reads. For
 * write transactions we instead make short zero-timeout attempts and yield
 * between them, with the same five-second upper bound. The connection is
 * restored to the documented busy timeout before it is returned to callers.
 */
const inImmediateTransactionWithRetry = async (
  database: DatabaseSync,
  work: () => void,
): Promise<void> => {
  const deadline = Date.now() + SQLITE_BUSY_TIMEOUT_MS;
  database.exec("PRAGMA busy_timeout = 0");
  try {
    while (true) {
      try {
        inImmediateTransaction(database, work);
        return;
      } catch (error) {
        if (!isSqliteBusy(error) || Date.now() >= deadline) throw error;
        await waitForSqliteRetry(Math.min(25, Math.max(1, deadline - Date.now())));
      }
    }
  } finally {
    database.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  }
};

const isSqliteBusy = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { readonly code?: unknown; readonly message?: unknown };
  return /SQLITE_BUSY|database is locked/i.test(
    `${candidate.code ?? ""} ${candidate.message ?? ""}`,
  );
};

const waitForSqliteRetry = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const rollback = (database: DatabaseSync): void => {
  if (database.isTransaction) database.exec("ROLLBACK");
};

const ensureProvider = (database: DatabaseSync, providerId: string): void => {
  database.prepare("INSERT OR IGNORE INTO providers (provider_id) VALUES (?)").run(providerId);
};

const decodeHistoryRecord = (row: Record<string, unknown>): HistoryRecord => ({
  providerId: Schema.decodeUnknownSync(ProviderInstanceId)(readString(row, "provider_id")),
  recordedAt: readFiniteNumber(row, "recorded_at"),
  snapshot: Schema.decodeUnknownSync(UsageSnapshot)(JSON.parse(readString(row, "snapshot_json"))),
});

const decodeCostUsageRecord = (row: Record<string, unknown>): CostUsageRecord => ({
  providerId: Schema.decodeUnknownSync(ProviderId)(readString(row, "provider_id")),
  recordedAt: readFiniteNumber(row, "recorded_at"),
  inputTokens: readFiniteNumber(row, "input_tokens"),
  outputTokens: readFiniteNumber(row, "output_tokens"),
  costUsd: readFiniteNumber(row, "cost_usd"),
});

const decodeDailyCostUsageSourceState = (
  row: Record<string, unknown>,
): DailyCostUsageSourceState => {
  const availability = readString(row, "availability");
  const coverage = readString(row, "coverage");
  if (
    (availability !== "available" && availability !== "unavailable") ||
    (coverage !== "exact" && coverage !== "estimated")
  ) {
    throw new Error("Daily cost usage source state is invalid");
  }
  return { availability, coverage };
};

const assertCostUsageRecord = (record: CostUsageRecord): void => {
  assertProviderId(record.providerId);
  assertNatural(record.recordedAt, "recordedAt");
  assertNatural(record.inputTokens, "inputTokens");
  assertNatural(record.outputTokens, "outputTokens");
  if (!Number.isFinite(record.costUsd) || record.costUsd < 0) {
    throw new Error("costUsd must be a non-negative finite number");
  }
};

const assertDailyCostUsageReplacement = (replacement: DailyCostUsageReplacement): void => {
  assertProviderId(replacement.providerId);
  assertDailySourceKey(replacement.sourceKey);
  assertNatural(replacement.since, "daily cost usage since");
  assertNatural(replacement.until, "daily cost usage until");
  if (replacement.since > replacement.until) throw new Error("daily cost usage range is invalid");
  if (replacement.availability !== "available" && replacement.availability !== "unavailable") {
    throw new Error("daily cost usage availability is invalid");
  }
  if (replacement.coverage !== "exact" && replacement.coverage !== "estimated") {
    throw new Error("daily cost usage coverage is invalid");
  }
  if (replacement.availability === "unavailable" && replacement.records.length > 0) {
    throw new Error("unavailable daily cost usage cannot contain records");
  }
  const days = new Set<number>();
  for (const record of replacement.records) {
    assertCostUsageRecord(record);
    if (record.providerId !== replacement.providerId) {
      throw new Error("daily cost usage record crosses provider ownership");
    }
    if (record.recordedAt < replacement.since || record.recordedAt > replacement.until) {
      throw new Error("daily cost usage record is outside its replacement range");
    }
    if (days.has(record.recordedAt)) throw new Error("daily cost usage contains duplicate days");
    days.add(record.recordedAt);
  }
};

const assertLocalCostUsageScanCommit = (commit: LocalCostUsageScanCommit): void => {
  assertProviderId(commit.providerId);
  assertDailySourceKey(commit.sourceKey);
  assertLocalCostUsageScanCheckpointJson(commit.checkpointJson);
  if (commit.expectedCheckpointJson !== undefined) {
    assertLocalCostUsageScanCheckpointJson(commit.expectedCheckpointJson);
  }
  if (commit.records.length > 50_000) throw new Error("local cost usage scan has too many records");
  for (const record of commit.records) {
    assertCostUsageRecord(record);
    if (record.providerId !== commit.providerId) {
      throw new Error("local cost usage scan record crosses provider ownership");
    }
  }
};

const assertLocalCostUsageScanFamilyCommit = (commit: LocalCostUsageScanFamilyCommit): void => {
  assertProviderId(commit.providerId);
  assertDailySourceKey(commit.familyKey);
  if (!commit.familyKey.startsWith("family-v1:")) {
    throw new Error("local cost usage scan family key is invalid");
  }
  assertLocalCostUsageScanCheckpointJson(commit.manifestJson);
  if (commit.expectedManifestJson !== undefined) {
    assertLocalCostUsageScanCheckpointJson(commit.expectedManifestJson);
  }
  if (commit.members.length > 4_096 || commit.removals.length > 4_096) {
    throw new Error("local cost usage scan family has too many sources");
  }
  const sourceKeys = new Set<string>([commit.familyKey]);
  let records = 0;
  for (const member of commit.members) {
    assertLocalCostUsageScanCommit(member);
    if (member.providerId !== commit.providerId || member.reset !== true) {
      throw new Error("local cost usage scan family member is invalid");
    }
    if (member.sourceKey.startsWith("family-v1:")) {
      throw new Error("local cost usage scan family member is invalid");
    }
    if (sourceKeys.has(member.sourceKey)) {
      throw new Error("local cost usage scan family has duplicate source keys");
    }
    sourceKeys.add(member.sourceKey);
    records += member.records.length;
    if (records > 50_000) throw new Error("local cost usage scan family has too many records");
  }
  for (const removal of commit.removals) {
    assertDailySourceKey(removal.sourceKey);
    if (removal.expectedCheckpointJson !== undefined) {
      assertLocalCostUsageScanCheckpointJson(removal.expectedCheckpointJson);
    }
    if (sourceKeys.has(removal.sourceKey)) {
      throw new Error("local cost usage scan family has duplicate source keys");
    }
    sourceKeys.add(removal.sourceKey);
  }
  // A caller may delete only sources that its CAS-read manifest previously
  // owned. This turns the manifest into an ownership proof, rather than a
  // generic provider-wide delete capability.
  const previouslyOwned = familyManifestSourceKeys(commit.expectedManifestJson);
  if (commit.removals.length > 0 && previouslyOwned === undefined) {
    throw new Error("local cost usage scan family removals require a valid manifest");
  }
  if (commit.removals.some(({ sourceKey }) => !previouslyOwned?.has(sourceKey))) {
    throw new Error("local cost usage scan family removal is not manifest-owned");
  }
  const currentManifest = familyManifestSourceKeys(commit.manifestJson);
  if (currentManifest === undefined)
    throw new Error("local cost usage scan family manifest is invalid");
  if (
    currentManifest.size !== commit.members.length ||
    commit.members.some(
      (member) => currentManifest.get(member.sourceKey) !== checkpointHash(member.checkpointJson),
    )
  ) {
    throw new Error("local cost usage scan family manifest members are invalid");
  }
};

const familyManifestSourceKeys = (
  manifestJson: string | undefined,
): Map<string, string> | undefined => {
  if (manifestJson === undefined) return undefined;
  try {
    const decoded: unknown = JSON.parse(manifestJson);
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return undefined;
    const manifest = decoded as Record<string, unknown>;
    if (manifest.version !== 1 || manifest.scanner !== "codex-fork-family") return undefined;
    if (!Array.isArray(manifest.sourceKeys) || manifest.sourceKeys.length > 4_096) return undefined;
    if (
      typeof manifest.checkpointHashes !== "object" ||
      manifest.checkpointHashes === null ||
      Array.isArray(manifest.checkpointHashes)
    )
      return undefined;
    const sourceKeys = manifest.sourceKeys;
    const checkpointHashes = manifest.checkpointHashes as Record<string, unknown>;
    if (
      sourceKeys.some(
        (sourceKey) =>
          typeof sourceKey !== "string" ||
          !sourceKey.startsWith("jsonl-v1:codex:") ||
          sourceKey.length === 0 ||
          sourceKey.length > 120 ||
          sourceKey.includes("\u0000"),
      )
    ) {
      return undefined;
    }
    const keys = new Map<string, string>();
    for (const sourceKey of sourceKeys) {
      const hash = checkpointHashes[sourceKey];
      if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash) || keys.has(sourceKey)) {
        return undefined;
      }
      keys.set(sourceKey, hash);
    }
    return Object.keys(checkpointHashes).length === keys.size ? keys : undefined;
  } catch {
    return undefined;
  }
};

const checkpointHash = (checkpointJson: string): string =>
  createHash("sha256").update(checkpointJson).digest("hex");

const assertDailySourceKey = (sourceKey: string): void => {
  if (sourceKey.length === 0 || sourceKey.length > 120 || sourceKey.includes("\u0000")) {
    throw new Error("daily cost usage source key is invalid");
  }
};

const assertHistoryRecord = (record: HistoryRecord): void => {
  assertProviderInstanceId(record.providerId);
  assertNatural(record.recordedAt, "recordedAt");
  Schema.decodeUnknownSync(UsageSnapshot)(record.snapshot);
};

const assertListBounds = (since: number, limit: number | undefined): void => {
  assertNatural(since, "since");
  if (limit !== undefined) assertNatural(limit, "limit");
};

const assertNatural = (value: number, name: string): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
};

const queryRows = (
  database: DatabaseSync,
  query: string,
  providerId: string,
  since: number,
  limit: number | undefined,
): Array<Record<string, unknown>> =>
  limit === undefined
    ? (database.prepare(query).all(providerId, since) as Array<Record<string, unknown>>)
    : (database.prepare(`${query} LIMIT ?`).all(providerId, since, limit) as Array<
        Record<string, unknown>
      >);

const assertProviderId = (providerId: string): void => {
  Schema.decodeUnknownSync(ProviderId)(providerId);
};

const assertProviderInstanceId = (providerId: string): void => {
  Schema.decodeUnknownSync(ProviderInstanceId)(providerId);
};

const readString = (row: Record<string, unknown>, column: string): string => {
  const value = row[column];
  if (typeof value !== "string") throw new Error(`SQLite column ${column} is not a string`);
  return value;
};

const readFiniteNumber = (row: Record<string, unknown>, column: string): number => {
  const value = row[column];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`SQLite column ${column} is not a finite number`);
  }
  return value;
};

const readNaturalRowValue = (row: Record<string, unknown>, column: string): number => {
  const value = readFiniteNumber(row, column);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`SQLite column ${column} is not a non-negative safe integer`);
  }
  return value;
};
