import { Effect } from "effect";
import {
  InfrastructureError,
  type ConfigRepositoryService,
  type CredentialStoreService,
  type PersistedCodexBarConfig,
  type PersistedProviderConfig,
} from "@codexbar/core";
import type { ProviderId } from "@codexbar/contracts";
import type { TokenAccountMigrationLock } from "./token-account-vault-config.ts";
import { browserSessionCredentialKeys } from "./account-scoped-browser-session.ts";

export interface BrowserSessionCleanupTarget {
  readonly providerId: ProviderId;
  readonly accountId: string;
}

export interface BrowserSessionCleanupAdapter {
  readonly cleanup: (
    target: BrowserSessionCleanupTarget,
  ) => Effect.Effect<void, InfrastructureError>;
}

const cleanupError = (operation: string, cause: unknown): InfrastructureError =>
  new InfrastructureError(
    operation,
    "Browser-session cleanup did not complete. Recovery will retry without exposing the session.",
    cause,
  );

const codexProvider = (config: PersistedCodexBarConfig): PersistedProviderConfig | undefined =>
  config.providers.find((provider) => provider.id === "codex");

export const pendingBrowserSessionCleanupTargets = (
  config: PersistedCodexBarConfig | undefined,
): readonly BrowserSessionCleanupTarget[] =>
  codexProvider(
    config ?? { version: 1, providers: [] },
  )?.pendingBrowserSessionCleanup?.accountIds.map((accountId) => ({
    providerId: "codex",
    accountId,
  })) ?? [];

export const browserSessionCleanupIsPending = (
  config: PersistedCodexBarConfig | undefined,
  providerId: ProviderId,
  accountId: string,
): boolean =>
  pendingBrowserSessionCleanupTargets(config).some(
    (target) => target.providerId === providerId && target.accountId === accountId,
  );

const withPendingCleanup = (
  config: PersistedCodexBarConfig,
  accountId: string,
): PersistedCodexBarConfig => ({
  ...config,
  providers: config.providers.map((provider) => {
    if (provider.id !== "codex") return provider;
    const current = provider.pendingBrowserSessionCleanup?.accountIds ?? [];
    if (current.includes(accountId)) return provider;
    return {
      ...provider,
      pendingBrowserSessionCleanup: {
        version: 1,
        accountIds: [...current, accountId],
      },
    };
  }),
});

const withoutPendingCleanup = (
  config: PersistedCodexBarConfig,
  accountId: string,
): PersistedCodexBarConfig => ({
  ...config,
  providers: config.providers.map((provider) => {
    if (provider.id !== "codex") return provider;
    const marker = provider.pendingBrowserSessionCleanup;
    if (marker === undefined || !marker.accountIds.includes(accountId)) return provider;
    const accountIds = marker.accountIds.filter((candidate) => candidate !== accountId);
    if (accountIds.length > 0) {
      return {
        ...provider,
        pendingBrowserSessionCleanup: { version: 1, accountIds },
      };
    }
    const { pendingBrowserSessionCleanup: _pending, ...cleared } = provider;
    return cleared;
  }),
});

export interface BrowserSessionCredentialPublication {
  readonly key: string;
  readonly value: string;
}

const loadRaw = (
  repository: ConfigRepositoryService,
  operation: string,
): Effect.Effect<PersistedCodexBarConfig | undefined, InfrastructureError> =>
  repository.load.pipe(
    Effect.mapError((error) => cleanupError(operation, new Error(error.operation))),
  );

const saveRaw = (
  repository: ConfigRepositoryService,
  config: PersistedCodexBarConfig,
  operation: string,
): Effect.Effect<void, InfrastructureError> =>
  repository
    .save(config)
    .pipe(Effect.mapError((error) => cleanupError(operation, new Error(error.operation))));

/**
 * Durably fences one Codex browser session before any destructive cleanup.
 * The marker contains only a logical account ID; vault keys and Electron
 * partition names remain derived host details.
 */
export const enqueueCodexBrowserSessionCleanup = (
  repository: ConfigRepositoryService,
  lock: TokenAccountMigrationLock,
  accountId: string,
): Effect.Effect<PersistedCodexBarConfig, InfrastructureError> =>
  lock.runExclusive(
    Effect.gen(function* () {
      const current = yield* loadRaw(repository, "load browser-session cleanup journal");
      if (current === undefined) {
        return yield* Effect.fail(
          cleanupError("stage browser-session cleanup", new Error("Config is missing.")),
        );
      }
      const provider = codexProvider(current);
      if (provider === undefined) {
        return yield* Effect.fail(
          cleanupError("stage browser-session cleanup", new Error("Codex provider is missing.")),
        );
      }
      const accountExists =
        provider.tokenAccounts?.accounts.some((account) => account.id === accountId) === true;
      if (!accountExists) {
        return yield* Effect.fail(
          cleanupError(
            "stage browser-session cleanup",
            new Error("Codex account is not selectable."),
          ),
        );
      }
      if (provider.pendingBrowserSessionCleanup?.accountIds.includes(accountId) === true) {
        return current;
      }
      const staged = withPendingCleanup(current, accountId);
      yield* saveRaw(repository, staged, "stage browser-session cleanup");
      return staged;
    }),
  );

const requireCodexCleanupAccount = (
  current: PersistedCodexBarConfig | undefined,
  accountId: string,
  operation: string,
): Effect.Effect<PersistedCodexBarConfig, InfrastructureError> => {
  if (current === undefined) {
    return Effect.fail(cleanupError(operation, new Error("Config is missing.")));
  }
  const provider = codexProvider(current);
  if (provider === undefined) {
    return Effect.fail(cleanupError(operation, new Error("Codex provider is missing.")));
  }
  if (provider.tokenAccounts?.accounts.some((account) => account.id === accountId) !== true) {
    return Effect.fail(cleanupError(operation, new Error("Codex account is not selectable.")));
  }
  return Effect.succeed(current);
};

const rollbackBrowserSessionCredential = (
  credentials: CredentialStoreService,
  publication: BrowserSessionCredentialPublication,
  previous: string | undefined,
): Effect.Effect<void, InfrastructureError> =>
  Effect.gen(function* () {
    const current = yield* credentials.read(publication.key);
    if (current === publication.value) {
      if (previous === undefined) yield* credentials.remove(publication.key);
      else yield* credentials.write(publication.key, previous);
    } else if (current !== previous) {
      return yield* Effect.fail(
        cleanupError(
          "rollback browser-session publication",
          new Error("Credential changed outside the serialized publication."),
        ),
      );
    }
    const restored = yield* credentials.read(publication.key);
    if (restored !== previous) {
      return yield* Effect.fail(
        cleanupError(
          "rollback browser-session publication",
          new Error("Credential rollback could not be verified."),
        ),
      );
    }
  });

/**
 * Begin a login only when neither the current opaque key nor its pre-opaque
 * legacy key exists. The check and durable marker share the token-account lock,
 * so a reconnect can never overwrite a usable prior exported session.
 */
export const stageCodexBrowserSessionLoginFence = (
  repository: ConfigRepositoryService,
  lock: TokenAccountMigrationLock,
  credentials: CredentialStoreService,
  accountId: string,
): Effect.Effect<void, InfrastructureError> =>
  lock.runExclusive(
    Effect.gen(function* () {
      const current = yield* loadRaw(repository, "load browser-session login state").pipe(
        Effect.flatMap((config) =>
          requireCodexCleanupAccount(config, accountId, "stage browser-session login"),
        ),
      );
      if (browserSessionCleanupIsPending(current, "codex", accountId)) {
        return yield* Effect.fail(
          cleanupError(
            "stage browser-session login",
            new Error("Browser-session cleanup is already pending."),
          ),
        );
      }
      for (const key of browserSessionCredentialKeys("codex", accountId)) {
        if ((yield* credentials.read(key)) !== undefined) {
          return yield* Effect.fail(
            cleanupError(
              "stage browser-session login",
              new Error("A browser-session credential already exists."),
            ),
          );
        }
      }
      yield* saveRaw(
        repository,
        withPendingCleanup(current, accountId),
        "stage browser-session login",
      );
    }),
  );

/**
 * Publish an already remotely validated candidate behind the durable write-ahead
 * cleanup fence staged before the login window opened. The fence intentionally remains after this function succeeds;
 * the desktop account controller removes it only after its final roster/cancel
 * check. A crash at any earlier point therefore makes startup delete, never use,
 * the candidate.
 *
 * The callback runs before and after keyring publication while the shared token
 * account lock is held. It must verify the expected roster and cancellation
 * state without performing network I/O.
 */
export const stageValidatedCodexBrowserSessionCredential = <Error, Requirements>(
  repository: ConfigRepositoryService,
  lock: TokenAccountMigrationLock,
  credentials: CredentialStoreService,
  accountId: string,
  publication: BrowserSessionCredentialPublication,
  authorize: (config: PersistedCodexBarConfig) => Effect.Effect<void, Error, Requirements>,
): Effect.Effect<void, InfrastructureError | Error, Requirements> =>
  lock.runExclusive(
    Effect.gen(function* () {
      const current = yield* loadRaw(repository, "load browser-session publication state").pipe(
        Effect.flatMap((config) =>
          requireCodexCleanupAccount(config, accountId, "stage browser-session publication"),
        ),
      );
      if (!browserSessionCleanupIsPending(current, "codex", accountId)) {
        return yield* Effect.fail(
          cleanupError(
            "stage browser-session publication",
            new Error("Browser-session publication fence is missing."),
          ),
        );
      }
      yield* authorize(current);
      const staged = current;

      for (const key of browserSessionCredentialKeys("codex", accountId)) {
        if ((yield* credentials.read(key)) !== undefined) {
          return yield* Effect.fail(
            cleanupError(
              "publish browser-session credential",
              new Error("A credential appeared after the login fence was staged."),
            ),
          );
        }
      }
      const previous = undefined;
      const published = yield* Effect.result(
        Effect.gen(function* () {
          yield* credentials.write(publication.key, publication.value);
          const persisted = yield* credentials.read(publication.key);
          if (persisted !== publication.value) {
            return yield* Effect.fail(
              cleanupError(
                "publish browser-session credential",
                new Error("Credential readback did not match."),
              ),
            );
          }
          yield* authorize(current);
        }),
      );
      if (published._tag === "Success") return;

      const rolledBack = yield* Effect.result(
        rollbackBrowserSessionCredential(credentials, publication, previous),
      );
      if (rolledBack._tag === "Failure") return yield* Effect.fail(rolledBack.failure);
      yield* saveRaw(
        repository,
        withoutPendingCleanup(staged, accountId),
        "rollback browser-session publication fence",
      );
      return yield* Effect.fail(published.failure);
    }),
  );

/** Remove only the write-ahead fence after the host repeats authorization. */
export const commitCodexBrowserSessionCredential = <Error, Requirements>(
  repository: ConfigRepositoryService,
  lock: TokenAccountMigrationLock,
  accountId: string,
  authorize: (config: PersistedCodexBarConfig) => Effect.Effect<void, Error, Requirements>,
): Effect.Effect<void, InfrastructureError | Error, Requirements> =>
  lock.runExclusive(
    Effect.gen(function* () {
      const current = yield* loadRaw(repository, "load browser-session publication fence").pipe(
        Effect.flatMap((config) =>
          requireCodexCleanupAccount(config, accountId, "commit browser-session publication"),
        ),
      );
      if (!browserSessionCleanupIsPending(current, "codex", accountId)) {
        return yield* Effect.fail(
          cleanupError(
            "commit browser-session publication",
            new Error("Browser-session publication fence is missing."),
          ),
        );
      }
      yield* authorize(current);
      yield* saveRaw(
        repository,
        withoutPendingCleanup(current, accountId),
        "commit browser-session publication",
      );
    }),
  );

const acknowledgeCleanup = (
  repository: ConfigRepositoryService,
  lock: TokenAccountMigrationLock,
  target: BrowserSessionCleanupTarget,
): Effect.Effect<void, InfrastructureError> =>
  lock.runExclusive(
    Effect.gen(function* () {
      const current = yield* loadRaw(repository, "reload browser-session cleanup journal");
      if (
        current === undefined ||
        !browserSessionCleanupIsPending(current, target.providerId, target.accountId)
      ) {
        return;
      }
      const next = withoutPendingCleanup(current, target.accountId);
      yield* saveRaw(repository, next, "acknowledge browser-session cleanup");
    }),
  );

/**
 * Replays every queued cleanup idempotently. Cleanup happens outside the config
 * lock; acknowledgement reacquires it and removes only the completed account,
 * preserving work concurrently appended by another CLI/desktop process.
 */
export const drainPendingBrowserSessionCleanups = (
  repository: ConfigRepositoryService,
  lock: TokenAccountMigrationLock,
  adapter: BrowserSessionCleanupAdapter,
): Effect.Effect<void, InfrastructureError> =>
  lock.runExclusive(loadRaw(repository, "load browser-session cleanup journal")).pipe(
    Effect.map(pendingBrowserSessionCleanupTargets),
    Effect.flatMap((targets) =>
      Effect.forEach(
        targets,
        (target) =>
          adapter.cleanup(target).pipe(
            Effect.mapError((error) =>
              cleanupError("clean browser session", new Error(error.operation)),
            ),
            Effect.flatMap(() => acknowledgeCleanup(repository, lock, target)),
            Effect.result,
          ),
        { concurrency: 1 },
      ),
    ),
    Effect.flatMap((results) => {
      const failure = results.find((result) => result._tag === "Failure");
      return failure?.failure === undefined ? Effect.void : Effect.fail(failure.failure);
    }),
  );
