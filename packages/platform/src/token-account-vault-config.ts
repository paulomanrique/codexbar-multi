import { Effect } from "effect";
import {
  ClassifiedFetchFailure,
  claudeSelectedTokenAccountPlanUtilizationAccountKey,
  InfrastructureError,
  sha256Hex,
  type ConfigRepositoryService,
  type CredentialStoreService,
  type PersistedCodexBarConfig,
  type PersistedProviderConfig,
} from "@codexbar/core";
import { PROVIDER_IDS, type ProviderId, type ProviderTokenAccount } from "@codexbar/contracts";
import { tokenAccountSupportForProvider } from "@codexbar/providers";
import {
  parseAntigravityOAuthCredentialValue,
  resolveAntigravityCredentialEmail,
} from "@codexbar/providers/providers/antigravity";
import { openCodeRequestCookieHeader } from "@codexbar/providers/providers/open-code-cookie";
import { manusSessionToken } from "@codexbar/providers/providers/manus";
import { normalizeMiniMaxCookieCredential } from "@codexbar/providers/providers/minimax-credential";
import { canonicalFactoryManualCredential } from "@codexbar/providers/providers/factory";
import { normalizeOllamaTokenAccountHeader } from "@codexbar/providers/providers/ollama";
import { normalizeQoderManualCredential } from "@codexbar/providers/providers/qoder";
import { normalizeStepFunToken } from "@codexbar/providers/providers/stepfun";
import type { FirstPartySelectedAccount } from "./first-party-runtime.ts";
import { parseNodeCodexAuthJson } from "./node-codex-credential.ts";

export interface TokenAccountMigrationLock {
  runExclusive<A, E, R>(
    operation: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | InfrastructureError, R>;
}

export const tokenAccountVaultKey = (providerId: string, accountId: string): string =>
  `token-account/v1/${sha256Hex(`${providerId}:${accountId}`)}`;

const hasOwnToken = (account: object): boolean =>
  Object.prototype.hasOwnProperty.call(account, "token");

const hasDuplicateAccountIds = (accounts: readonly { readonly id: string }[]): boolean => {
  const ids = new Set<string>();
  for (const account of accounts) {
    if (ids.has(account.id)) return true;
    ids.add(account.id);
  }
  return false;
};

const firstPartyProviderIds = new Set<string>(PROVIDER_IDS);

const vaultError = (operation: string, cause: unknown): InfrastructureError =>
  new InfrastructureError(
    operation,
    "Token account vault migration failed without modifying plaintext config.",
    cause,
  );

const saveError = (cause: unknown): InfrastructureError =>
  new InfrastructureError("save config", "Config contains legacy token account secrets.", cause);

const invalidMetadataError = (cause: unknown): InfrastructureError =>
  new InfrastructureError("validate token accounts", "Token account metadata is invalid.", cause);

const selectedAccountFailure = (message: string): ClassifiedFetchFailure =>
  new ClassifiedFetchFailure("missing-credential", message);

const metadataOnlyTokenAccounts = (provider: PersistedProviderConfig): PersistedProviderConfig => {
  const tokenAccounts = provider.tokenAccounts;
  if (tokenAccounts === undefined || tokenAccounts.version !== 1) return provider;
  return {
    ...provider,
    tokenAccounts: {
      version: 2,
      activeIndex: tokenAccounts.activeIndex,
      accounts: tokenAccounts.accounts.map(({ token: _token, ...account }) => account),
    },
  };
};

const containsLegacyTokenAccountData = (config: PersistedCodexBarConfig): boolean =>
  config.providers.some((provider) => provider.tokenAccounts?.version === 1);

const containsPendingTokenAccountDeletion = (config: PersistedCodexBarConfig): boolean =>
  config.providers.some((provider) => provider.pendingTokenAccountDeletion !== undefined);

const containsPendingTokenAccountAddition = (config: PersistedCodexBarConfig): boolean =>
  config.providers.some((provider) => provider.pendingTokenAccountAddition !== undefined);

const validBrowserSessionCleanupMarker = (provider: PersistedProviderConfig): boolean => {
  const marker = provider.pendingBrowserSessionCleanup;
  if (marker === undefined) return true;
  if (provider.id !== "codex" || marker.version !== 1) return false;
  if (marker.accountIds.length === 0 || marker.accountIds.length > 256) return false;
  const unique = new Set(marker.accountIds);
  return (
    unique.size === marker.accountIds.length &&
    marker.accountIds.every((accountId) => validMetadataString(accountId, false))
  );
};

const validMetadataString = (value: string, allowEmpty: boolean): boolean =>
  (allowEmpty || value.length > 0) && value.length <= 256 && !/\p{Cc}/u.test(value);

const validPendingAccount = (account: ProviderTokenAccount): boolean =>
  !hasOwnToken(account) &&
  validMetadataString(account.id, false) &&
  validMetadataString(account.label, true) &&
  Number.isFinite(account.addedAt) &&
  (account.lastUsed === undefined || Number.isFinite(account.lastUsed)) &&
  [
    account.externalIdentifier,
    account.usageScope,
    account.organizationId,
    account.workspaceID,
  ].every((value) => value === undefined || validMetadataString(value, true));

const assertMetadataOnlyV2 = (config: PersistedCodexBarConfig): InfrastructureError | undefined => {
  for (const provider of config.providers) {
    const tokenAccounts = provider.tokenAccounts;
    const pendingAddition = provider.pendingTokenAccountAddition;
    const pending = provider.pendingTokenAccountDeletion;
    if (!validBrowserSessionCleanupMarker(provider)) {
      return invalidMetadataError(new Error("Browser-session cleanup metadata is invalid."));
    }
    if (pendingAddition !== undefined && pending !== undefined) {
      return invalidMetadataError(
        new Error("A provider cannot add and delete token accounts in the same recovery state."),
      );
    }
    if (pendingAddition !== undefined && provider.id !== "codex") {
      return invalidMetadataError(
        new Error("Only Codex token-account addition recovery is supported."),
      );
    }
    if (
      pendingAddition !== undefined &&
      (!validPendingAccount(pendingAddition.account) ||
        !/^[a-f0-9]{64}$/u.test(pendingAddition.credentialSha256))
    ) {
      return invalidMetadataError(new Error("Pending token-account addition metadata is invalid."));
    }
    if (pending !== undefined && !firstPartyProviderIds.has(provider.id)) {
      return invalidMetadataError(
        new Error("Plugin token-account deletion recovery is not supported."),
      );
    }
    if (tokenAccounts === undefined) continue;
    if (tokenAccounts.version !== 2) {
      return saveError(new Error("Legacy token account data cannot be saved."));
    }
    if (tokenAccounts.accounts.some((account) => hasOwnToken(account))) {
      return saveError(new Error("Token account metadata cannot contain secrets."));
    }
    if (hasDuplicateAccountIds(tokenAccounts.accounts)) {
      return invalidMetadataError(new Error("Token account IDs must be unique per provider."));
    }
    if (
      pendingAddition !== undefined &&
      tokenAccounts.accounts.some((account) => account.id === pendingAddition.account.id)
    ) {
      return invalidMetadataError(
        new Error("A pending token-account addition must not already be selectable."),
      );
    }
    if (pending !== undefined) {
      if (tokenAccounts.accounts.some((account) => account.id === pending.accountId)) {
        return invalidMetadataError(
          new Error("A pending token-account deletion must not remain selectable."),
        );
      }
    }
  }
  return undefined;
};

const tokenAccountLifecycleError = (operation: string, cause: unknown): InfrastructureError =>
  new InfrastructureError(
    operation,
    "Token account credential lifecycle did not complete. Recovery will retry without exposing the credential.",
    cause,
  );

const removeAndVerifyTokenAccountCredential = (
  providerId: string,
  accountId: string,
  credentials: CredentialStoreService,
): Effect.Effect<void, InfrastructureError> => {
  const key = tokenAccountVaultKey(providerId, accountId);
  return credentials.remove(key).pipe(
    Effect.mapError((error) =>
      tokenAccountLifecycleError("remove token account credential", new Error(error.operation)),
    ),
    Effect.flatMap(() =>
      credentials
        .read(key)
        .pipe(
          Effect.mapError((error) =>
            tokenAccountLifecycleError(
              "verify token account credential removal",
              new Error(error.operation),
            ),
          ),
        ),
    ),
    Effect.flatMap((remaining) =>
      remaining === undefined
        ? Effect.void
        : Effect.fail(
            tokenAccountLifecycleError(
              "verify token account credential removal",
              new Error("Credential remained available after removal."),
            ),
          ),
    ),
  );
};

const clearPendingTokenAccountDeletions = (
  config: PersistedCodexBarConfig,
): PersistedCodexBarConfig => ({
  ...config,
  providers: config.providers.map((provider) => {
    if (provider.pendingTokenAccountDeletion === undefined) return provider;
    const { pendingTokenAccountDeletion: _pending, ...cleared } = provider;
    return cleared;
  }),
});

const reconcilePendingTokenAccountDeletions = (
  config: PersistedCodexBarConfig,
  repository: ConfigRepositoryService,
  credentials: CredentialStoreService,
): Effect.Effect<PersistedCodexBarConfig, InfrastructureError> => {
  const pending = config.providers.flatMap((provider) =>
    provider.pendingTokenAccountDeletion === undefined
      ? []
      : [{ providerId: provider.id, accountId: provider.pendingTokenAccountDeletion.accountId }],
  );
  if (pending.length === 0) return Effect.succeed(config);
  return Effect.forEach(
    pending,
    ({ providerId, accountId }) =>
      removeAndVerifyTokenAccountCredential(providerId, accountId, credentials),
    { concurrency: 1, discard: true },
  ).pipe(
    Effect.flatMap(() => {
      const recovered = clearPendingTokenAccountDeletions(config);
      return repository.save(recovered).pipe(
        Effect.mapError((error) =>
          tokenAccountLifecycleError(
            "save token account deletion recovery",
            new Error(error.operation),
          ),
        ),
        Effect.as(recovered),
      );
    }),
  );
};

const reconcilePendingTokenAccountAdditions = (
  config: PersistedCodexBarConfig,
  repository: ConfigRepositoryService,
  credentials: CredentialStoreService,
): Effect.Effect<PersistedCodexBarConfig, InfrastructureError> => {
  if (!containsPendingTokenAccountAddition(config)) return Effect.succeed(config);
  return Effect.gen(function* () {
    const providers: PersistedProviderConfig[] = [];
    for (const provider of config.providers) {
      const pending = provider.pendingTokenAccountAddition;
      if (pending === undefined) {
        providers.push(provider);
        continue;
      }
      const credential = yield* credentials
        .read(tokenAccountVaultKey(provider.id, pending.account.id))
        .pipe(
          Effect.mapError((error) =>
            tokenAccountLifecycleError(
              "read pending token account credential",
              new Error(error.operation),
            ),
          ),
        );
      const { pendingTokenAccountAddition: _pending, ...providerBase } = provider;
      if (credential === undefined) {
        // A crash before the vault write aborts an unpublished addition.
        providers.push(providerBase);
        continue;
      }
      if (sha256Hex(credential) !== pending.credentialSha256) {
        return yield* Effect.fail(
          tokenAccountLifecycleError(
            "verify pending token account credential",
            new Error("Credential readback did not match the staged fingerprint."),
          ),
        );
      }
      const currentAccounts = provider.tokenAccounts?.accounts ?? [];
      if (currentAccounts.some((account) => account.id === pending.account.id)) {
        return yield* Effect.fail(
          invalidMetadataError(new Error("Pending token-account ID already exists in the roster.")),
        );
      }
      const accounts = [...currentAccounts, pending.account];
      const currentActiveIndex = Math.min(
        Math.max(provider.tokenAccounts?.activeIndex ?? 0, 0),
        Math.max(currentAccounts.length - 1, 0),
      );
      providers.push({
        ...providerBase,
        tokenAccounts: {
          version: 2,
          accounts,
          activeIndex: pending.makeActive ? accounts.length - 1 : currentActiveIndex,
        },
      });
    }
    const recovered: PersistedCodexBarConfig = { ...config, providers };
    yield* repository
      .save(recovered)
      .pipe(
        Effect.mapError((error) =>
          tokenAccountLifecycleError(
            "save token account addition recovery",
            new Error(error.operation),
          ),
        ),
      );
    return recovered;
  });
};

const migrateTokenAccountsToVault = (
  config: PersistedCodexBarConfig,
  repository: ConfigRepositoryService,
  credentials: CredentialStoreService,
): Effect.Effect<PersistedCodexBarConfig, InfrastructureError> =>
  Effect.gen(function* () {
    const secrets: Array<{ readonly key: string; readonly value: string }> = [];
    const seen = new Set<string>();
    for (const provider of config.providers) {
      if (provider.tokenAccounts?.version !== 1) continue;
      if (!firstPartyProviderIds.has(provider.id)) {
        return yield* Effect.fail(
          vaultError(
            "migrate token accounts",
            new Error("Plugin token-account migration is not supported."),
          ),
        );
      }
      for (const account of provider.tokenAccounts.accounts) {
        const key = tokenAccountVaultKey(provider.id, account.id);
        if (seen.has(key)) {
          return yield* Effect.fail(
            vaultError("migrate token accounts", new Error("Duplicate token account key.")),
          );
        }
        seen.add(key);
        secrets.push({ key, value: account.token ?? "" });
      }
    }

    const missing: Array<{ readonly key: string; readonly value: string }> = [];
    for (const secret of secrets) {
      const existing = yield* credentials
        .read(secret.key)
        .pipe(Effect.mapError((error) => vaultError("read token account credential", error)));
      if (existing === undefined) {
        missing.push(secret);
      } else if (existing !== secret.value) {
        return yield* Effect.fail(
          vaultError(
            "migrate token accounts",
            new Error("Existing token account credential differs."),
          ),
        );
      }
    }

    for (const secret of missing) {
      yield* credentials
        .write(secret.key, secret.value)
        .pipe(Effect.mapError((error) => vaultError("write token account credential", error)));
      const verified = yield* credentials
        .read(secret.key)
        .pipe(Effect.mapError((error) => vaultError("verify token account credential", error)));
      if (verified !== secret.value) {
        return yield* Effect.fail(
          vaultError(
            "verify token account credential",
            new Error("Credential readback did not match."),
          ),
        );
      }
    }

    const migrated: PersistedCodexBarConfig = {
      ...config,
      providers: config.providers.map(metadataOnlyTokenAccounts),
    };
    yield* repository
      .save(migrated)
      .pipe(Effect.mapError((error) => vaultError("save migrated token account config", error)));
    return migrated;
  });

const loadFreshAndMigrateUnderHeldLock = (
  repository: ConfigRepositoryService,
  credentials: CredentialStoreService,
): Effect.Effect<PersistedCodexBarConfig | undefined, InfrastructureError> =>
  Effect.gen(function* () {
    const freshConfig = yield* repository.load.pipe(
      Effect.mapError((error) => vaultError("load config", error)),
    );
    if (freshConfig === undefined) return undefined;
    if (
      containsLegacyTokenAccountData(freshConfig) &&
      (containsPendingTokenAccountAddition(freshConfig) ||
        containsPendingTokenAccountDeletion(freshConfig))
    ) {
      return yield* Effect.fail(
        invalidMetadataError(
          new Error("Legacy token accounts cannot contain pending vault lifecycle operations."),
        ),
      );
    }
    const current = containsLegacyTokenAccountData(freshConfig)
      ? yield* migrateTokenAccountsToVault(freshConfig, repository, credentials)
      : freshConfig;
    const invalid = assertMetadataOnlyV2(current);
    if (invalid !== undefined) return yield* Effect.fail(invalid);
    const afterDeletion = yield* reconcilePendingTokenAccountDeletions(
      current,
      repository,
      credentials,
    );
    return yield* reconcilePendingTokenAccountAdditions(afterDeletion, repository, credentials);
  });

interface TokenAccountIdentityChange {
  readonly providerId: string;
  readonly accountId: string;
}

const tokenAccountIdentityChanges = (
  current: PersistedCodexBarConfig | undefined,
  next: PersistedCodexBarConfig,
): {
  readonly added: readonly TokenAccountIdentityChange[];
  readonly removed: readonly TokenAccountIdentityChange[];
} => {
  const currentByProvider = new Map(
    (current?.providers ?? []).map((provider) => [
      provider.id,
      new Set(provider.tokenAccounts?.accounts.map((account) => account.id) ?? []),
    ]),
  );
  const nextByProvider = new Map(
    next.providers.map((provider) => [
      provider.id,
      new Set(provider.tokenAccounts?.accounts.map((account) => account.id) ?? []),
    ]),
  );
  const providerIds = new Set([...currentByProvider.keys(), ...nextByProvider.keys()]);
  const added: TokenAccountIdentityChange[] = [];
  const removed: TokenAccountIdentityChange[] = [];
  for (const providerId of providerIds) {
    const before = currentByProvider.get(providerId) ?? new Set<string>();
    const after = nextByProvider.get(providerId) ?? new Set<string>();
    for (const accountId of after) {
      if (!before.has(accountId)) added.push({ providerId, accountId });
    }
    for (const accountId of before) {
      if (!after.has(accountId)) removed.push({ providerId, accountId });
    }
  }
  return { added, removed };
};

const tokenAccountRostersEqual = (
  current: PersistedCodexBarConfig | undefined,
  next: PersistedCodexBarConfig,
): boolean => {
  const project = (config: PersistedCodexBarConfig | undefined) =>
    (config?.providers ?? [])
      .filter((provider) => provider.tokenAccounts !== undefined)
      .map((provider) => ({ id: provider.id, tokenAccounts: provider.tokenAccounts }));
  return JSON.stringify(project(current)) === JSON.stringify(project(next));
};

const browserSessionCleanupJournalsEqual = (
  current: PersistedCodexBarConfig | undefined,
  next: PersistedCodexBarConfig,
): boolean => {
  const project = (config: PersistedCodexBarConfig | undefined) =>
    (config?.providers ?? [])
      .filter((provider) => provider.pendingBrowserSessionCleanup !== undefined)
      .map((provider) => ({
        id: provider.id,
        pendingBrowserSessionCleanup: provider.pendingBrowserSessionCleanup,
      }));
  return JSON.stringify(project(current)) === JSON.stringify(project(next));
};

const commitVaultBackedConfigMutation = (
  current: PersistedCodexBarConfig | undefined,
  next: PersistedCodexBarConfig,
  repository: ConfigRepositoryService,
  credentials: CredentialStoreService,
): Effect.Effect<PersistedCodexBarConfig, InfrastructureError> => {
  if (containsPendingTokenAccountAddition(next)) {
    return Effect.fail(
      invalidMetadataError(new Error("Pending token-account additions are host-owned.")),
    );
  }
  if (containsPendingTokenAccountDeletion(next)) {
    return Effect.fail(
      invalidMetadataError(new Error("Pending token-account deletions are host-owned.")),
    );
  }
  if (!browserSessionCleanupJournalsEqual(current, next)) {
    return Effect.fail(
      invalidMetadataError(new Error("Browser-session cleanup journals are host-owned.")),
    );
  }
  const changes = tokenAccountIdentityChanges(current, next);
  if (changes.added.length > 0) {
    return Effect.fail(
      tokenAccountLifecycleError(
        "add token account",
        new Error("Account creation requires the host credential lifecycle service."),
      ),
    );
  }
  if (changes.removed.length === 0) {
    return repository.save(next).pipe(
      Effect.mapError((error) => vaultError("save config", error)),
      Effect.as(next),
    );
  }
  if (changes.removed.length !== 1) {
    return Effect.fail(
      tokenAccountLifecycleError(
        "remove token account",
        new Error("Only one token account may be removed per transaction."),
      ),
    );
  }
  const removal = changes.removed[0];
  if (removal === undefined || !firstPartyProviderIds.has(removal.providerId)) {
    return Effect.fail(
      tokenAccountLifecycleError(
        "remove token account",
        new Error("Plugin token-account deletion is not supported."),
      ),
    );
  }
  let foundProvider = false;
  const staged: PersistedCodexBarConfig = {
    ...next,
    providers: next.providers.map((provider) => {
      if (provider.id !== removal.providerId) return provider;
      foundProvider = true;
      return {
        ...provider,
        pendingTokenAccountDeletion: { version: 1 as const, accountId: removal.accountId },
        ...(removal.providerId === "codex"
          ? {
              pendingBrowserSessionCleanup: {
                version: 1 as const,
                accountIds: [
                  ...(provider.pendingBrowserSessionCleanup?.accountIds ?? []),
                  ...((provider.pendingBrowserSessionCleanup?.accountIds ?? []).includes(
                    removal.accountId,
                  )
                    ? []
                    : [removal.accountId]),
                ],
              },
            }
          : {}),
      };
    }),
  };
  if (!foundProvider) {
    return Effect.fail(
      tokenAccountLifecycleError(
        "remove token account",
        new Error("The owning provider must remain in config during deletion."),
      ),
    );
  }
  const stagedInvalid = assertMetadataOnlyV2(staged);
  if (stagedInvalid !== undefined) return Effect.fail(stagedInvalid);
  return repository.save(staged).pipe(
    Effect.mapError((error) =>
      tokenAccountLifecycleError("stage token account deletion", new Error(error.operation)),
    ),
    Effect.flatMap(() => reconcilePendingTokenAccountDeletions(staged, repository, credentials)),
  );
};

export const makeTokenAccountVaultConfigRepository = (
  repository: ConfigRepositoryService,
  credentials: CredentialStoreService,
  lock: TokenAccountMigrationLock,
): ConfigRepositoryService => ({
  load: repository.load.pipe(
    Effect.mapError((error) => vaultError("load config", error)),
    Effect.flatMap((config) => {
      if (config === undefined) return Effect.succeed(undefined);
      if (
        !containsLegacyTokenAccountData(config) &&
        !containsPendingTokenAccountAddition(config) &&
        !containsPendingTokenAccountDeletion(config)
      ) {
        const invalid = assertMetadataOnlyV2(config);
        return invalid === undefined ? Effect.succeed(config) : Effect.fail(invalid);
      }
      return lock.runExclusive(loadFreshAndMigrateUnderHeldLock(repository, credentials));
    }),
  ),
  save: (config) => {
    const invalid = assertMetadataOnlyV2(config);
    if (invalid !== undefined) return Effect.fail(invalid);
    if (
      containsPendingTokenAccountAddition(config) ||
      containsPendingTokenAccountDeletion(config)
    ) {
      return Effect.fail(
        invalidMetadataError(
          new Error("Pending token-account lifecycle operations are host-owned."),
        ),
      );
    }
    return lock.runExclusive(
      Effect.gen(function* () {
        const current = yield* loadFreshAndMigrateUnderHeldLock(repository, credentials);
        if (!tokenAccountRostersEqual(current, config)) {
          return yield* Effect.fail(
            tokenAccountLifecycleError(
              "save config",
              new Error("Blind saves cannot mutate token-account rosters; use modify."),
            ),
          );
        }
        if (!browserSessionCleanupJournalsEqual(current, config)) {
          return yield* Effect.fail(
            invalidMetadataError(
              new Error("Blind saves cannot mutate browser-session cleanup journals."),
            ),
          );
        }
        yield* repository
          .save(config)
          .pipe(Effect.mapError((error) => vaultError("save config", error)));
      }),
    );
  },
  modify: (mutation) =>
    lock.runExclusive(
      Effect.gen(function* () {
        const current = yield* loadFreshAndMigrateUnderHeldLock(repository, credentials);
        const result = yield* mutation(current);
        const invalid = assertMetadataOnlyV2(result.config);
        if (invalid !== undefined) return yield* Effect.fail(invalid);
        const committed = yield* commitVaultBackedConfigMutation(
          current,
          result.config,
          repository,
          credentials,
        );
        return { config: committed, value: result.value };
      }),
    ),
});

const explicit = (value: string | undefined): string | null => value ?? null;

const cookieHeaderPatterns = [
  /-H\s*'Cookie:\s*([^']+)'/iu,
  /-H\s*"Cookie:\s*([^"]+)"/iu,
  /\bcookie:\s*'([^']+)'/iu,
  /\bcookie:\s*"([^"]+)"/iu,
  /\bcookie:\s*([^\r\n]+)/iu,
  /(?:^|\s)(?:--cookie|-b)\s*'([^']+)'/iu,
  /(?:^|\s)(?:--cookie|-b)\s*"([^"]+)"/iu,
  /(?:^|\s)-b([^\s=]+=[^\s]+)/iu,
  /(?:^|\s)(?:--cookie|-b)\s+([^\s]+)/iu,
] as const;

const stripWrappingQuotes = (raw: string): string => {
  if (
    raw.length >= 2 &&
    ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
  ) {
    return raw.slice(1, -1);
  }
  return raw;
};

const stripCookiePrefix = (raw: string): string => {
  const trimmed = raw.trim();
  return trimmed.toLowerCase().startsWith("cookie:")
    ? trimmed.slice("cookie:".length).trim()
    : trimmed;
};

const normalizeCookieHeader = (raw: string | undefined): string | undefined => {
  let value = raw?.trim() ?? "";
  if (value === "") return undefined;
  for (const pattern of cookieHeaderPatterns) {
    const match = pattern.exec(value);
    if (match?.[1]?.trim()) {
      value = match[1].trim();
      break;
    }
  }
  value = stripWrappingQuotes(stripCookiePrefix(value)).trim();
  return value === "" ? undefined : value;
};

type ClaudeCredentialRoute =
  | { readonly kind: "oauth"; readonly accessToken: string }
  | { readonly kind: "web"; readonly cookieHeader: string }
  | { readonly kind: "admin"; readonly apiKey: string };

type GrokCredentialRoute =
  | { readonly kind: "oauth"; readonly accessToken: string }
  | { readonly kind: "web"; readonly cookieHeader: string };

const normalizeClaudeOAuthToken = (raw: string | undefined): string | undefined => {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === "") return undefined;
  const lower = trimmed.toLowerCase();
  if (lower.includes("cookie:") || trimmed.includes("=")) return undefined;
  if (lower.startsWith("bearer ")) {
    const bearerTrimmed = trimmed.slice("bearer ".length).trim();
    return bearerTrimmed.toLowerCase().startsWith("sk-ant-oat") ? bearerTrimmed : undefined;
  }
  return lower.startsWith("sk-ant-oat") ? trimmed : undefined;
};

const normalizeClaudeAdminAPIKey = (raw: string | undefined): string | undefined => {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === "") return undefined;
  const lower = trimmed.toLowerCase();
  if (lower.includes("cookie:") || trimmed.includes("=")) return undefined;
  if (lower.startsWith("bearer ")) {
    const bearerTrimmed = trimmed.slice("bearer ".length).trim();
    return bearerTrimmed.toLowerCase().startsWith("sk-ant-admin") ? bearerTrimmed : undefined;
  }
  return lower.startsWith("sk-ant-admin") ? trimmed : undefined;
};

const normalizeClaudeWebCookie = (raw: string | undefined): string | undefined => {
  const normalized = normalizeCookieHeader(raw);
  if (normalized === undefined) return undefined;
  return normalized.includes("=") ? normalized : `sessionKey=${normalized}`;
};

const normalizeGrokOAuthToken = (raw: string | undefined): string | undefined => {
  let token = raw?.trim() ?? "";
  if (token.toLowerCase().startsWith("bearer ")) token = token.slice(7).trim();
  if (
    token === "" ||
    token.toLowerCase().startsWith("cookie:") ||
    token.toLowerCase().startsWith("xai-") ||
    token.includes("=")
  ) {
    return undefined;
  }
  return token;
};

const normalizeGrokWebCookie = (raw: string | undefined): string | undefined => {
  const normalized = normalizeCookieHeader(raw);
  return normalized?.includes("=") === true ? normalized : undefined;
};

const resolveClaudeCredentialRoute = (raw: string): ClaudeCredentialRoute | undefined => {
  const apiKey = normalizeClaudeAdminAPIKey(raw);
  if (apiKey !== undefined) return { kind: "admin", apiKey };
  const accessToken = normalizeClaudeOAuthToken(raw);
  if (accessToken !== undefined) return { kind: "oauth", accessToken };
  const cookieHeader = normalizeClaudeWebCookie(raw);
  if (cookieHeader !== undefined) return { kind: "web", cookieHeader };
  return undefined;
};

const resolveGrokCredentialRoute = (raw: string): GrokCredentialRoute | undefined => {
  const accessToken = normalizeGrokOAuthToken(raw);
  if (accessToken !== undefined) return { kind: "oauth", accessToken };
  const cookieHeader = normalizeGrokWebCookie(raw);
  if (cookieHeader !== undefined) return { kind: "web", cookieHeader };
  return undefined;
};

const resolveSelectedMaterial = (
  credentials: CredentialStoreService,
  providerId: ProviderId,
  accountId: string,
): Effect.Effect<string, ClassifiedFetchFailure> =>
  credentials.read(tokenAccountVaultKey(providerId, accountId)).pipe(
    Effect.mapError(() => selectedAccountFailure("Unable to read selected account credential.")),
    Effect.flatMap((value) =>
      value === undefined
        ? Effect.fail(selectedAccountFailure("Selected account credential is missing."))
        : Effect.succeed(value),
    ),
  );

const selectedCodexAccount = (
  accountId: string,
  raw: string,
  metadata: { readonly externalIdentifier?: string | undefined } = {},
): Effect.Effect<FirstPartySelectedAccount, ClassifiedFetchFailure> => {
  const parsed = parseNodeCodexAuthJson(raw);
  if (parsed === undefined) {
    return Effect.fail(selectedAccountFailure("Selected Codex account credential is invalid."));
  }
  const { accessToken, accountId: accountSetting, personalAccessToken } = parsed.credential;
  const externalIdentifier = sanitizedMetadataValue(metadata.externalIdentifier);
  if (externalIdentifier === "invalid") {
    return Effect.fail(selectedAccountFailure("Selected Codex account metadata is invalid."));
  }
  return Effect.succeed({
    id: accountId,
    ...(parsed.email === undefined ? {} : { accountEmail: parsed.email }),
    ...(externalIdentifier === undefined ? {} : { externalIdentifier }),
    secureSettings: {
      CODEX_ACCESS_TOKEN: accessToken ?? null,
      CODEX_PERSONAL_ACCESS_TOKEN: personalAccessToken ?? null,
    },
    plainSettings: {
      CODEX_ACCOUNT_ID: accountSetting ?? null,
    },
  });
};

export interface AddCodexTokenAccountCredentialRequest {
  readonly accountId: string;
  readonly label: string;
  readonly credentialJson: string;
  readonly addedAt: number;
  readonly externalIdentifier?: string;
}

const normalizedAddAccountId = (accountId: string): string | undefined => {
  const trimmed = accountId.trim();
  if (trimmed.length === 0 || trimmed.length > 256 || /\p{Cc}/u.test(trimmed)) return undefined;
  return trimmed;
};

const normalizedAddAccountLabel = (label: string, fallbackIndex: number): string | undefined => {
  const trimmed = label.trim();
  const resolved = trimmed.length === 0 ? `Account ${fallbackIndex}` : trimmed;
  if (resolved.length > 256 || /\p{Cc}/u.test(resolved)) return undefined;
  return resolved;
};

const normalizedCodexCredentialJson = (credentialJson: string): string | undefined => {
  const trimmed = credentialJson.trim();
  if (trimmed.length === 0 || trimmed.includes("\u0000")) return undefined;
  if (new TextEncoder().encode(trimmed).byteLength > 1024 * 1024) return undefined;
  return trimmed;
};

/**
 * Host-owned account creation path for Codex auth material. Callers must pass a
 * backend-read auth.json payload or login result; renderer IPC must not expose
 * this function directly.
 */
export const addCodexTokenAccountCredentialToVault = (
  repository: ConfigRepositoryService,
  credentials: CredentialStoreService,
  lock: TokenAccountMigrationLock,
  request: AddCodexTokenAccountCredentialRequest,
): Effect.Effect<PersistedCodexBarConfig, InfrastructureError> =>
  lock.runExclusive(
    Effect.gen(function* () {
      const accountId = normalizedAddAccountId(request.accountId);
      if (accountId === undefined) {
        return yield* Effect.fail(
          tokenAccountLifecycleError("add token account", new Error("Invalid account ID.")),
        );
      }
      const credentialJson = normalizedCodexCredentialJson(request.credentialJson);
      if (credentialJson === undefined) {
        return yield* Effect.fail(
          tokenAccountLifecycleError("add token account", new Error("Invalid Codex credential.")),
        );
      }
      yield* selectedCodexAccount(accountId, credentialJson).pipe(
        Effect.mapError((error) => tokenAccountLifecycleError("add token account", error)),
      );

      const current = yield* loadFreshAndMigrateUnderHeldLock(repository, credentials);
      if (current === undefined) {
        return yield* Effect.fail(
          tokenAccountLifecycleError("add token account", new Error("Config is missing.")),
        );
      }
      const provider = current.providers.find((entry) => entry.id === "codex");
      if (provider === undefined) {
        return yield* Effect.fail(
          tokenAccountLifecycleError("add token account", new Error("Codex provider is missing.")),
        );
      }
      const existingAccounts = provider.tokenAccounts?.accounts ?? [];
      if (provider.pendingBrowserSessionCleanup?.accountIds.includes(accountId) === true) {
        return yield* Effect.fail(
          tokenAccountLifecycleError(
            "add token account",
            new Error("Browser-session cleanup is still pending for this account ID."),
          ),
        );
      }
      if (existingAccounts.some((account) => account.id === accountId)) {
        return yield* Effect.fail(
          tokenAccountLifecycleError("add token account", new Error("Account ID already exists.")),
        );
      }
      const externalIdentifier = request.externalIdentifier?.trim();
      if (
        externalIdentifier !== undefined &&
        (externalIdentifier.length === 0 ||
          !validMetadataString(externalIdentifier, false) ||
          existingAccounts.some((account) => account.externalIdentifier === externalIdentifier))
      ) {
        return yield* Effect.fail(
          tokenAccountLifecycleError(
            "add token account",
            new Error("Provider account already exists or is invalid."),
          ),
        );
      }
      const label = normalizedAddAccountLabel(request.label, existingAccounts.length + 1);
      if (label === undefined) {
        return yield* Effect.fail(
          tokenAccountLifecycleError("add token account", new Error("Invalid account label.")),
        );
      }
      if (!Number.isFinite(request.addedAt) || request.addedAt < 0) {
        return yield* Effect.fail(
          tokenAccountLifecycleError("add token account", new Error("Invalid addedAt timestamp.")),
        );
      }

      const key = tokenAccountVaultKey("codex", accountId);
      const existingCredential = yield* credentials
        .read(key)
        .pipe(
          Effect.mapError((error) =>
            tokenAccountLifecycleError("read token account credential", new Error(error.operation)),
          ),
        );
      if (existingCredential !== undefined) {
        return yield* Effect.fail(
          tokenAccountLifecycleError(
            "add token account",
            new Error("Credential key already exists."),
          ),
        );
      }

      const nextAccount = {
        id: accountId,
        label,
        addedAt: request.addedAt,
        ...(externalIdentifier === undefined ? {} : { externalIdentifier }),
      } as const;
      const staged: PersistedCodexBarConfig = {
        ...current,
        providers: current.providers.map((entry) =>
          entry.id === "codex"
            ? {
                ...entry,
                pendingTokenAccountAddition: {
                  version: 1 as const,
                  account: nextAccount,
                  credentialSha256: sha256Hex(credentialJson),
                  makeActive: true,
                },
              }
            : entry,
        ),
      };
      const invalid = assertMetadataOnlyV2(staged);
      if (invalid !== undefined) return yield* Effect.fail(invalid);

      yield* repository
        .save(staged)
        .pipe(
          Effect.mapError((error) =>
            tokenAccountLifecycleError("stage token account addition", new Error(error.operation)),
          ),
        );
      yield* credentials
        .write(key, credentialJson)
        .pipe(
          Effect.mapError((error) =>
            tokenAccountLifecycleError(
              "write token account credential",
              new Error(error.operation),
            ),
          ),
        );
      const verified = yield* credentials
        .read(key)
        .pipe(
          Effect.mapError((error) =>
            tokenAccountLifecycleError(
              "verify token account credential",
              new Error(error.operation),
            ),
          ),
        );
      if (verified !== credentialJson) {
        return yield* Effect.fail(
          tokenAccountLifecycleError(
            "verify token account credential",
            new Error("Credential readback did not match."),
          ),
        );
      }
      return yield* reconcilePendingTokenAccountAdditions(staged, repository, credentials);
    }),
  );

const selectedClaudeAccount = (
  accountId: string,
  raw: string,
  metadata: { readonly organizationId?: string | undefined },
): Effect.Effect<FirstPartySelectedAccount, ClassifiedFetchFailure> => {
  const route = resolveClaudeCredentialRoute(raw);
  if (route === undefined) {
    return Effect.fail(selectedAccountFailure("Selected Claude account credential is invalid."));
  }
  const organizationId = sanitizedMetadataValue(metadata.organizationId);
  if (organizationId === "invalid") {
    return Effect.fail(selectedAccountFailure("Selected Claude organization metadata is invalid."));
  }
  const plainSettings = { CLAUDE_ORGANIZATION_ID: organizationId ?? null };
  const tokenAccountKey = claudeSelectedTokenAccountPlanUtilizationAccountKey("claude", accountId);
  const historyBinding =
    tokenAccountKey === undefined
      ? {}
      : {
          claudeHistoryBinding: {
            selectionKey: tokenAccountKey,
            tokenAccountKey,
          },
        };
  if (route.kind === "admin") {
    return Effect.succeed({
      id: accountId,
      secureSettings: {
        ANTHROPIC_ADMIN_KEY: route.apiKey,
        ANTHROPIC_ADMIN_API_KEY: null,
        CLAUDE_OAUTH_ACCESS_TOKEN: null,
        CLAUDE_COOKIE_HEADER: null,
        CLAUDE_CLI_USAGE_JSON: null,
      },
      plainSettings,
      ...historyBinding,
    });
  }
  if (route.kind === "oauth") {
    return Effect.succeed({
      id: accountId,
      secureSettings: {
        ANTHROPIC_ADMIN_KEY: null,
        ANTHROPIC_ADMIN_API_KEY: null,
        CLAUDE_OAUTH_ACCESS_TOKEN: route.accessToken,
        CLAUDE_COOKIE_HEADER: null,
        CLAUDE_CLI_USAGE_JSON: null,
      },
      plainSettings,
      ...historyBinding,
    });
  }
  return Effect.succeed({
    id: accountId,
    secureSettings: {
      ANTHROPIC_ADMIN_KEY: null,
      ANTHROPIC_ADMIN_API_KEY: null,
      CLAUDE_OAUTH_ACCESS_TOKEN: null,
      CLAUDE_COOKIE_HEADER: route.cookieHeader,
      CLAUDE_CLI_USAGE_JSON: null,
    },
    plainSettings,
    ...historyBinding,
  });
};

const sanitizedMetadataValue = (raw: string | undefined): string | "invalid" | undefined => {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === "") return undefined;
  if (/\p{Cc}/u.test(trimmed) || new TextEncoder().encode(trimmed).byteLength > 256) {
    return "invalid";
  }
  return trimmed;
};

const normalizeOpaqueAPIKey = (raw: string): string | undefined => {
  const normalized = stripWrappingQuotes(raw.trim()).trim();
  if (normalized === "" || normalized.includes("\u0000") || normalized.length > 1024 * 1024)
    return undefined;
  return normalized;
};

const selectedCookieAccount = (
  accountId: string,
  raw: string,
  setting: string,
  providerName: string,
): Effect.Effect<FirstPartySelectedAccount, ClassifiedFetchFailure> => {
  const cookieHeader = normalizeCookieHeader(raw);
  if (
    cookieHeader === undefined ||
    cookieHeader.includes("\u0000") ||
    new TextEncoder().encode(cookieHeader).byteLength > 1024 * 1024
  ) {
    return Effect.fail(
      selectedAccountFailure(`Selected ${providerName} account credential is invalid.`),
    );
  }
  return Effect.succeed({ id: accountId, secureSettings: { [setting]: cookieHeader } });
};

const selectedOpenCodeAccount = (
  accountId: string,
  raw: string,
): Effect.Effect<FirstPartySelectedAccount, ClassifiedFetchFailure> => {
  const byteLength = new TextEncoder().encode(raw).byteLength;
  const cookieHeader = openCodeRequestCookieHeader(raw);
  if (
    raw.includes("\u0000") ||
    byteLength > 1024 * 1024 ||
    cookieHeader === undefined ||
    cookieHeader.includes("\u0000")
  ) {
    return Effect.fail(selectedAccountFailure("Selected OpenCode account credential is invalid."));
  }
  return Effect.succeed({ id: accountId, secureSettings: { OPENCODE_COOKIE: cookieHeader } });
};

const selectedOpenCodeGoAccount = (
  accountId: string,
  raw: string,
): Effect.Effect<FirstPartySelectedAccount, ClassifiedFetchFailure> => {
  const byteLength = new TextEncoder().encode(raw).byteLength;
  const cookieHeader = openCodeRequestCookieHeader(raw);
  if (
    raw.includes("\u0000") ||
    byteLength > 1024 * 1024 ||
    cookieHeader === undefined ||
    cookieHeader.includes("\u0000")
  ) {
    return Effect.fail(
      selectedAccountFailure("Selected OpenCode Go account credential is invalid."),
    );
  }
  return Effect.succeed({
    id: accountId,
    secureSettings: { OPENCODEGO_COOKIE: cookieHeader, OPENCODE_API_KEY: null },
  });
};

const selectedManusAccount = (
  accountId: string,
  raw: string,
): Effect.Effect<FirstPartySelectedAccount, ClassifiedFetchFailure> => {
  const byteLength = new TextEncoder().encode(raw).byteLength;
  const material = normalizeCookieHeader(raw);
  const token = manusSessionToken(material);
  const cookieHeader = token === undefined ? undefined : `session_id=${token}`;
  if (
    raw.includes("\u0000") ||
    raw.includes("\r") ||
    raw.includes("\n") ||
    byteLength > 1024 * 1024 ||
    cookieHeader === undefined ||
    new TextEncoder().encode(cookieHeader).byteLength > 1024 * 1024
  ) {
    return Effect.fail(selectedAccountFailure("Selected Manus account credential is invalid."));
  }
  return Effect.succeed({
    id: accountId,
    secureSettings: { MANUS_COOKIE_HEADER: cookieHeader },
  });
};

const selectedStepFunAccount = (
  accountId: string,
  raw: string,
): Effect.Effect<FirstPartySelectedAccount, ClassifiedFetchFailure> => {
  const byteLength = new TextEncoder().encode(raw).byteLength;
  const material = normalizeCookieHeader(raw);
  const token = normalizeStepFunToken(material);
  if (
    raw.includes("\u0000") ||
    raw.includes("\r") ||
    raw.includes("\n") ||
    byteLength > 1024 * 1024 ||
    token === undefined
  ) {
    return Effect.fail(selectedAccountFailure("Selected StepFun account credential is invalid."));
  }
  return Effect.succeed({ id: accountId, secureSettings: { STEPFUN_TOKEN: token } });
};

const selectedOllamaAccount = (
  accountId: string,
  raw: string,
): Effect.Effect<FirstPartySelectedAccount, ClassifiedFetchFailure> => {
  const rawBytes = new TextEncoder().encode(raw).byteLength;
  const cookieHeader = normalizeOllamaTokenAccountHeader(raw);
  if (
    raw.includes("\u0000") ||
    rawBytes >= 1024 * 1024 ||
    cookieHeader === undefined ||
    cookieHeader.includes("\u0000") ||
    new TextEncoder().encode(cookieHeader).byteLength > 1024 * 1024
  ) {
    return Effect.fail(selectedAccountFailure("Selected Ollama account credential is invalid."));
  }
  return Effect.succeed({
    id: accountId,
    secureSettings: {
      OLLAMA_COOKIE: cookieHeader,
      OLLAMA_API_KEY: null,
      OLLAMA_KEY: null,
    },
  });
};

const selectedFactoryAccount = (
  accountId: string,
  raw: string,
): Effect.Effect<FirstPartySelectedAccount, ClassifiedFetchFailure> => {
  const rawBytes = new TextEncoder().encode(raw).byteLength;
  const credential = canonicalFactoryManualCredential(raw);
  const normalizedLines = raw.replaceAll("\r\n", "\n");
  const lines = normalizedLines
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const lineBreaksAreSafe = !normalizedLines.includes("\r");
  const recognizedHeaderLines =
    lines.length <= 1 ||
    (lines.length === 2 &&
      lines.every((line) => /^(?:cookie\s*:|authorization\s*:\s*bearer\b)/iu.test(line)));
  if (
    raw.includes("\u0000") ||
    rawBytes > 1024 * 1024 ||
    !lineBreaksAreSafe ||
    !recognizedHeaderLines ||
    credential === undefined ||
    credential.includes("\u0000") ||
    new TextEncoder().encode(credential).byteLength > 1024 * 1024
  ) {
    return Effect.fail(selectedAccountFailure("Selected Factory account credential is invalid."));
  }
  return Effect.succeed({
    id: accountId,
    secureSettings: {
      FACTORY_COOKIE_HEADER: credential,
      FACTORY_API_KEY: null,
    },
  });
};

const selectedQoderAccount = (
  accountId: string,
  raw: string,
): Effect.Effect<FirstPartySelectedAccount, ClassifiedFetchFailure> => {
  const rawBytes = new TextEncoder().encode(raw).byteLength;
  const credential = normalizeQoderManualCredential(raw);
  if (
    raw.includes("\u0000") ||
    rawBytes > 1024 * 1024 ||
    credential === undefined ||
    credential.cookieHeader.includes("\u0000") ||
    new TextEncoder().encode(credential.cookieHeader).byteLength >= 1024 * 1024
  ) {
    return Effect.fail(selectedAccountFailure("Selected Qoder account credential is invalid."));
  }
  return Effect.succeed({
    id: accountId,
    secureSettings: { QODER_COOKIE_HEADER: credential.cookieHeader },
    plainSettings: { QODER_SITE: credential.site },
  });
};

const selectedMiniMaxAccount = (
  accountId: string,
  raw: string,
): Effect.Effect<FirstPartySelectedAccount, ClassifiedFetchFailure> => {
  const rawBytes = new TextEncoder().encode(raw).byteLength;
  const credential = normalizeMiniMaxCookieCredential(raw);
  if (
    raw.includes("\u0000") ||
    rawBytes >= 1024 * 1024 ||
    credential === undefined ||
    credential.cookieHeader.includes("\u0000") ||
    new TextEncoder().encode(credential.cookieHeader).byteLength >= 1024 * 1024
  ) {
    return Effect.fail(selectedAccountFailure("Selected MiniMax account credential is invalid."));
  }
  return Effect.succeed({
    id: accountId,
    secureSettings: {
      MINIMAX_COOKIE: null,
      MINIMAX_COOKIE_HEADER: credential.cookieHeader,
      MINIMAX_AUTHORIZATION_TOKEN: credential.authorizationToken ?? null,
      MINIMAX_API_TOKEN: null,
      MINIMAX_API_KEY: null,
      MINIMAX_CODING_API_KEY: null,
      MINIMAX_GROUP_ID: credential.groupId ?? null,
    },
  });
};

const selectedZaiAccount = (
  accountId: string,
  raw: string,
  metadata: {
    readonly usageScope?: string | undefined;
    readonly organizationId?: string | undefined;
    readonly workspaceID?: string | undefined;
  },
): Effect.Effect<FirstPartySelectedAccount, ClassifiedFetchFailure> => {
  const apiKey = normalizeOpaqueAPIKey(raw);
  if (apiKey === undefined) {
    return Effect.fail(selectedAccountFailure("Selected z.ai account credential is invalid."));
  }
  const usageScope = sanitizedMetadataValue(metadata.usageScope);
  const organizationId = sanitizedMetadataValue(metadata.organizationId);
  const workspaceID = sanitizedMetadataValue(metadata.workspaceID);
  if (usageScope === "invalid" || organizationId === "invalid" || workspaceID === "invalid") {
    return Effect.fail(selectedAccountFailure("Selected z.ai account metadata is invalid."));
  }
  const scope = usageScope?.toLowerCase() === "team" ? "team" : "personal";
  return Effect.succeed({
    id: accountId,
    secureSettings: { Z_AI_API_KEY: apiKey },
    plainSettings: {
      Z_AI_USAGE_SCOPE: scope,
      Z_AI_ORGANIZATION: scope === "team" ? (organizationId ?? null) : null,
      Z_AI_PROJECT: scope === "team" ? (workspaceID ?? null) : null,
    },
  });
};

const selectedCopilotAccount = (
  accountId: string,
  raw: string,
  metadata: { readonly externalIdentifier?: string | undefined },
): Effect.Effect<FirstPartySelectedAccount, ClassifiedFetchFailure> => {
  const token = normalizeOpaqueAPIKey(raw);
  if (token === undefined) {
    return Effect.fail(selectedAccountFailure("Selected Copilot account credential is invalid."));
  }
  const externalIdentifier = sanitizedMetadataValue(metadata.externalIdentifier);
  if (externalIdentifier === "invalid") {
    return Effect.fail(selectedAccountFailure("Selected Copilot account metadata is invalid."));
  }
  return Effect.succeed({
    id: accountId,
    ...(externalIdentifier === undefined ? {} : { externalIdentifier }),
    secureSettings: { COPILOT_API_TOKEN: token },
  });
};

const selectedDeepInfraAccount = (
  accountId: string,
  raw: string,
): Effect.Effect<FirstPartySelectedAccount, ClassifiedFetchFailure> => {
  const apiKey = normalizeOpaqueAPIKey(raw);
  if (apiKey === undefined) {
    return Effect.fail(selectedAccountFailure("Selected DeepInfra account credential is invalid."));
  }
  return Effect.succeed({
    id: accountId,
    secureSettings: { DEEPINFRA_API_KEY: apiKey, DEEPINFRA_TOKEN: null },
  });
};

const selectedGroqAccount = (
  accountId: string,
  raw: string,
): Effect.Effect<FirstPartySelectedAccount, ClassifiedFetchFailure> => {
  const apiKey = normalizeOpaqueAPIKey(raw);
  if (apiKey === undefined) {
    return Effect.fail(selectedAccountFailure("Selected Groq account credential is invalid."));
  }
  return Effect.succeed({
    id: accountId,
    secureSettings: { GROQ_API_KEY: apiKey },
  });
};

const selectedVeniceAccount = (
  accountId: string,
  raw: string,
): Effect.Effect<FirstPartySelectedAccount, ClassifiedFetchFailure> => {
  const apiKey = normalizeOpaqueAPIKey(raw);
  if (apiKey === undefined) {
    return Effect.fail(selectedAccountFailure("Selected Venice account credential is invalid."));
  }
  return Effect.succeed({
    id: accountId,
    secureSettings: { VENICE_API_KEY: apiKey, VENICE_KEY: null },
  });
};

const selectedElevenLabsAccount = (
  accountId: string,
  raw: string,
): Effect.Effect<FirstPartySelectedAccount, ClassifiedFetchFailure> => {
  const apiKey = normalizeOpaqueAPIKey(raw);
  if (apiKey === undefined) {
    return Effect.fail(
      selectedAccountFailure("Selected ElevenLabs account credential is invalid."),
    );
  }
  return Effect.succeed({
    id: accountId,
    secureSettings: { ELEVENLABS_API_KEY: apiKey, XI_API_KEY: null },
  });
};

const selectedIBMBobAccount = (
  accountId: string,
  raw: string,
): Effect.Effect<FirstPartySelectedAccount, ClassifiedFetchFailure> => {
  const apiKey = normalizeOpaqueAPIKey(raw);
  if (apiKey === undefined) {
    return Effect.fail(selectedAccountFailure("Selected IBM Bob account credential is invalid."));
  }
  return Effect.succeed({
    id: accountId,
    secureSettings: { BOBSHELL_API_KEY: apiKey },
  });
};

const selectedNeuralWattAccount = (
  accountId: string,
  raw: string,
): Effect.Effect<FirstPartySelectedAccount, ClassifiedFetchFailure> => {
  const apiKey = normalizeOpaqueAPIKey(raw);
  if (apiKey === undefined) {
    return Effect.fail(
      selectedAccountFailure("Selected Neuralwatt account credential is invalid."),
    );
  }
  return Effect.succeed({
    id: accountId,
    secureSettings: { NEURALWATT_API_KEY: apiKey },
  });
};

const selectedSub2APIAccount = (
  accountId: string,
  raw: string,
): Effect.Effect<FirstPartySelectedAccount, ClassifiedFetchFailure> => {
  const apiKey = normalizeOpaqueAPIKey(raw);
  if (apiKey === undefined) {
    return Effect.fail(selectedAccountFailure("Selected sub2api account credential is invalid."));
  }
  return Effect.succeed({
    id: accountId,
    secureSettings: { SUB2API_API_KEY: apiKey },
  });
};

const selectedLLMProxyAccount = (
  accountId: string,
  raw: string,
): Effect.Effect<FirstPartySelectedAccount, ClassifiedFetchFailure> => {
  const apiKey = normalizeOpaqueAPIKey(raw);
  if (apiKey === undefined) {
    return Effect.fail(selectedAccountFailure("Selected LLM Proxy account credential is invalid."));
  }
  return Effect.succeed({ id: accountId, secureSettings: { LLM_PROXY_API_KEY: apiKey } });
};

const selectedLiteLLMAccount = (
  accountId: string,
  raw: string,
): Effect.Effect<FirstPartySelectedAccount, ClassifiedFetchFailure> => {
  const apiKey = normalizeOpaqueAPIKey(raw);
  if (apiKey === undefined) {
    return Effect.fail(selectedAccountFailure("Selected LiteLLM account credential is invalid."));
  }
  return Effect.succeed({ id: accountId, secureSettings: { LITELLM_API_KEY: apiKey } });
};

const selectedDeepSeekAccount = (
  accountId: string,
  raw: string,
): Effect.Effect<FirstPartySelectedAccount, ClassifiedFetchFailure> => {
  const apiKey = normalizeOpaqueAPIKey(raw);
  if (apiKey === undefined) {
    return Effect.fail(selectedAccountFailure("Selected DeepSeek account credential is invalid."));
  }
  return Effect.succeed({
    id: accountId,
    secureSettings: {
      DEEPSEEK_API_KEY: apiKey,
      DEEPSEEK_KEY: null,
      DEEPSEEK_PLATFORM_TOKEN: null,
      DEEPSEEK_USER_TOKEN: null,
    },
    plainSettings: {
      CODEXBAR_DEEPSEEK_PROFILE_ID: null,
      CODEXBAR_DEEPSEEK_PROFILE_SCOPE: null,
    },
  });
};

const selectedOpenAIAccount = (
  accountId: string,
  raw: string,
): Effect.Effect<FirstPartySelectedAccount, ClassifiedFetchFailure> => {
  const apiKey = normalizeOpaqueAPIKey(raw);
  if (apiKey === undefined) {
    return Effect.fail(selectedAccountFailure("Selected OpenAI account credential is invalid."));
  }
  return Effect.succeed({
    id: accountId,
    secureSettings: {
      OPENAI_ADMIN_KEY: apiKey,
      OPENAI_API_KEY: null,
    },
    plainSettings: { OPENAI_PROJECT_ID: null },
  });
};

const selectedOpenRouterAccount = (
  accountId: string,
  raw: string,
): Effect.Effect<FirstPartySelectedAccount, ClassifiedFetchFailure> => {
  const apiKey = normalizeOpaqueAPIKey(raw);
  if (apiKey === undefined) {
    return Effect.fail(
      selectedAccountFailure("Selected OpenRouter account credential is invalid."),
    );
  }
  return Effect.succeed({ id: accountId, secureSettings: { OPENROUTER_API_KEY: apiKey } });
};

const selectedGrokAccount = (
  accountId: string,
  raw: string,
): Effect.Effect<FirstPartySelectedAccount, ClassifiedFetchFailure> => {
  const route = resolveGrokCredentialRoute(raw);
  if (route === undefined) {
    return Effect.fail(selectedAccountFailure("Selected Grok account credential is invalid."));
  }
  if (route.kind === "oauth") {
    return Effect.succeed({
      id: accountId,
      secureSettings: {
        GROK_OAUTH_TOKEN: route.accessToken,
        GROK_COOKIE_HEADER: null,
      },
    });
  }
  return Effect.succeed({
    id: accountId,
    secureSettings: {
      GROK_OAUTH_TOKEN: null,
      GROK_COOKIE_HEADER: route.cookieHeader,
    },
  });
};

const selectedAntigravityAccount = (
  accountId: string,
  raw: string,
): Effect.Effect<FirstPartySelectedAccount, ClassifiedFetchFailure> => {
  const credentials = parseAntigravityOAuthCredentialValue(raw);
  if (credentials?.accessToken === undefined || credentials.accessToken.trim() === "") {
    return Effect.fail(
      selectedAccountFailure("Selected Antigravity account credential is invalid."),
    );
  }
  const accountEmail = resolveAntigravityCredentialEmail(credentials);
  return Effect.succeed({
    id: accountId,
    ...(accountEmail === undefined ? {} : { accountEmail }),
    secureSettings: {
      ANTIGRAVITY_OAUTH_ACCESS_TOKEN: explicit(credentials.accessToken),
      ANTIGRAVITY_ID_TOKEN: explicit(credentials.idToken),
    },
    plainSettings: {
      ANTIGRAVITY_ACCOUNT_EMAIL: explicit(credentials.email),
      ANTIGRAVITY_PROJECT_ID: explicit(credentials.projectID),
    },
  });
};

export const resolveSelectedFirstPartyAccountFromVault = (
  config: PersistedCodexBarConfig | undefined,
  credentials: CredentialStoreService,
  providerId: ProviderId,
): Effect.Effect<FirstPartySelectedAccount | undefined, ClassifiedFetchFailure> => {
  const providerConfig = config?.providers.find((provider) => provider.id === providerId);
  const data = providerConfig?.tokenAccounts;
  if (data === undefined || data.accounts.length === 0) return Effect.succeed(undefined);
  if (providerId === "cursor" && (providerConfig?.cookieSource ?? "auto") === "auto") {
    return Effect.succeed(undefined);
  }
  if (
    data.version !== 2 ||
    data.accounts.some((account) => hasOwnToken(account)) ||
    hasDuplicateAccountIds(data.accounts)
  ) {
    return Effect.fail(selectedAccountFailure("Selected account metadata is not vault-backed."));
  }
  const index = Math.min(Math.max(data.activeIndex, 0), data.accounts.length - 1);
  const account = data.accounts[index];
  if (account === undefined) return Effect.succeed(undefined);
  if (providerId === "codex") {
    const browserSessionCleanupPending =
      providerConfig?.pendingBrowserSessionCleanup?.accountIds.includes(account.id) === true;
    return resolveSelectedMaterial(credentials, providerId, account.id).pipe(
      Effect.flatMap((material) => selectedCodexAccount(account.id, material, account)),
      Effect.map((selected) =>
        browserSessionCleanupPending
          ? { ...selected, browserSessionCleanupPending: true }
          : selected,
      ),
    );
  }
  if (tokenAccountSupportForProvider(providerId)?.runtimeSelectionAvailable !== true) {
    return Effect.fail(
      selectedAccountFailure("Selected account provider mapper is not available."),
    );
  }
  return resolveSelectedMaterial(credentials, providerId, account.id).pipe(
    Effect.flatMap((material) => {
      if (providerId === "claude") return selectedClaudeAccount(account.id, material, account);
      if (providerId === "grok") return selectedGrokAccount(account.id, material);
      if (providerId === "zai") return selectedZaiAccount(account.id, material, account);
      if (providerId === "copilot") return selectedCopilotAccount(account.id, material, account);
      if (providerId === "deepinfra") return selectedDeepInfraAccount(account.id, material);
      if (providerId === "groq") return selectedGroqAccount(account.id, material);
      if (providerId === "venice") return selectedVeniceAccount(account.id, material);
      if (providerId === "elevenlabs") return selectedElevenLabsAccount(account.id, material);
      if (providerId === "ibmbob") return selectedIBMBobAccount(account.id, material);
      if (providerId === "neuralwatt") return selectedNeuralWattAccount(account.id, material);
      if (providerId === "sub2api") return selectedSub2APIAccount(account.id, material);
      if (providerId === "llmproxy") return selectedLLMProxyAccount(account.id, material);
      if (providerId === "litellm") return selectedLiteLLMAccount(account.id, material);
      if (providerId === "deepseek") return selectedDeepSeekAccount(account.id, material);
      if (providerId === "openai") return selectedOpenAIAccount(account.id, material);
      if (providerId === "openrouter") return selectedOpenRouterAccount(account.id, material);
      if (providerId === "abacus")
        return selectedCookieAccount(account.id, material, "ABACUS_COOKIE_HEADER", "Abacus");
      if (providerId === "augment")
        return selectedCookieAccount(account.id, material, "AUGMENT_COOKIE_HEADER", "Augment");
      if (providerId === "cursor")
        return selectedCookieAccount(account.id, material, "CURSOR_COOKIE", "Cursor");
      if (providerId === "mistral")
        return selectedCookieAccount(account.id, material, "MISTRAL_COOKIE_HEADER", "Mistral");
      if (providerId === "opencode") return selectedOpenCodeAccount(account.id, material);
      if (providerId === "opencodego") return selectedOpenCodeGoAccount(account.id, material);
      if (providerId === "manus") return selectedManusAccount(account.id, material);
      if (providerId === "stepfun") return selectedStepFunAccount(account.id, material);
      if (providerId === "ollama") return selectedOllamaAccount(account.id, material);
      if (providerId === "factory") return selectedFactoryAccount(account.id, material);
      if (providerId === "qoder") return selectedQoderAccount(account.id, material);
      if (providerId === "minimax") return selectedMiniMaxAccount(account.id, material);
      if (providerId === "antigravity") return selectedAntigravityAccount(account.id, material);
      return Effect.fail(
        selectedAccountFailure("Selected account provider mapper is not available."),
      );
    }),
  );
};
