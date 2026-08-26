import { Effect } from "effect";
import {
  InfrastructureError,
  type ConfigRepositoryService,
  type PersistedCodexBarConfig,
  type PersistedProviderConfig,
} from "@codexbar/core";
import type { ProviderId } from "@codexbar/contracts";
import type { TokenAccountMigrationLock } from "./token-account-vault-config.ts";

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
