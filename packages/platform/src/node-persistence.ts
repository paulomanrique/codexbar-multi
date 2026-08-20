import { backup, DatabaseSync } from "node:sqlite";
import { chmod, mkdir } from "node:fs/promises";
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
  type HistoryRecord,
  type HistoryRepositoryService,
  InfrastructureError,
  type UsageRecordRetentionRequest,
  type UsageRecordRetentionResult,
  type UsageRecordRetentionService,
  assertUsageRecordRetentionRequest,
} from "@codexbar/core";
import { ProviderId, ProviderInstanceId, UsageSnapshot } from "@codexbar/contracts";
import { makeNodePrivateFileStore } from "./node.ts";

const SQLITE_BUSY_TIMEOUT_MS = 5_000;

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
      await chmod(path, 0o600);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
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
      await chmod(backupPath, 0o600);
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

const assertCostUsageRecord = (record: CostUsageRecord): void => {
  assertProviderId(record.providerId);
  assertNatural(record.recordedAt, "recordedAt");
  assertNatural(record.inputTokens, "inputTokens");
  assertNatural(record.outputTokens, "outputTokens");
  if (!Number.isFinite(record.costUsd) || record.costUsd < 0) {
    throw new Error("costUsd must be a non-negative finite number");
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
