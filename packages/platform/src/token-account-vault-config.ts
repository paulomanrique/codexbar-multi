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
import { PROVIDER_IDS, type ProviderId } from "@codexbar/contracts";
import {
  parseAntigravityOAuthCredentialValue,
  resolveAntigravityCredentialEmail,
} from "@codexbar/providers/providers/antigravity";
import type { FirstPartySelectedAccount } from "./first-party-runtime.ts";

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

const assertMetadataOnlyV2 = (config: PersistedCodexBarConfig): InfrastructureError | undefined => {
  for (const provider of config.providers) {
    const tokenAccounts = provider.tokenAccounts;
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
  }
  return undefined;
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
  repository.load.pipe(
    Effect.mapError((error) => vaultError("load config", error)),
    Effect.flatMap((freshConfig) => {
      if (freshConfig === undefined) return Effect.succeed(undefined);
      if (!containsLegacyTokenAccountData(freshConfig)) {
        const invalid = assertMetadataOnlyV2(freshConfig);
        return invalid === undefined ? Effect.succeed(freshConfig) : Effect.fail(invalid);
      }
      return migrateTokenAccountsToVault(freshConfig, repository, credentials);
    }),
  );

export const makeTokenAccountVaultConfigRepository = (
  repository: ConfigRepositoryService,
  credentials: CredentialStoreService,
  lock: TokenAccountMigrationLock,
): ConfigRepositoryService => ({
  load: repository.load.pipe(
    Effect.mapError((error) => vaultError("load config", error)),
    Effect.flatMap((config) => {
      if (config === undefined) return Effect.succeed(undefined);
      if (!containsLegacyTokenAccountData(config)) {
        const invalid = assertMetadataOnlyV2(config);
        return invalid === undefined ? Effect.succeed(config) : Effect.fail(invalid);
      }
      return lock.runExclusive(loadFreshAndMigrateUnderHeldLock(repository, credentials));
    }),
  ),
  save: (config) => {
    const invalid = assertMetadataOnlyV2(config);
    if (invalid !== undefined) return Effect.fail(invalid);
    return repository
      .save(config)
      .pipe(Effect.mapError((error) => vaultError("save config", error)));
  },
  modify: (mutation) =>
    lock.runExclusive(
      Effect.gen(function* () {
        const current = yield* loadFreshAndMigrateUnderHeldLock(repository, credentials);
        const result = yield* mutation(current);
        const invalid = assertMetadataOnlyV2(result.config);
        if (invalid !== undefined) return yield* Effect.fail(invalid);
        yield* repository
          .save(result.config)
          .pipe(Effect.mapError((error) => vaultError("save config", error)));
        return result;
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
  if (trimmed.includes("\u0000") || new TextEncoder().encode(trimmed).byteLength > 256) {
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
  const data = config?.providers.find((provider) => provider.id === providerId)?.tokenAccounts;
  if (data === undefined || data.accounts.length === 0) return Effect.succeed(undefined);
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
    return Effect.fail(
      selectedAccountFailure("Selected Codex accounts require a dedicated credential mapper."),
    );
  }
  if (
    providerId !== "claude" &&
    providerId !== "grok" &&
    providerId !== "antigravity" &&
    providerId !== "zai" &&
    providerId !== "copilot" &&
    providerId !== "deepinfra" &&
    providerId !== "groq" &&
    providerId !== "venice" &&
    providerId !== "elevenlabs"
  ) {
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
      return selectedAntigravityAccount(account.id, material);
    }),
  );
};
