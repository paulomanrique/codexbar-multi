import { Effect } from "effect";
import type {
  ProviderId,
  TokenAccountMetadataDTO,
  TokenAccountRosterDTO,
  ProviderTokenAccount,
} from "@codexbar/contracts";
import type { PersistedCodexBarConfig, PersistedProviderConfig } from "./config.ts";
import { sha256Hex } from "./sha256.ts";
import type { ConfigRepositoryService, InfrastructureError } from "./services.ts";

export interface TokenAccountSupport {
  readonly provider: ProviderId;
  readonly requiresManualCookieSource: boolean;
  readonly selectedAccountRequiresManualCookieSource: boolean;
  readonly runtimeSelectionAvailable: boolean;
  readonly clearsAPIKeyOnMutation?: boolean;
}

export type TokenAccountErrorCode =
  | "unsupported-provider"
  | "selection-unavailable"
  | "invalid-roster"
  | "invalid-label"
  | "missing-roster"
  | "missing-account"
  | "stale-revision";

export class TokenAccountRosterError extends Error {
  readonly _tag = "TokenAccountRosterError";
  readonly code: TokenAccountErrorCode;

  constructor(code: TokenAccountErrorCode) {
    super(tokenAccountErrorMessage(code));
    this.name = "TokenAccountRosterError";
    this.code = code;
  }
}

const tokenAccountErrorMessage = (code: TokenAccountErrorCode): string => {
  switch (code) {
    case "unsupported-provider":
      return "Token accounts are not supported for this provider.";
    case "selection-unavailable":
      return "Token account selection is not available for this provider yet.";
    case "invalid-roster":
      return "Token account metadata is not vault-backed.";
    case "invalid-label":
      return "Token account label is invalid.";
    case "missing-roster":
      return "Token account roster is missing.";
    case "missing-account":
      return "Token account is not in the current roster.";
    case "stale-revision":
      return "Token account roster changed. Reload accounts and retry.";
  }
};

const hasOwnToken = (account: object): boolean =>
  Object.prototype.hasOwnProperty.call(account, "token");

const hasDuplicateAccountIds = (accounts: readonly ProviderTokenAccount[]): boolean => {
  const ids = new Set<string>();
  for (const account of accounts) {
    if (ids.has(account.id)) return true;
    ids.add(account.id);
  }
  return false;
};

const metadataAccount = (account: ProviderTokenAccount): TokenAccountMetadataDTO => ({
  id: account.id,
  label: account.label,
  addedAt: account.addedAt,
  ...(account.lastUsed === undefined ? {} : { lastUsed: account.lastUsed }),
  ...(account.externalIdentifier === undefined
    ? {}
    : { externalIdentifier: account.externalIdentifier }),
  ...(account.usageScope === undefined ? {} : { usageScope: account.usageScope }),
  ...(account.organizationId === undefined ? {} : { organizationId: account.organizationId }),
  ...(account.workspaceID === undefined ? {} : { workspaceID: account.workspaceID }),
});

const clampActiveIndex = (activeIndex: number, accountCount: number): number => {
  if (accountCount <= 0) return 0;
  return Math.min(Math.max(activeIndex, 0), accountCount - 1);
};

const rosterRevision = (
  provider: ProviderId,
  accounts: readonly TokenAccountMetadataDTO[],
  activeIndex: number,
): string => sha256Hex(JSON.stringify({ provider, accounts, activeIndex }));

const projectRoster = (
  provider: ProviderId,
  config: PersistedCodexBarConfig | undefined,
  selectionAvailable: boolean,
): TokenAccountRosterDTO => {
  const data = config?.providers.find((entry) => entry.id === provider)?.tokenAccounts;
  if (data === undefined) {
    return {
      provider,
      accounts: [],
      activeIndex: 0,
      selectionAvailable,
      revision: rosterRevision(provider, [], 0),
    };
  }
  if (
    data.version !== 2 ||
    data.accounts.some((account) => hasOwnToken(account)) ||
    hasDuplicateAccountIds(data.accounts)
  ) {
    throw new TokenAccountRosterError("invalid-roster");
  }
  const accounts = data.accounts.map(metadataAccount);
  const activeIndex = clampActiveIndex(data.activeIndex, accounts.length);
  return {
    provider,
    accounts,
    activeIndex,
    selectionAvailable,
    revision: rosterRevision(provider, accounts, activeIndex),
  };
};

const providerConfig = (
  config: PersistedCodexBarConfig,
  provider: ProviderId,
): PersistedProviderConfig | undefined => config.providers.find((entry) => entry.id === provider);

const normalizedRenameLabel = (label: string): string | undefined => {
  const trimmed = label.trim();
  if (trimmed.length === 0 || trimmed.length > 256 || /\p{Cc}/u.test(trimmed)) return undefined;
  return trimmed;
};

export interface TokenAccountRosterServiceOptions {
  readonly config: ConfigRepositoryService;
  readonly support: ReadonlyMap<ProviderId, TokenAccountSupport>;
}

export interface TokenAccountRosterService {
  readonly list: (
    provider: ProviderId,
  ) => Effect.Effect<TokenAccountRosterDTO, TokenAccountRosterError | InfrastructureError>;
  readonly select: (request: {
    readonly provider: ProviderId;
    readonly accountId: string;
    readonly expectedRevision: string;
  }) => Effect.Effect<TokenAccountRosterDTO, TokenAccountRosterError | InfrastructureError>;
  readonly rename: (request: {
    readonly provider: ProviderId;
    readonly accountId: string;
    readonly label: string;
    readonly expectedRevision: string;
  }) => Effect.Effect<TokenAccountRosterDTO, TokenAccountRosterError | InfrastructureError>;
  readonly remove: (request: {
    readonly provider: ProviderId;
    readonly accountId: string;
    readonly expectedRevision: string;
  }) => Effect.Effect<TokenAccountRosterDTO, TokenAccountRosterError | InfrastructureError>;
}

export const makeTokenAccountRosterService = (
  options: TokenAccountRosterServiceOptions,
): TokenAccountRosterService => {
  const requireSupport = (
    provider: ProviderId,
  ): Effect.Effect<TokenAccountSupport, TokenAccountRosterError> => {
    const support = options.support.get(provider);
    return support === undefined
      ? Effect.fail(new TokenAccountRosterError("unsupported-provider"))
      : Effect.succeed(support);
  };

  const rosterFor = (
    provider: ProviderId,
    config: PersistedCodexBarConfig | undefined,
    support: TokenAccountSupport,
  ): Effect.Effect<TokenAccountRosterDTO, TokenAccountRosterError> =>
    Effect.try({
      try: () => projectRoster(provider, config, support.runtimeSelectionAvailable),
      catch: (error) =>
        error instanceof TokenAccountRosterError
          ? error
          : new TokenAccountRosterError("invalid-roster"),
    });

  return {
    list: (provider) =>
      requireSupport(provider).pipe(
        Effect.flatMap((support) =>
          options.config.load.pipe(
            Effect.flatMap((config) => rosterFor(provider, config, support)),
          ),
        ),
      ),
    select: (request) =>
      requireSupport(request.provider).pipe(
        Effect.flatMap((support) =>
          support.runtimeSelectionAvailable
            ? options.config.modify((config) =>
                Effect.gen(function* () {
                  if (config === undefined)
                    return yield* Effect.fail(new TokenAccountRosterError("missing-roster"));
                  const provider = providerConfig(config, request.provider);
                  const data = provider?.tokenAccounts;
                  if (provider === undefined || data === undefined || data.accounts.length === 0) {
                    return yield* Effect.fail(new TokenAccountRosterError("missing-roster"));
                  }
                  if (
                    data.version !== 2 ||
                    data.accounts.some((account) => hasOwnToken(account)) ||
                    hasDuplicateAccountIds(data.accounts)
                  ) {
                    return yield* Effect.fail(new TokenAccountRosterError("invalid-roster"));
                  }
                  const currentRoster = yield* rosterFor(request.provider, config, support);
                  if (currentRoster.revision !== request.expectedRevision) {
                    return yield* Effect.fail(new TokenAccountRosterError("stale-revision"));
                  }
                  const selectedIndex = data.accounts.findIndex(
                    (account) => account.id === request.accountId,
                  );
                  if (selectedIndex < 0)
                    return yield* Effect.fail(new TokenAccountRosterError("missing-account"));
                  const nextProvider: PersistedProviderConfig = {
                    ...provider,
                    ...(support.requiresManualCookieSource
                      ? { cookieSource: "manual" as const }
                      : {}),
                    tokenAccounts: {
                      version: 2,
                      accounts: data.accounts,
                      activeIndex: selectedIndex,
                    },
                  };
                  const nextConfig: PersistedCodexBarConfig = {
                    ...config,
                    providers: config.providers.map((entry) =>
                      entry.id === request.provider ? nextProvider : entry,
                    ),
                  };
                  const roster = yield* rosterFor(request.provider, nextConfig, support);
                  return {
                    config: nextConfig,
                    value: roster,
                  };
                }),
              )
            : Effect.fail(new TokenAccountRosterError("selection-unavailable")),
        ),
        Effect.map((result) => result.value),
      ),
    rename: (request) =>
      requireSupport(request.provider).pipe(
        Effect.flatMap((support) => {
          const label = normalizedRenameLabel(request.label);
          if (label === undefined) return Effect.fail(new TokenAccountRosterError("invalid-label"));
          return options.config.modify((config) =>
            Effect.gen(function* () {
              if (config === undefined)
                return yield* Effect.fail(new TokenAccountRosterError("missing-roster"));
              const provider = providerConfig(config, request.provider);
              const data = provider?.tokenAccounts;
              if (provider === undefined || data === undefined || data.accounts.length === 0) {
                return yield* Effect.fail(new TokenAccountRosterError("missing-roster"));
              }
              if (
                data.version !== 2 ||
                data.accounts.some((account) => hasOwnToken(account)) ||
                hasDuplicateAccountIds(data.accounts)
              ) {
                return yield* Effect.fail(new TokenAccountRosterError("invalid-roster"));
              }
              const currentRoster = yield* rosterFor(request.provider, config, support);
              if (currentRoster.revision !== request.expectedRevision) {
                return yield* Effect.fail(new TokenAccountRosterError("stale-revision"));
              }
              const accountIndex = data.accounts.findIndex(
                (account) => account.id === request.accountId,
              );
              if (accountIndex < 0)
                return yield* Effect.fail(new TokenAccountRosterError("missing-account"));
              const accounts = data.accounts.map((account, index) =>
                index === accountIndex ? { ...account, label } : account,
              );
              const nextProvider: PersistedProviderConfig = {
                ...provider,
                tokenAccounts: {
                  version: 2,
                  accounts,
                  activeIndex: currentRoster.activeIndex,
                },
              };
              const nextConfig: PersistedCodexBarConfig = {
                ...config,
                providers: config.providers.map((entry) =>
                  entry.id === request.provider ? nextProvider : entry,
                ),
              };
              const roster = yield* rosterFor(request.provider, nextConfig, support);
              return {
                config: nextConfig,
                value: roster,
              };
            }),
          );
        }),
        Effect.map((result) => result.value),
      ),
    remove: (request) =>
      requireSupport(request.provider).pipe(
        Effect.flatMap((support) =>
          options.config.modify((config) =>
            Effect.gen(function* () {
              if (config === undefined)
                return yield* Effect.fail(new TokenAccountRosterError("missing-roster"));
              const provider = providerConfig(config, request.provider);
              const data = provider?.tokenAccounts;
              if (provider === undefined || data === undefined || data.accounts.length === 0) {
                return yield* Effect.fail(new TokenAccountRosterError("missing-roster"));
              }
              if (
                data.version !== 2 ||
                data.accounts.some((account) => hasOwnToken(account)) ||
                hasDuplicateAccountIds(data.accounts)
              ) {
                return yield* Effect.fail(new TokenAccountRosterError("invalid-roster"));
              }
              const currentRoster = yield* rosterFor(request.provider, config, support);
              if (currentRoster.revision !== request.expectedRevision) {
                return yield* Effect.fail(new TokenAccountRosterError("stale-revision"));
              }
              const removedIndex = data.accounts.findIndex(
                (account) => account.id === request.accountId,
              );
              if (removedIndex < 0)
                return yield* Effect.fail(new TokenAccountRosterError("missing-account"));
              const activeAccount = data.accounts[currentRoster.activeIndex];
              const filtered = data.accounts.filter((account) => account.id !== request.accountId);
              const { apiKey: _apiKey, tokenAccounts: _tokenAccounts, ...providerBase } = provider;
              const preservedProvider = support.clearsAPIKeyOnMutation
                ? providerBase
                : {
                    ...providerBase,
                    ...(provider.apiKey === undefined ? {} : { apiKey: provider.apiKey }),
                  };
              let nextProvider: PersistedProviderConfig;
              if (filtered.length === 0) {
                nextProvider = preservedProvider;
              } else {
                const preservedActiveIndex =
                  activeAccount?.id === request.accountId
                    ? -1
                    : filtered.findIndex((account) => account.id === activeAccount?.id);
                const activeIndex =
                  preservedActiveIndex >= 0
                    ? preservedActiveIndex
                    : Math.min(removedIndex, filtered.length - 1);
                nextProvider = {
                  ...preservedProvider,
                  tokenAccounts: { version: 2, accounts: filtered, activeIndex },
                };
              }
              const nextConfig: PersistedCodexBarConfig = {
                ...config,
                providers: config.providers.map((entry) =>
                  entry.id === request.provider ? nextProvider : entry,
                ),
              };
              const roster = yield* rosterFor(request.provider, nextConfig, support);
              return { config: nextConfig, value: roster };
            }),
          ),
        ),
        Effect.map((result) => result.value),
      ),
  };
};
