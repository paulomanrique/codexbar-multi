import {
  PROVIDER_IDS,
  type HookEventType,
  type ProviderCookieSource,
  type ProviderId,
  type ProviderSourceMode,
  type ProviderTokenAccount,
  type ProviderTokenAccountData,
  type PendingTokenAccountDeletion,
  type QuotaWarningConfig,
} from "@codexbar/contracts";

/** Swift's `CodexBarConfig.currentVersion` at baseline 453174fe. */
export const CODEXBAR_CONFIG_VERSION = 1;

const providerIdSet = new Set<string>(PROVIDER_IDS);
const instanceIdPattern = /^[a-z0-9-]{1,64}$/;
const sourceModes = new Set<ProviderSourceMode>(["auto", "web", "cli", "oauth", "api"]);
const cookieSources = new Set<ProviderCookieSource>(["auto", "manual", "off"]);
const hookEvents = new Set<HookEventType>([
  "quota_low",
  "quota_reached",
  "quota_reset",
  "provider_unavailable",
  "provider_recovered",
  "refresh_failed",
]);

export type ConfigJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ConfigJsonValue[]
  | { readonly [key: string]: ConfigJsonValue };

/**
 * `ProviderConfigCoding.swift` stores provider extensions as flattened JSON
 * keys. Keeping them separate in memory prevents generic config fields from
 * colliding with provider-owned values while `encodeCodexBarConfig` restores
 * the original wire shape.
 */
export interface PersistedProviderConfig {
  readonly id: string;
  readonly enabled?: boolean;
  readonly source?: ProviderSourceMode;
  readonly extrasEnabled?: boolean;
  readonly apiKey?: string;
  readonly secretKey?: string;
  readonly cookieHeader?: string;
  readonly cookieSource?: ProviderCookieSource;
  readonly region?: string;
  readonly workspaceID?: string;
  readonly enterpriseHost?: string;
  readonly tokenAccounts?: ProviderTokenAccountData;
  /** Host-only, non-secret recovery marker; never projected to renderer DTOs. */
  readonly pendingTokenAccountDeletion?: PendingTokenAccountDeletion;
  readonly quotaWarnings?: QuotaWarningConfig;
  readonly accentColor?: string;
  readonly pluginSettings?: Readonly<Record<string, string>>;
  readonly pluginSecrets?: Readonly<Record<string, string>>;
  readonly extensions: Readonly<Record<string, ConfigJsonValue>>;
}

export interface PersistedHookRule {
  readonly id: string;
  readonly enabled: boolean;
  readonly event: HookEventType;
  readonly provider?: string;
  readonly threshold?: number;
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly timeoutSeconds: number;
}

export interface PersistedHooksConfig {
  readonly enabled: boolean;
  readonly events: readonly PersistedHookRule[];
}

export interface PersistedCodexBarConfig {
  readonly version: number;
  readonly providers: readonly PersistedProviderConfig[];
  readonly hooks?: PersistedHooksConfig;
  /** Swift defaults this opt-out preference to true when it is absent. */
  readonly sessionQuotaNotificationsEnabled?: boolean;
}

export class ConfigDecodeError extends Error {
  readonly _tag = "ConfigDecodeError";

  constructor(message: string) {
    super(message);
    this.name = "ConfigDecodeError";
  }
}

export interface DecodeCodexBarConfigOptions {
  /** Registered plugin instance IDs are permitted alongside the fixed upstream roster. */
  readonly pluginProviderIds?: ReadonlySet<string>;
  /** Injected for deterministic import tests; Swift creates a UUID when legacy rules omit an id. */
  readonly createHookId?: () => string;
}

const providerFields = new Set([
  "id",
  "enabled",
  "source",
  "extrasEnabled",
  "apiKey",
  "secretKey",
  "cookieHeader",
  "cookieSource",
  "region",
  "workspaceID",
  "enterpriseHost",
  "tokenAccounts",
  "pendingTokenAccountDeletion",
  "quotaWarnings",
  "accentColor",
  "pluginSettings",
  "pluginSecrets",
]);

const own = (value: Record<string, unknown>, key: string): unknown => value[key];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const optionalString = (value: unknown, path: string): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ConfigDecodeError(`${path} must be a string.`);
  return value;
};

const optionalBoolean = (value: unknown, path: string): boolean | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new ConfigDecodeError(`${path} must be a boolean.`);
  return value;
};

const optionalNumber = (value: unknown, path: string): number | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ConfigDecodeError(`${path} must be a finite number.`);
  }
  return value;
};

const optionalStringRecord = (
  value: unknown,
  path: string,
): Readonly<Record<string, string>> | undefined => {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new ConfigDecodeError(`${path} must be an object.`);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") throw new ConfigDecodeError(`${path}.${key} must be a string.`);
    result[key] = entry;
  }
  return result;
};

const optionalPendingTokenAccountDeletion = (
  value: unknown,
  path: string,
): PendingTokenAccountDeletion | undefined => {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new ConfigDecodeError(`${path} must be an object.`);
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "version" && key !== "accountId")) {
    throw new ConfigDecodeError(`${path} contains unsupported fields.`);
  }
  const version = optionalNumber(own(value, "version"), `${path}.version`);
  if (version !== 1) throw new ConfigDecodeError(`${path}.version is invalid.`);
  const accountId = optionalString(own(value, "accountId"), `${path}.accountId`);
  if (
    accountId === undefined ||
    accountId.length === 0 ||
    accountId.length > 256 ||
    /\p{Cc}/u.test(accountId)
  ) {
    throw new ConfigDecodeError(`${path}.accountId is invalid.`);
  }
  return { version: 1, accountId };
};

const jsonValue = (value: unknown, path: string): ConfigJsonValue => {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ConfigDecodeError(`${path} must be JSON-compatible.`);
    return value;
  }
  if (Array.isArray(value))
    return value.map((entry, index) => jsonValue(entry, `${path}[${index}]`));
  if (!isRecord(value)) throw new ConfigDecodeError(`${path} must be JSON-compatible.`);
  const result: Record<string, ConfigJsonValue> = {};
  for (const [key, entry] of Object.entries(value))
    result[key] = jsonValue(entry, `${path}.${key}`);
  return result;
};

const optionalMode = (value: unknown, path: string): ProviderSourceMode | undefined => {
  const string = optionalString(value, path);
  if (string === undefined) return undefined;
  if (!sourceModes.has(string as ProviderSourceMode))
    throw new ConfigDecodeError(`${path} is invalid.`);
  return string as ProviderSourceMode;
};

const optionalCookieSource = (value: unknown, path: string): ProviderCookieSource | undefined => {
  const string = optionalString(value, path);
  if (string === undefined) return undefined;
  if (!cookieSources.has(string as ProviderCookieSource))
    throw new ConfigDecodeError(`${path} is invalid.`);
  return string as ProviderCookieSource;
};

const optionalTokenAccounts = (
  value: unknown,
  path: string,
): ProviderTokenAccountData | undefined => {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new ConfigDecodeError(`${path} must be an object.`);
  const version = optionalNumber(own(value, "version"), `${path}.version`);
  const activeIndex = optionalNumber(own(value, "activeIndex"), `${path}.activeIndex`);
  const accountsValue = own(value, "accounts");
  if (version === undefined || !Number.isInteger(version)) {
    throw new ConfigDecodeError(`${path}.version must be an integer.`);
  }
  if (activeIndex === undefined || !Number.isInteger(activeIndex)) {
    throw new ConfigDecodeError(`${path}.activeIndex must be an integer.`);
  }
  if (!Array.isArray(accountsValue))
    throw new ConfigDecodeError(`${path}.accounts must be an array.`);
  if (version !== 1 && version !== 2) {
    throw new ConfigDecodeError(`${path}.version is unsupported.`);
  }
  const accounts: ProviderTokenAccount[] = accountsValue.map((account, index) => {
    const itemPath = `${path}.accounts[${index}]`;
    if (!isRecord(account)) throw new ConfigDecodeError(`${itemPath} must be an object.`);
    const containsToken = Object.prototype.hasOwnProperty.call(account, "token");
    if (version === 1 && !containsToken) {
      throw new ConfigDecodeError(`${itemPath}.token is required for tokenAccounts v1.`);
    }
    if (version === 2 && containsToken) {
      throw new ConfigDecodeError(`${itemPath}.token is not permitted for tokenAccounts v2.`);
    }
    const id = optionalString(own(account, "id"), `${itemPath}.id`);
    const label = optionalString(own(account, "label"), `${itemPath}.label`);
    const token = optionalString(own(account, "token"), `${itemPath}.token`);
    const addedAt = optionalNumber(own(account, "addedAt"), `${itemPath}.addedAt`);
    if (
      id === undefined ||
      label === undefined ||
      (version === 1 && token === undefined) ||
      addedAt === undefined
    ) {
      throw new ConfigDecodeError(`${itemPath} is missing a required field.`);
    }
    const lastUsed = optionalNumber(own(account, "lastUsed"), `${itemPath}.lastUsed`);
    const externalIdentifier = optionalString(
      own(account, "externalIdentifier"),
      `${itemPath}.externalIdentifier`,
    );
    const usageScope = optionalString(own(account, "usageScope"), `${itemPath}.usageScope`);
    const organizationId = optionalString(
      own(account, "organizationId"),
      `${itemPath}.organizationId`,
    );
    const workspaceID = optionalString(own(account, "workspaceID"), `${itemPath}.workspaceID`);
    return {
      id,
      label,
      ...(token === undefined ? {} : { token }),
      addedAt,
      ...(lastUsed === undefined ? {} : { lastUsed }),
      ...(externalIdentifier === undefined ? {} : { externalIdentifier }),
      ...(usageScope === undefined ? {} : { usageScope }),
      ...(organizationId === undefined ? {} : { organizationId }),
      ...(workspaceID === undefined ? {} : { workspaceID }),
    };
  });
  return { version, accounts, activeIndex };
};

const optionalQuotaWarnings = (value: unknown, path: string): QuotaWarningConfig | undefined => {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new ConfigDecodeError(`${path} must be an object.`);
  const decodeWindow = (entry: unknown, entryPath: string) => {
    if (entry === undefined || entry === null) return undefined;
    if (!isRecord(entry)) throw new ConfigDecodeError(`${entryPath} must be an object.`);
    const enabled = optionalBoolean(own(entry, "enabled"), `${entryPath}.enabled`);
    const thresholdsValue = own(entry, "thresholds");
    let thresholds: readonly number[] | undefined;
    if (thresholdsValue !== undefined && thresholdsValue !== null) {
      if (!Array.isArray(thresholdsValue))
        throw new ConfigDecodeError(`${entryPath}.thresholds must be an array.`);
      thresholds = thresholdsValue.map((threshold, index) => {
        const decoded = optionalNumber(threshold, `${entryPath}.thresholds[${index}]`);
        if (decoded === undefined || !Number.isInteger(decoded)) {
          throw new ConfigDecodeError(`${entryPath}.thresholds[${index}] must be an integer.`);
        }
        return decoded;
      });
    }
    return {
      ...(thresholds === undefined ? {} : { thresholds: [...thresholds] }),
      ...(enabled === undefined ? {} : { enabled }),
    };
  };
  const session = decodeWindow(own(value, "session"), `${path}.session`);
  const weekly = decodeWindow(own(value, "weekly"), `${path}.weekly`);
  return {
    ...(session === undefined ? {} : { session }),
    ...(weekly === undefined ? {} : { weekly }),
  };
};

const defaultHookId = (): string => {
  const random = globalThis.crypto?.randomUUID;
  return random === undefined
    ? `legacy-hook-${Math.random().toString(36).slice(2)}`
    : random.call(globalThis.crypto);
};

const decodeHooks = (
  value: unknown,
  createHookId: () => string,
): PersistedHooksConfig | undefined => {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new ConfigDecodeError("hooks must be an object.");
  const enabled = optionalBoolean(own(value, "enabled"), "hooks.enabled") ?? false;
  const eventsValue = own(value, "events");
  if (eventsValue !== undefined && eventsValue !== null && !Array.isArray(eventsValue)) {
    throw new ConfigDecodeError("hooks.events must be an array.");
  }
  const events: PersistedHookRule[] = (eventsValue ?? []).map((entry, index) => {
    const path = `hooks.events[${index}]`;
    if (!isRecord(entry)) throw new ConfigDecodeError(`${path} must be an object.`);
    const id = optionalString(own(entry, "id"), `${path}.id`) ?? createHookId();
    const event = optionalString(own(entry, "event"), `${path}.event`);
    const executable = optionalString(own(entry, "executable"), `${path}.executable`);
    if (
      event === undefined ||
      !hookEvents.has(event as HookEventType) ||
      executable === undefined
    ) {
      throw new ConfigDecodeError(`${path} is missing a required or valid field.`);
    }
    const argumentsValue = own(entry, "arguments");
    if (argumentsValue !== undefined && argumentsValue !== null && !Array.isArray(argumentsValue)) {
      throw new ConfigDecodeError(`${path}.arguments must be an array.`);
    }
    const arguments_ = (argumentsValue ?? []).map((argument, argumentIndex) => {
      if (typeof argument !== "string") {
        throw new ConfigDecodeError(`${path}.arguments[${argumentIndex}] must be a string.`);
      }
      return argument;
    });
    const provider = optionalString(own(entry, "provider"), `${path}.provider`);
    const threshold = optionalNumber(own(entry, "threshold"), `${path}.threshold`);
    return {
      id,
      enabled: optionalBoolean(own(entry, "enabled"), `${path}.enabled`) ?? true,
      event: event as HookEventType,
      ...(provider === undefined ? {} : { provider }),
      ...(threshold === undefined ? {} : { threshold }),
      executable,
      arguments: arguments_,
      timeoutSeconds: optionalNumber(own(entry, "timeoutSeconds"), `${path}.timeoutSeconds`) ?? 10,
    };
  });
  return { enabled, events };
};

/** Decode the Swift JSON shape and deliberately ignore removed/unregistered provider entries. */
export const decodeCodexBarConfig = (
  value: unknown,
  options: DecodeCodexBarConfigOptions = {},
): PersistedCodexBarConfig => {
  if (!isRecord(value)) throw new ConfigDecodeError("Config must be an object.");
  const version = optionalNumber(own(value, "version"), "version");
  if (version === undefined || !Number.isInteger(version)) {
    throw new ConfigDecodeError("version must be an integer.");
  }
  const rawProviders = own(value, "providers");
  if (!Array.isArray(rawProviders)) throw new ConfigDecodeError("providers must be an array.");
  const allowed = new Set<string>([...providerIdSet, ...(options.pluginProviderIds ?? [])]);
  const providers: PersistedProviderConfig[] = [];
  for (const [index, rawProvider] of rawProviders.entries()) {
    const path = `providers[${index}]`;
    if (!isRecord(rawProvider)) throw new ConfigDecodeError(`${path} must be an object.`);
    const id = optionalString(own(rawProvider, "id"), `${path}.id`);
    if (id === undefined || !instanceIdPattern.test(id))
      throw new ConfigDecodeError(`${path}.id is invalid.`);
    // This is intentionally before field decoding: removed providers can retain old shapes forever.
    if (!allowed.has(id)) continue;
    const extensions: Record<string, ConfigJsonValue> = {};
    for (const [key, entry] of Object.entries(rawProvider)) {
      if (!providerFields.has(key) && entry !== null)
        extensions[key] = jsonValue(entry, `${path}.${key}`);
    }
    const enabled = optionalBoolean(own(rawProvider, "enabled"), `${path}.enabled`);
    const source = optionalMode(own(rawProvider, "source"), `${path}.source`);
    const extrasEnabled = optionalBoolean(
      own(rawProvider, "extrasEnabled"),
      `${path}.extrasEnabled`,
    );
    const apiKey = optionalString(own(rawProvider, "apiKey"), `${path}.apiKey`);
    const secretKey = optionalString(own(rawProvider, "secretKey"), `${path}.secretKey`);
    const cookieHeader = optionalString(own(rawProvider, "cookieHeader"), `${path}.cookieHeader`);
    const cookieSource = optionalCookieSource(
      own(rawProvider, "cookieSource"),
      `${path}.cookieSource`,
    );
    const region = optionalString(own(rawProvider, "region"), `${path}.region`);
    const workspaceID = optionalString(own(rawProvider, "workspaceID"), `${path}.workspaceID`);
    const enterpriseHost = optionalString(
      own(rawProvider, "enterpriseHost"),
      `${path}.enterpriseHost`,
    );
    const tokenAccounts = optionalTokenAccounts(
      own(rawProvider, "tokenAccounts"),
      `${path}.tokenAccounts`,
    );
    const pendingTokenAccountDeletion = optionalPendingTokenAccountDeletion(
      own(rawProvider, "pendingTokenAccountDeletion"),
      `${path}.pendingTokenAccountDeletion`,
    );
    const quotaWarnings = optionalQuotaWarnings(
      own(rawProvider, "quotaWarnings"),
      `${path}.quotaWarnings`,
    );
    const accentColor = optionalString(own(rawProvider, "accentColor"), `${path}.accentColor`);
    const pluginSettings = optionalStringRecord(
      own(rawProvider, "pluginSettings"),
      `${path}.pluginSettings`,
    );
    const pluginSecrets = optionalStringRecord(
      own(rawProvider, "pluginSecrets"),
      `${path}.pluginSecrets`,
    );
    providers.push({
      id,
      ...(enabled === undefined ? {} : { enabled }),
      ...(source === undefined ? {} : { source }),
      ...(extrasEnabled === undefined ? {} : { extrasEnabled }),
      ...(apiKey === undefined ? {} : { apiKey }),
      ...(secretKey === undefined ? {} : { secretKey }),
      ...(cookieHeader === undefined ? {} : { cookieHeader }),
      ...(cookieSource === undefined ? {} : { cookieSource }),
      ...(region === undefined ? {} : { region }),
      ...(workspaceID === undefined ? {} : { workspaceID }),
      ...(enterpriseHost === undefined ? {} : { enterpriseHost }),
      ...(tokenAccounts === undefined ? {} : { tokenAccounts }),
      ...(pendingTokenAccountDeletion === undefined ? {} : { pendingTokenAccountDeletion }),
      ...(quotaWarnings === undefined ? {} : { quotaWarnings }),
      ...(accentColor === undefined ? {} : { accentColor }),
      ...(pluginSettings === undefined ? {} : { pluginSettings }),
      ...(pluginSecrets === undefined ? {} : { pluginSecrets }),
      extensions,
    });
  }
  const hooks = decodeHooks(own(value, "hooks"), options.createHookId ?? defaultHookId);
  const sessionQuotaNotificationsEnabled = optionalBoolean(
    own(value, "sessionQuotaNotificationsEnabled"),
    "sessionQuotaNotificationsEnabled",
  );
  return {
    version,
    providers,
    ...(hooks === undefined ? {} : { hooks }),
    ...(sessionQuotaNotificationsEnabled === undefined ? {} : { sessionQuotaNotificationsEnabled }),
  };
};

const omitUndefined = (value: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));

/** Encode with Swift's `encodeIfPresent` omissions and flattened extension keys. */
export const encodeCodexBarConfig = (config: PersistedCodexBarConfig): Record<string, unknown> => ({
  version: config.version,
  providers: config.providers.map((provider) => ({
    ...provider.extensions,
    ...omitUndefined({
      id: provider.id,
      enabled: provider.enabled,
      source: provider.source,
      extrasEnabled: provider.extrasEnabled,
      apiKey: provider.apiKey,
      secretKey: provider.secretKey,
      cookieHeader: provider.cookieHeader,
      cookieSource: provider.cookieSource,
      region: provider.region,
      workspaceID: provider.workspaceID,
      enterpriseHost: provider.enterpriseHost,
      tokenAccounts: provider.tokenAccounts,
      pendingTokenAccountDeletion: provider.pendingTokenAccountDeletion,
      quotaWarnings: provider.quotaWarnings,
      accentColor: provider.accentColor,
      pluginSettings: provider.pluginSettings,
      pluginSecrets: provider.pluginSecrets,
    }),
  })),
  ...(config.hooks === undefined ? {} : { hooks: config.hooks }),
  ...(config.sessionQuotaNotificationsEnabled === undefined
    ? {}
    : { sessionQuotaNotificationsEnabled: config.sessionQuotaNotificationsEnabled }),
});

export const cleanConfigString = (raw: string | undefined): string | undefined => {
  let value = raw?.trim();
  if (value === undefined || value.length === 0) return undefined;
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1).trim();
  }
  return value.length === 0 ? undefined : value;
};

export interface ConfigProviderMetadata {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly defaultEnabled: boolean;
}

export const defaultConfigProviderMetadata = (): readonly ConfigProviderMetadata[] =>
  PROVIDER_IDS.map((id) => ({ id, displayName: id, defaultEnabled: id === "codex" }));

const defaultProvider = (id: ProviderId, region: string): PersistedProviderConfig => ({
  id,
  enabled: id === "codex",
  ...(id === "alibabatokenplan" ? { region } : {}),
  extensions: {},
});

/** Same source order/defaults as `CodexBarConfig.makeDefault()`. */
export const makeDefaultCodexBarConfig = (
  metadata: readonly ConfigProviderMetadata[] = defaultConfigProviderMetadata(),
): PersistedCodexBarConfig => {
  const enabledById = new Map(metadata.map((entry) => [entry.id, entry.defaultEnabled]));
  return {
    version: CODEXBAR_CONFIG_VERSION,
    providers: PROVIDER_IDS.map((id) => ({
      ...defaultProvider(id, "international"),
      enabled: enabledById.get(id) ?? false,
    })),
    sessionQuotaNotificationsEnabled: true,
  };
};

export type ProviderConfigNormalizer = (config: PersistedProviderConfig) => PersistedProviderConfig;

/**
 * Deduplicate in stored order, normalize registered provider fields, then add
 * missing first-party providers. Existing Alibaba Token Plan config keeps its
 * legacy region; a newly-added entry defaults to China mainland.
 */
export const normalizeCodexBarConfig = (
  config: PersistedCodexBarConfig,
  normalizers: Readonly<Record<string, ProviderConfigNormalizer>> = {},
): PersistedCodexBarConfig => {
  const seen = new Set<string>();
  const providers: PersistedProviderConfig[] = [];
  for (const entry of config.providers) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    providers.push(normalizers[entry.id]?.(entry) ?? entry);
  }
  for (const id of PROVIDER_IDS) {
    if (!seen.has(id)) providers.push(defaultProvider(id, "china-mainland"));
  }
  return {
    version: CODEXBAR_CONFIG_VERSION,
    providers,
    ...(config.hooks === undefined ? {} : { hooks: config.hooks }),
    ...(config.sessionQuotaNotificationsEnabled === undefined
      ? {}
      : { sessionQuotaNotificationsEnabled: config.sessionQuotaNotificationsEnabled }),
  };
};

/** The two upstream descriptor normalizers at baseline 453174fe. */
export const DEFAULT_PROVIDER_CONFIG_NORMALIZERS: Readonly<
  Record<string, ProviderConfigNormalizer>
> = {
  moonshot: (config) => {
    if (
      cleanConfigString(config.apiKey) === undefined ||
      cleanConfigString(extensionString(config, "apiKeyRegion")) !== undefined
    ) {
      return config;
    }
    return setExtension(
      config,
      "apiKeyRegion",
      cleanConfigString(config.region) ?? "international",
    );
  },
  deepseek: (config) =>
    setExtension(
      setExtension(
        config,
        "deepseekProfileID",
        cleanConfigString(extensionString(config, "deepseekProfileID")),
      ),
      "deepseekProfileScope",
      cleanConfigString(extensionString(config, "deepseekProfileScope")),
    ),
};

export const extensionString = (
  config: PersistedProviderConfig,
  key: string,
): string | undefined => {
  const value = config.extensions[key];
  return typeof value === "string" ? value : undefined;
};

export const setExtension = (
  config: PersistedProviderConfig,
  key: string,
  value: ConfigJsonValue | undefined,
): PersistedProviderConfig => {
  if (providerFields.has(key))
    throw new Error(`Provider extension key collides with generic key: ${key}`);
  const extensions = { ...config.extensions } as Record<string, ConfigJsonValue>;
  if (value === undefined) delete extensions[key];
  else extensions[key] = value;
  return { ...config, extensions };
};

export const sanitizedProviderConfigForDump = (
  config: PersistedProviderConfig,
  showSecrets = false,
): PersistedProviderConfig => {
  if (showSecrets) return config;
  const redactAccounts =
    config.tokenAccounts === undefined
      ? undefined
      : {
          ...config.tokenAccounts,
          accounts: config.tokenAccounts.accounts.map((account) => ({
            ...account,
            ...(account.token === undefined ? {} : { token: "[REDACTED]" }),
          })),
        };
  return {
    ...config,
    ...(config.apiKey === undefined ? {} : { apiKey: "[REDACTED]" }),
    ...(config.secretKey === undefined ? {} : { secretKey: "[REDACTED]" }),
    ...(config.cookieHeader === undefined ? {} : { cookieHeader: "[REDACTED]" }),
    ...(config.pluginSecrets === undefined
      ? {}
      : {
          pluginSecrets: Object.fromEntries(
            Object.keys(config.pluginSecrets).map((key) => [key, "[REDACTED]"]),
          ),
        }),
    ...(redactAccounts === undefined ? {} : { tokenAccounts: redactAccounts }),
  };
};

export const sanitizedCodexBarConfigForDump = (
  config: PersistedCodexBarConfig,
  showSecrets = false,
): PersistedCodexBarConfig => ({
  ...config,
  providers: config.providers.map((provider) =>
    sanitizedProviderConfigForDump(provider, showSecrets),
  ),
});

export const orderedProviders = (config: PersistedCodexBarConfig): readonly string[] =>
  config.providers.map((provider) => provider.id);

export const enabledProviders = (
  config: PersistedCodexBarConfig,
  metadata: readonly ConfigProviderMetadata[] = defaultConfigProviderMetadata(),
): readonly string[] => {
  const defaults = new Map(metadata.map((entry) => [entry.id, entry.defaultEnabled]));
  return config.providers
    .filter((provider) => provider.enabled ?? defaults.get(provider.id as ProviderId) ?? false)
    .map((provider) => provider.id);
};

export const alphabeticalProviderOrder = (
  metadata: readonly ConfigProviderMetadata[],
  enablement: (provider: ProviderId) => boolean,
): readonly ProviderId[] =>
  [...PROVIDER_IDS].sort((left, right) => {
    const leftEnabled = enablement(left);
    const rightEnabled = enablement(right);
    if (leftEnabled !== rightEnabled) return leftEnabled ? -1 : 1;
    const leftName = metadata.find((entry) => entry.id === left)?.displayName ?? left;
    const rightName = metadata.find((entry) => entry.id === right)?.displayName ?? right;
    const comparison = leftName.localeCompare(rightName, undefined, { sensitivity: "accent" });
    return comparison === 0 ? left.localeCompare(right) : comparison;
  });

export type ConfigIssueSeverity = "warning" | "error";

export interface CodexBarConfigIssue {
  readonly severity: ConfigIssueSeverity;
  readonly provider?: ProviderId;
  readonly field?: string;
  readonly code: string;
  readonly message: string;
}

export interface ConfigProviderCapabilities {
  readonly id: ProviderId;
  readonly sourceModes: readonly ProviderSourceMode[];
  readonly requiresApiKeyForApiSource?: boolean;
  readonly usesSecretKey?: boolean;
  readonly usesRegion?: boolean;
  readonly supportsWorkspaceID?: boolean;
  readonly workspaceIDValidationOrder?: number;
  readonly supportsEnterpriseHost?: boolean;
  readonly supportsTokenAccounts?: boolean;
  /** Receives known provider fields and extensions for provider-specific validation. */
  readonly validate?: (config: PersistedProviderConfig) => readonly CodexBarConfigIssue[];
}

export interface ValidateCodexBarConfigOptions {
  readonly providers?: readonly ConfigProviderCapabilities[];
}

const issue = (
  severity: ConfigIssueSeverity,
  provider: ProviderId | undefined,
  field: string | undefined,
  code: string,
  message: string,
): CodexBarConfigIssue => ({
  severity,
  ...(provider === undefined ? {} : { provider }),
  ...(field === undefined ? {} : { field }),
  code,
  message,
});

const formatProviderList = (ids: readonly ProviderId[]): string => {
  const last = ids.at(-1);
  if (last === undefined) return "";
  return ids.length === 1 ? last : `${ids.slice(0, -1).join(", ")}, and ${last}`;
};

const configuredApiCredential = (entry: PersistedProviderConfig): boolean =>
  cleanConfigString(entry.apiKey) !== undefined ||
  (entry.tokenAccounts?.version === 2 && entry.tokenAccounts.accounts.length > 0) ||
  (entry.tokenAccounts?.accounts.some(
    (account) => cleanConfigString(account.token) !== undefined,
  ) ??
    false);

/**
 * Platform-neutral absolute-path check. Node's `path.isAbsolute` is host-OS
 * dependent, so it would reject a Windows-configured hook while validating on
 * Linux (and vice versa).
 */
const isPortableAbsoluteExecutablePath = (path: string): boolean =>
  path.startsWith("/") ||
  /^[A-Za-z]:[\\/]/.test(path) ||
  /^\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(path);

const validateHooks = (hooks: PersistedHooksConfig | undefined): CodexBarConfigIssue[] => {
  if (hooks === undefined) return [];
  const issues: CodexBarConfigIssue[] = [];
  const ids = new Set<string>();
  if (hooks.events.length > 32) {
    issues.push(
      issue(
        "error",
        undefined,
        "hooks.events",
        "too_many_hook_rules",
        "Hooks support at most 32 rules.",
      ),
    );
  }
  for (const [index, rule] of hooks.events.entries()) {
    const field = `hooks.events[${index}]`;
    if (ids.has(rule.id))
      issues.push(
        issue("error", undefined, field, "duplicate_hook_id", "Hook rule IDs must be unique."),
      );
    ids.add(rule.id);
    if (
      !isPortableAbsoluteExecutablePath(rule.executable) ||
      rule.executable.length === 0 ||
      new TextEncoder().encode(rule.executable).length > 4096
    ) {
      issues.push(
        issue(
          "error",
          undefined,
          `${field}.executable`,
          "invalid_hook_executable",
          "Hook executables must use a non-empty absolute path.",
        ),
      );
    }
    if (rule.provider !== undefined && !providerIdSet.has(rule.provider)) {
      issues.push(
        issue(
          "error",
          undefined,
          `${field}.provider`,
          "invalid_hook_provider",
          `Hook provider '${rule.provider}' is not recognized.`,
        ),
      );
    }
    if (
      rule.threshold !== undefined &&
      (!Number.isFinite(rule.threshold) || rule.threshold <= 0 || rule.threshold > 1)
    ) {
      issues.push(
        issue(
          "error",
          undefined,
          `${field}.threshold`,
          "invalid_hook_threshold",
          "Hook thresholds must be greater than 0 and at most 1.",
        ),
      );
    }
    if (
      !Number.isFinite(rule.timeoutSeconds) ||
      rule.timeoutSeconds < 0.1 ||
      rule.timeoutSeconds > 300
    ) {
      issues.push(
        issue(
          "error",
          undefined,
          `${field}.timeoutSeconds`,
          "invalid_hook_timeout",
          "Hook timeouts must be between 0.1 and 300 seconds.",
        ),
      );
    }
    const totalBytes =
      new TextEncoder().encode(rule.executable).length +
      rule.arguments.reduce((sum, argument) => sum + new TextEncoder().encode(argument).length, 0);
    if (
      rule.id.length === 0 ||
      new TextEncoder().encode(rule.id).length > 128 ||
      rule.arguments.length > 32 ||
      rule.arguments.some((argument) => new TextEncoder().encode(argument).length > 4096) ||
      totalBytes > 32 * 1024
    ) {
      issues.push(
        issue(
          "error",
          undefined,
          field,
          "invalid_hook_command_size",
          "Hook IDs, arguments, or aggregate command size exceed supported limits.",
        ),
      );
    }
  }
  return issues;
};

/** Descriptor-driven validation equivalent to `CodexBarConfigValidator`. */
export const validateCodexBarConfig = (
  config: PersistedCodexBarConfig,
  options: ValidateCodexBarConfigOptions = {},
): readonly CodexBarConfigIssue[] => {
  const issues: CodexBarConfigIssue[] = [];
  if (config.version !== CODEXBAR_CONFIG_VERSION) {
    issues.push(
      issue(
        "error",
        undefined,
        "version",
        "version_mismatch",
        `Unsupported config version ${config.version}.`,
      ),
    );
  }
  const capabilities = new Map(
    (options.providers ?? []).map((provider) => [provider.id, provider]),
  );
  const workspaceIds = [...capabilities.values()]
    .filter((provider) => provider.supportsWorkspaceID)
    .sort(
      (left, right) =>
        (left.workspaceIDValidationOrder ?? Number.MAX_SAFE_INTEGER) -
        (right.workspaceIDValidationOrder ?? Number.MAX_SAFE_INTEGER),
    )
    .map((provider) => provider.id);
  const enterpriseIds = [...capabilities.values()]
    .filter((provider) => provider.supportsEnterpriseHost)
    .map((provider) => provider.id)
    .sort();
  for (const entry of config.providers) {
    if (!providerIdSet.has(entry.id)) continue; // registered plugin validation belongs to plugin-runtime.
    const provider = entry.id as ProviderId;
    const capability = capabilities.get(provider);
    const supported = capability?.sourceModes ?? ["auto"];
    const supportsWeb = supported.includes("auto") || supported.includes("web");
    const supportsApi = supported.includes("api");
    if (entry.source !== undefined && !supported.includes(entry.source)) {
      issues.push(
        issue(
          "error",
          provider,
          "source",
          "unsupported_source",
          `Source ${entry.source} is not supported for ${provider}.`,
        ),
      );
    }
    if (cleanConfigString(entry.apiKey) !== undefined && !supportsApi) {
      issues.push(
        issue(
          "warning",
          provider,
          "apiKey",
          "api_key_unused",
          `apiKey is set but ${provider} does not support api source.`,
        ),
      );
    }
    if (entry.source === "api" && !supportsApi) {
      issues.push(
        issue(
          "error",
          provider,
          "source",
          "api_source_unsupported",
          `Source api is not supported for ${provider}.`,
        ),
      );
    }
    if (
      entry.source === "api" &&
      (capability?.requiresApiKeyForApiSource ?? true) &&
      !configuredApiCredential(entry)
    ) {
      issues.push(
        issue(
          "warning",
          provider,
          "apiKey",
          "api_key_missing",
          `Source api is selected but apiKey is missing for ${provider}.`,
        ),
      );
    }
    if (entry.cookieSource !== undefined && !supportsWeb) {
      issues.push(
        issue(
          "warning",
          provider,
          "cookieSource",
          "cookie_source_unused",
          `cookieSource is set but ${provider} does not use web cookies.`,
        ),
      );
    }
    if (cleanConfigString(entry.cookieHeader) !== undefined && !supportsWeb) {
      issues.push(
        issue(
          "warning",
          provider,
          "cookieHeader",
          "cookie_header_unused",
          `cookieHeader is set but ${provider} does not use web cookies.`,
        ),
      );
    }
    if (entry.cookieSource === "manual" && cleanConfigString(entry.cookieHeader) === undefined) {
      issues.push(
        issue(
          "warning",
          provider,
          "cookieHeader",
          "cookie_header_missing",
          `cookieSource manual is set but cookieHeader is missing for ${provider}.`,
        ),
      );
    }
    if (cleanConfigString(entry.secretKey) !== undefined && capability?.usesSecretKey !== true) {
      issues.push(
        issue(
          "warning",
          provider,
          "secretKey",
          "secret_key_unused",
          "secretKey is set but only bedrock and doubao use secretKey.",
        ),
      );
    }
    if (cleanConfigString(entry.region) !== undefined && capability?.usesRegion !== true) {
      issues.push(
        issue(
          "warning",
          provider,
          "region",
          "region_unused",
          `region is set but ${provider} does not use regions.`,
        ),
      );
    }
    if (
      cleanConfigString(entry.workspaceID) !== undefined &&
      capability?.supportsWorkspaceID !== true
    ) {
      issues.push(
        issue(
          "warning",
          provider,
          "workspaceID",
          "workspace_unused",
          `workspaceID is set but only ${formatProviderList(workspaceIds)} support workspaceID.`,
        ),
      );
    }
    if (
      cleanConfigString(entry.enterpriseHost) !== undefined &&
      capability?.supportsEnterpriseHost !== true
    ) {
      issues.push(
        issue(
          "warning",
          provider,
          "enterpriseHost",
          "enterprise_host_unused",
          `enterpriseHost is set but only ${formatProviderList(enterpriseIds)} support enterpriseHost.`,
        ),
      );
    }
    if (
      (entry.tokenAccounts?.accounts.length ?? 0) > 0 &&
      capability?.supportsTokenAccounts !== true
    ) {
      issues.push(
        issue(
          "warning",
          provider,
          "tokenAccounts",
          "token_accounts_unused",
          `tokenAccounts are set but ${provider} does not support token accounts.`,
        ),
      );
    }
    issues.push(...(capability?.validate?.(entry) ?? []));
  }
  issues.push(...validateHooks(config.hooks));
  return issues;
};

export interface LegacyConfigValues {
  readonly providerOrder?: readonly string[];
  readonly providerToggles?: Readonly<Record<string, boolean>>;
  /** Swift's legacy toggle keys are descriptor CLI names, not necessarily provider IDs. */
  readonly providerCLINameById?: Readonly<Record<string, string>>;
  readonly cookieSources?: Readonly<Record<string, ProviderCookieSource>>;
  readonly openAIWebAccessEnabled?: boolean;
  readonly minimaxAPIRegion?: string;
  readonly opencodeWorkspaceID?: string;
  readonly kimiManualCookieHeader?: string;
}

const updateProvider = (
  config: PersistedCodexBarConfig,
  id: ProviderId,
  mutate: (entry: PersistedProviderConfig) => PersistedProviderConfig,
): PersistedCodexBarConfig => ({
  ...config,
  providers: config.providers.map((entry) => (entry.id === id ? mutate(entry) : entry)),
});

/** Pure (non-secret) part of `CodexBarConfigMigrator`; credential import stays opt-in at the platform edge. */
export const migrateLegacyConfigValues = (
  config: PersistedCodexBarConfig,
  values: LegacyConfigValues,
): PersistedCodexBarConfig => {
  let migrated = config;
  if (values.providerOrder !== undefined && values.providerOrder.length > 0) {
    const byId = new Map(config.providers.map((entry) => [entry.id, entry]));
    const seen = new Set<string>();
    const ordered: PersistedProviderConfig[] = [];
    for (const id of values.providerOrder) {
      const entry = byId.get(id);
      if (entry !== undefined && !seen.has(id)) {
        seen.add(id);
        ordered.push(entry);
      }
    }
    for (const id of PROVIDER_IDS) {
      const entry = byId.get(id) ?? defaultProvider(id, "china-mainland");
      if (!seen.has(id)) ordered.push(entry);
    }
    migrated = { ...migrated, providers: ordered };
  }
  if (values.providerToggles !== undefined) {
    migrated = {
      ...migrated,
      providers: migrated.providers.map((entry) => {
        const cliName = values.providerCLINameById?.[entry.id] ?? entry.id;
        const toggle = values.providerToggles?.[cliName];
        return toggle === undefined ? entry : { ...entry, enabled: toggle };
      }),
    };
  }
  const sources = values.cookieSources ?? {};
  for (const id of [
    "codex",
    "claude",
    "cursor",
    "opencode",
    "factory",
    "minimax",
    "kimi",
    "augment",
    "amp",
  ] as const) {
    const source = sources[id];
    if (source !== undefined) {
      migrated = updateProvider(migrated, id, (entry) =>
        entry.cookieSource === undefined ? { ...entry, cookieSource: source } : entry,
      );
    }
  }
  if (values.openAIWebAccessEnabled === false) {
    migrated = updateProvider(migrated, "codex", (entry) =>
      entry.cookieSource === undefined ? { ...entry, cookieSource: "off" } : entry,
    );
  }
  if (cleanConfigString(values.minimaxAPIRegion) !== undefined) {
    const region = cleanConfigString(values.minimaxAPIRegion);
    migrated = updateProvider(migrated, "minimax", (entry) =>
      entry.region === undefined && region !== undefined ? { ...entry, region } : entry,
    );
  }
  if (cleanConfigString(values.opencodeWorkspaceID) !== undefined) {
    const workspaceID = cleanConfigString(values.opencodeWorkspaceID);
    migrated = updateProvider(migrated, "opencode", (entry) =>
      entry.workspaceID === undefined && workspaceID !== undefined
        ? { ...entry, workspaceID }
        : entry,
    );
  }
  if (cleanConfigString(values.kimiManualCookieHeader) !== undefined) {
    const cookieHeader = cleanConfigString(values.kimiManualCookieHeader);
    migrated = updateProvider(migrated, "kimi", (entry) =>
      cleanConfigString(entry.cookieHeader) === undefined && cookieHeader !== undefined
        ? { ...entry, cookieHeader }
        : entry,
    );
  }
  return normalizeCodexBarConfig(migrated, DEFAULT_PROVIDER_CONFIG_NORMALIZERS);
};
