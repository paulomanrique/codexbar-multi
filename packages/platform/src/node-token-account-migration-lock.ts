import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { Effect, Result, Semaphore } from "effect";
import { InfrastructureError } from "@codexbar/core";
import type { TokenAccountMigrationLock } from "./token-account-vault-config.ts";
import {
  makeNodePrivateDirectoryRestriction,
  makeNodePrivateFileRestriction,
} from "./node-private-path-security.ts";

const DEFAULT_ACQUIRE_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 50;

export interface NodeTokenAccountMigrationLockOptions {
  /** Injectable only for tests; production uses one per-user product namespace. */
  readonly lockPath?: string;
  readonly acquireTimeoutMs?: number;
  readonly retryDelayMs?: number;
  /** Injectable monotonic clock for deterministic timeout tests. */
  readonly now?: () => number;
  /** Injectable private-path seams; production uses the native ACL adapters. */
  readonly restrictDirectory?: (path: string) => Promise<void>;
  readonly restrictFile?: (path: string) => Promise<void>;
}

export const tokenAccountMigrationLockPath = (homeDirectory = homedir()): string =>
  join(homeDirectory, ".codexbar-multi", "token-account-migration.sqlite");

export const makeNodeTokenAccountMigrationLock = (
  options: NodeTokenAccountMigrationLockOptions,
): TokenAccountMigrationLock => {
  const lockPath = options.lockPath ?? tokenAccountMigrationLockPath();
  const acquireTimeoutMs = options.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  if (!Number.isFinite(acquireTimeoutMs) || acquireTimeoutMs < 0) {
    throw new RangeError("Token account migration lock timeout must be non-negative.");
  }
  if (!Number.isFinite(retryDelayMs) || retryDelayMs <= 0) {
    throw new RangeError("Token account migration lock retry delay must be positive.");
  }
  const restrictDirectory = options.restrictDirectory ?? makeNodePrivateDirectoryRestriction();
  const restrictFile = options.restrictFile ?? makeNodePrivateFileRestriction();
  const now = options.now ?? (() => performance.now());
  const semaphore = Semaphore.makeUnsafe(1);

  return {
    runExclusive: (operation) =>
      semaphore.withPermits(1)(
        Effect.acquireUseRelease(
          openLockDatabase({
            lockPath,
            restrictDirectory,
            restrictFile,
          }),
          (database) =>
            acquireSqliteTransaction(database, {
              acquireTimeoutMs,
              retryDelayMs,
              now,
            }).pipe(Effect.flatMap(() => operation)),
          releaseSqliteLock,
        ),
      ),
  };
};

interface SqliteLockAcquireOptions {
  readonly lockPath: string;
  readonly restrictDirectory: (path: string) => Promise<void>;
  readonly restrictFile: (path: string) => Promise<void>;
}

const openLockDatabase = (
  options: SqliteLockAcquireOptions,
): Effect.Effect<DatabaseSync, InfrastructureError> =>
  Effect.tryPromise({
    try: async () => {
      let database: DatabaseSync | undefined;
      try {
        const directory = dirname(options.lockPath);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await options.restrictDirectory(directory);
        database = new DatabaseSync(options.lockPath, {
          allowExtension: false,
          enableForeignKeyConstraints: false,
          timeout: 0,
        });
        await options.restrictFile(options.lockPath);
        database.exec("PRAGMA busy_timeout = 0");
        assertQuickCheck(database);
        return database;
      } catch (error) {
        if (database !== undefined) {
          try {
            database.close();
          } catch (closeError) {
            throw new AggregateError([error, closeError], "Unable to prepare SQLite lock.");
          }
        }
        throw error;
      }
    },
    catch: (error) => lockInfrastructureError("prepare token account migration lock", error),
  });

interface SqliteTransactionAcquireOptions {
  readonly acquireTimeoutMs: number;
  readonly retryDelayMs: number;
  readonly now: () => number;
}

const acquireSqliteTransaction = (
  database: DatabaseSync,
  options: SqliteTransactionAcquireOptions,
): Effect.Effect<void, InfrastructureError> =>
  Effect.gen(function* () {
    const deadline = options.now() + options.acquireTimeoutMs;
    while (true) {
      const attempt = yield* Effect.result(
        Effect.try({
          try: () => database.exec("BEGIN IMMEDIATE"),
          catch: (error) => lockInfrastructureError("acquire token account migration lock", error),
        }),
      );
      if (Result.isSuccess(attempt)) return;
      if (!isSqliteBusy(attempt.failure.causeValue)) {
        return yield* Effect.fail(attempt.failure);
      }

      const remaining = deadline - options.now();
      if (remaining <= 0) {
        return yield* Effect.fail(
          lockInfrastructureError(
            "acquire token account migration lock",
            new Error("Timed out while waiting for SQLite transaction lock."),
          ),
        );
      }
      yield* Effect.sleep(Math.min(options.retryDelayMs, remaining));
    }
  });

const releaseSqliteLock = (database: DatabaseSync): Effect.Effect<void, InfrastructureError> =>
  Effect.uninterruptible(
    Effect.try({
      try: () => {
        let rollbackError: unknown;
        try {
          if (database.isTransaction) database.exec("ROLLBACK");
        } catch (error) {
          rollbackError = error;
        }
        try {
          database.close();
        } catch (closeError) {
          throw rollbackError === undefined
            ? closeError
            : new AggregateError([rollbackError, closeError], "Unable to release SQLite lock.");
        }
        if (rollbackError !== undefined) throw rollbackError;
      },
      catch: (error) => lockInfrastructureError("release token account migration lock", error),
    }),
  );

const assertQuickCheck = (database: DatabaseSync): void => {
  const rows = database.prepare("PRAGMA quick_check").all();
  if (rows.length !== 1 || rows[0]?.quick_check !== "ok") {
    throw new Error("SQLite quick_check failed for token account migration lock.");
  }
};

const isSqliteBusy = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { readonly code?: unknown; readonly message?: unknown };
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked|lock busy/iu.test(
    `${candidate.code ?? ""} ${candidate.message ?? ""}`,
  );
};

const lockInfrastructureError = (operation: string, cause: unknown): InfrastructureError =>
  new InfrastructureError(
    operation,
    "Token account migration lock is unavailable.",
    sanitizeLockCause(cause),
  );

const sanitizeLockCause = (cause: unknown): Error => {
  if (typeof cause !== "object" || cause === null) return new Error("Unknown lock failure.");
  const candidate = cause as { readonly code?: unknown; readonly message?: unknown };
  const code = typeof candidate.code === "string" ? ` (${candidate.code})` : "";
  const message = typeof candidate.message === "string" ? candidate.message : "Lock failure.";
  if (isSqliteBusy(cause)) return new Error(`SQLite lock busy${code}.`);
  if (/quick_check/iu.test(message)) return new Error("SQLite lock integrity check failed.");
  return new Error(`SQLite lock operation failed${code}.`);
};
