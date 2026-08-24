import { Effect } from "effect";
import type {
  ProviderId,
  TokenAccountMetadataDTO,
  TokenAccountRosterDTO,
  ProviderTokenAccount,
} from "@codexbar/contracts";
import type { PersistedCodexBarConfig, PersistedProviderConfig } from "./config.ts";
import { sha256Hex } from "./sha256.ts";
import type { ConfigRepositoryService } from "./services.ts";

export interface TokenAccountSupport {
  readonly provider: ProviderId;
  readonly requiresManualCookieSource: boolean;
}

export type TokenAccountErrorCode =
  | "unsupported-provider"
  | "invalid-roster"
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
    case "invalid-roster":
      return "Token account metadata is not vault-backed.";
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

const metadataAccount = (
  account: ProviderTokenAccount,
): TokenAccountMetadataDTO => ({
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
): TokenAccountRosterDTO => {
  const data = config?.providers.find((entry) => entry.id === provider)?.tokenAccounts;
  if (data === undefined) {
    return {
      provider,
      accounts: [],
      activeIndex: 0,
      revision: rosterRevision(provider, [], 0),
    };
  }
  if (data.version !== 2 || data.accounts.some((account) => hasOwnToken(account))) {
    throw new TokenAccountRosterError("invalid-roster");
  }
  const accounts = data.accounts.map(metadataAccount);
  const activeIndex = clampActiveIndex(data.activeIndex, accounts.length);
  return {
    provider,
    accounts,
    activeIndex,
    revision: rosterRevision(provider, accounts, activeIndex),
  };
};

const providerConfig = (
  config: PersistedCodexBarConfig,
  provider: ProviderId,
): PersistedProviderConfig | undefined => config.providers.find((entry) => entry.id === provider);

export interface TokenAccountRosterServiceOptions {
  readonly config: ConfigRepositoryService;
  readonly support: ReadonlyMap<ProviderId, TokenAccountSupport>;
}

export interface TokenAccountRosterService {
  readonly list: (
    provider: ProviderId,
  ) => Effect.Effect<TokenAccountRosterDTO, TokenAccountRosterError | Error>;
  readonly select: (request: {
    readonly provider: ProviderId;
    readonly accountId: string;
    readonly expectedRevision: string;
  }) => Effect.Effect<TokenAccountRosterDTO, TokenAccountRosterError | Error>;
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
  ): Effect.Effect<TokenAccountRosterDTO, TokenAccountRosterError> =>
    Effect.try({
      try: () => projectRoster(provider, config),
      catch: (error) =>
        error instanceof TokenAccountRosterError
          ? error
          : new TokenAccountRosterError("invalid-roster"),
    });

  return {
    list: (provider) =>
      requireSupport(provider).pipe(
        Effect.flatMap(() =>
          options.config.load.pipe(
            Effect.flatMap((config) => rosterFor(provider, config)),
          ),
        ),
      ),
    select: (request) =>
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
              if (data.version !== 2 || data.accounts.some((account) => hasOwnToken(account))) {
                return yield* Effect.fail(new TokenAccountRosterError("invalid-roster"));
              }
              const currentRoster = yield* rosterFor(request.provider, config);
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
                ...(support.requiresManualCookieSource ? { cookieSource: "manual" as const } : {}),
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
              const roster = yield* rosterFor(request.provider, nextConfig);
              return {
                config: nextConfig,
                value: roster,
              };
            }),
          ),
        ),
        Effect.map((result) => result.value),
      ),
  };
};
