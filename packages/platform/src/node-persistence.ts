import { backup, DatabaseSync } from "node:sqlite";
import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Effect, Schema } from "effect";
import {
  type ConfigRepositoryService,
  type CostUsageRecord,
  type CostUsageRepositoryService,
  type HistoryRecord,
  type HistoryRepositoryService,
  InfrastructureError,
} from "@codexbar/core";
import {
  CodexBarConfig,
  ProviderId,
  UsageSnapshot,
  type CodexBarConfig as CodexBarConfigValue,
} from "@codexbar/contracts";
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
        if (!options.readOnly) await chmod(options.databasePath, 0o600);
        configureConnection(database, options.readOnly ?? false);
        assertQuickCheck(database);
        if (!options.readOnly) {
          await applyMigrations(
            database,
            options.databasePath,
            options.migrations ?? NODE_PERSISTENCE_MIGRATIONS,
          );
          assertQuickCheck(database);
        }
      } catch (error) {
        database.close();
        throw error;
      }

      return makeRepositories(database);
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
export const makeNodeConfigRepository = (path: string): ConfigRepositoryService => {
  const files = makeNodePrivateFileStore();
  return {
    load: files.read(path).pipe(
      Effect.flatMap((content) => {
        if (content === undefined) return Effect.succeed(undefined);
        return Effect.try({
          try: () =>
            Schema.decodeUnknownSync(CodexBarConfig)(JSON.parse(new TextDecoder().decode(content))),
          catch: (error) =>
            new InfrastructureError(
              "read config",
              `Unable to validate config file: ${path}`,
              error,
            ),
        });
      }),
    ),
    save: (config: CodexBarConfigValue) =>
      Effect.try({
        try: () => {
          const validated = Schema.decodeUnknownSync(CodexBarConfig)(config);
          return new TextEncoder().encode(`${JSON.stringify(validated)}\n`);
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

const makeRepositories = (database: DatabaseSync): NodeSqlitePersistence => {
  const queue = new SerializedDatabaseQueue();
  const history: HistoryRepositoryService = {
    append: (record) =>
      queuedSqlite(queue, "append history record", () => {
        assertHistoryRecord(record);
        const snapshotJson = JSON.stringify(record.snapshot);
        if (snapshotJson === undefined) throw new Error("Usage snapshot is not JSON serializable");
        inImmediateTransaction(database, () => {
          ensureProvider(database, record.providerId);
          database
            .prepare(
              "INSERT INTO history_records (provider_id, recorded_at, snapshot_json) VALUES (?, ?, ?)",
            )
            .run(record.providerId, record.recordedAt, snapshotJson);
        });
      }),
    list: (providerId, since) =>
      queuedSqlite(queue, "list history records", () =>
        database
          .prepare(
            "SELECT provider_id, recorded_at, snapshot_json FROM history_records WHERE provider_id = ? AND recorded_at >= ? ORDER BY recorded_at, id",
          )
          .all(providerId, since)
          .map(decodeHistoryRecord),
      ),
  };
  const costs: CostUsageRepositoryService = {
    append: (record) =>
      queuedSqlite(queue, "append cost usage record", () => {
        assertCostUsageRecord(record);
        inImmediateTransaction(database, () => {
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
    list: (providerId, since) =>
      queuedSqlite(queue, "list cost usage records", () =>
        database
          .prepare(
            "SELECT provider_id, recorded_at, input_tokens, output_tokens, cost_usd FROM cost_usage_records WHERE provider_id = ? AND recorded_at >= ? ORDER BY recorded_at, id",
          )
          .all(providerId, since)
          .map(decodeCostUsageRecord),
      ),
  };

  return {
    history,
    costs,
    close: queuedSqlite(queue, "close SQLite persistence", () => database.close()),
  };
};

class SerializedDatabaseQueue {
  private tail: Promise<void> = Promise.resolve();

  run<Value>(operation: () => Value): Promise<Value> {
    const next = this.tail.then(operation, operation);
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

const queuedSqlite = <Value>(
  queue: SerializedDatabaseQueue,
  operation: string,
  run: () => Value,
): Effect.Effect<Value, InfrastructureError> =>
  Effect.tryPromise({
    try: () => queue.run(run),
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

const rollback = (database: DatabaseSync): void => {
  if (database.isTransaction) database.exec("ROLLBACK");
};

const ensureProvider = (database: DatabaseSync, providerId: string): void => {
  database.prepare("INSERT OR IGNORE INTO providers (provider_id) VALUES (?)").run(providerId);
};

const decodeHistoryRecord = (row: Record<string, unknown>): HistoryRecord => ({
  providerId: Schema.decodeUnknownSync(ProviderId)(readString(row, "provider_id")),
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
  for (const [name, value] of Object.entries({
    recordedAt: record.recordedAt,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    costUsd: record.costUsd,
  })) {
    if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  }
};

const assertHistoryRecord = (record: HistoryRecord): void => {
  assertProviderId(record.providerId);
  if (!Number.isFinite(record.recordedAt)) throw new Error("recordedAt must be a finite number");
  Schema.decodeUnknownSync(UsageSnapshot)(record.snapshot);
};

const assertProviderId = (providerId: string): void => {
  Schema.decodeUnknownSync(ProviderId)(providerId);
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
