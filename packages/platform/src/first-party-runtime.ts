import { Effect } from "effect";
import {
  ClassifiedFetchFailure,
  Clock,
  makeProviderFetchPipeline,
  type ClockService,
  type CredentialStoreService,
  type HttpRequest,
  type HttpResponse,
  type HttpTransportService,
  MissingBrowserCredentialError,
  type ProviderFetchContext,
  type ProviderFetchStrategy,
  type ProviderRuntimeService,
  normalizeEndpoint,
} from "@codexbar/core";
import type { ProviderId, UsageSnapshot } from "@codexbar/contracts";
import { mapProviderSnapshot } from "@codexbar/providers";
import type {
  FirstPartyProvider,
  ProviderAntigravityLocalSnapshot,
  ProviderBinaryResponse,
  ProviderClaudeCliUsageResult,
  ProviderContext,
  ProviderDescriptor,
  ProviderGrokCliBillingResponse,
  ProviderGrokCredentials,
  ProviderGrokLocalSessionSummary,
  ProviderKiroUsageLimitsResponse,
  ProviderJSONResponse,
  ProviderLocalCapabilities,
  ProviderLocalCommand,
  ProviderLocalData,
  ProviderLocalDataResult,
  ProviderLocalProcessResult,
  ProviderResponse,
  ProviderSelectedAccount,
  ProviderStrategy,
} from "@codexbar/providers";
import { usesAccountScopedBrowserSession } from "./account-scoped-browser-session.ts";

const maximumResponseBytes = 1024 * 1024;
const defaultTimeoutMs = 15_000;

const localCommands: Readonly<Partial<Record<ProviderId, readonly ProviderLocalCommand[]>>> = {
  amp: ["amp"],
  kiro: ["kiro-cli"],
};

const localData: Readonly<Partial<Record<ProviderId, readonly ProviderLocalData[]>>> = {
  jetbrains: ["jetbrains-ai-quota"],
};

/** Safe settings are injected by a host; renderer input never reaches this interface directly. */
export interface FirstPartySettings {
  readonly read: (
    providerId: ProviderId,
    setting: string,
  ) => Effect.Effect<string | undefined, unknown>;
}

/** Browser sessions stay host-owned: providers receive only their declared cookie header. */
export interface FirstPartyBrowserSessions {
  readonly cookieHeader: (
    providerId: ProviderId,
    domain: string,
    selectedAccountId?: string,
  ) => Effect.Effect<string, unknown>;
}

/**
 * Saved-account material resolved by a trusted host. `null` explicitly
 * suppresses ambient environment/keyring values for a selected account.
 */
export interface FirstPartySelectedAccount extends ProviderSelectedAccount {
  readonly plainSettings?: Readonly<Record<string, string | null>>;
  readonly secureSettings?: Readonly<Record<string, string | null>>;
  /** Host-only fence: token/API strategies remain usable while the web session is purged. */
  readonly browserSessionCleanupPending?: boolean;
  readonly claudeHistoryBinding?: {
    readonly selectionKey: string;
    readonly oauthHistoryOwnerIdentifier?: string;
    readonly tokenAccountKey?: string;
  };
}

export interface FirstPartySelectedAccounts {
  readonly resolve: (
    providerId: ProviderId,
    context: ProviderFetchContext,
  ) => Effect.Effect<FirstPartySelectedAccount | undefined, unknown>;
}

/**
 * Host-owned local capabilities for first-party providers. These are named
 * operations rather than general process or filesystem access so providers
 * cannot escape their declared local integration.
 */
export interface FirstPartyLocalCapabilities {
  readonly run: (
    providerId: ProviderId,
    command: ProviderLocalCommand,
    request: { readonly args: readonly string[]; readonly timeoutMs?: number },
  ) => Effect.Effect<ProviderLocalProcessResult, unknown>;
  readonly readData: (
    providerId: ProviderId,
    source: ProviderLocalData,
    request?: { readonly basePath?: string },
  ) => Effect.Effect<ProviderLocalDataResult | undefined, unknown>;
  /** Kiro-only, token-owning platform operation. It never exposes CLI credentials to a provider. */
  readonly fetchKiroUsageLimits?: (
    providerId: ProviderId,
  ) => Effect.Effect<ProviderKiroUsageLimitsResponse, unknown>;
  /** Antigravity-only bounded local responses; endpoint credentials remain in platform. */
  readonly fetchAntigravityLocalSnapshot?: (
    providerId: ProviderId,
  ) => Effect.Effect<ProviderAntigravityLocalSnapshot, unknown>;
  /** Grok-only aggregate local activity. It is not a usage/quota capability. */
  readonly fetchGrokLocalSessionSummary?: (
    providerId: ProviderId,
  ) => Effect.Effect<ProviderGrokLocalSessionSummary, unknown>;
  /** Grok-only private OIDC record. The adapter owns auth.json path selection. */
  readonly fetchGrokCredentials?: (
    providerId: ProviderId,
  ) => Effect.Effect<ProviderGrokCredentials | undefined, unknown>;
  /** Grok-only fixed JSON-RPC billing probe. It never accepts provider input. */
  readonly fetchGrokCliBilling?: (
    providerId: ProviderId,
  ) => Effect.Effect<ProviderGrokCliBillingResponse, unknown>;
  /** Claude-only bounded PTY usage text; no credential material crosses the boundary. */
  readonly fetchClaudeCliUsage?: (
    providerId: ProviderId,
  ) => Effect.Effect<ProviderClaudeCliUsageResult, unknown>;
}

export interface FirstPartyProviderRuntimeOptions {
  /** Swift runtime policy: app-auto may fall back from Admin API; CLI never does. */
  readonly runtime?: "app" | "cli";
  readonly providers: readonly FirstPartyProvider[];
  readonly settings: FirstPartySettings;
  readonly browserSessions: FirstPartyBrowserSessions;
  /** Optional account resolver; omitted hosts retain ambient single-account behavior. */
  readonly selectedAccounts?: FirstPartySelectedAccounts;
  /** Omitted hosts fail closed when a provider asks for local integration. */
  readonly local?: FirstPartyLocalCapabilities;
  readonly http: HttpTransportService;
  readonly credentials: CredentialStoreService;
  readonly clock: ClockService;
  /** IANA zone supplied by the host; defaults to the current runtime zone. */
  readonly timeZone?: string;
  /** Stable host namespace. Provider source code never gets access to the key name. */
  readonly credentialKey?: (providerId: ProviderId, setting: string) => string;
}

const sourceFor = (strategy: ProviderStrategy): ProviderFetchStrategy["source"] =>
  strategy.kind === "web"
    ? "web"
    : strategy.kind === "cli"
      ? "cli"
      : strategy.kind === "local"
        ? "local-probe"
        : strategy.kind === "oauth"
          ? "oauth"
          : "api-token";

const acceptsSource = (
  strategy: ProviderStrategy,
  mode: ProviderFetchContext["sourceMode"],
): boolean =>
  (mode === "auto" && strategy.explicitOnly !== true) ||
  (mode === "web" && strategy.kind === "web") ||
  (mode === "cli" && (strategy.kind === "cli" || strategy.kind === "local")) ||
  (mode === "oauth" && strategy.kind === "oauth") ||
  (mode === "api" && strategy.kind === "api");

const declaredStrategies = (provider: FirstPartyProvider): readonly ProviderStrategy[] =>
  provider.strategies ?? provider.descriptor.strategies ?? [provider];

const credentialKeyFor = (providerId: ProviderId, setting: string): string =>
  `provider/${providerId}/secret/${setting}`;

const runtimeTimeZone = (configured: string | undefined): string => {
  const candidate = configured?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(0);
    return candidate;
  } catch {
    return "UTC";
  }
};

const ownSetting = (
  values: Readonly<Record<string, string | null>> | undefined,
  key: string,
): { readonly present: boolean; readonly value: string | undefined } =>
  values !== undefined && Object.prototype.hasOwnProperty.call(values, key)
    ? { present: true, value: values[key] ?? undefined }
    : { present: false, value: undefined };

const validateSelectedAccount = (
  descriptor: ProviderDescriptor,
  selected: FirstPartySelectedAccount | undefined,
): FirstPartySelectedAccount | undefined => {
  if (selected === undefined) return undefined;
  if (
    selected.id.trim() === "" ||
    selected.id.length > 256 ||
    selected.id.includes("\u0000") ||
    (selected.accountEmail !== undefined &&
      (selected.accountEmail.length > 1_024 || selected.accountEmail.includes("\u0000"))) ||
    (selected.externalIdentifier !== undefined &&
      (selected.externalIdentifier.length > 256 || selected.externalIdentifier.includes("\u0000")))
  ) {
    throw failure("api-failure", "Selected provider account is invalid.");
  }
  const declared = new Map(descriptor.settings.map((setting) => [setting.key, setting.type]));
  if (descriptor.auth !== undefined && !declared.has(descriptor.auth.secret))
    declared.set(descriptor.auth.secret, "secure");
  for (const [type, values] of [
    ["plain", selected.plainSettings],
    ["secure", selected.secureSettings],
  ] as const) {
    for (const [key, value] of Object.entries(values ?? {})) {
      if (
        declared.get(key) !== type ||
        (value !== null &&
          (typeof value !== "string" ||
            value.length > maximumResponseBytes ||
            value.includes("\u0000")))
      ) {
        throw failure("api-failure", "Selected provider account settings are invalid.");
      }
    }
  }
  return selected;
};

const dateParts = (timeZone: string, value: Date): Record<string, number> => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const result: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== "literal") result[part.type] = Number(part.value);
  }
  return result;
};

const zonedOffset = (timeZone: string, value: Date): number => {
  const parts = dateParts(timeZone, value);
  return (
    Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!) -
    value.getTime()
  );
};

/** Finds the next local daily boundary, correcting the initial UTC guess for the zone offset and DST. */
export const nextDailyReset = (nowMillis: number, timeZone: string, hour: number): string => {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23)
    throw new RangeError("reset hour must be 0...23");
  const now = new Date(nowMillis);
  if (!Number.isFinite(now.getTime())) throw new RangeError("now must be valid");
  const localNow = dateParts(timeZone, now);
  let localDate = new Date(Date.UTC(localNow.year!, localNow.month! - 1, localNow.day!, hour));
  let candidate = localDate.getTime() - zonedOffset(timeZone, localDate);
  // A second pass converges after a DST boundary. If the hour is skipped,
  // Intl returns the first valid local time after it, matching nextTime intent.
  candidate = localDate.getTime() - zonedOffset(timeZone, new Date(candidate));
  if (candidate <= nowMillis) {
    localDate = new Date(Date.UTC(localNow.year!, localNow.month! - 1, localNow.day! + 1, hour));
    candidate = localDate.getTime() - zonedOffset(timeZone, localDate);
    candidate = localDate.getTime() - zonedOffset(timeZone, new Date(candidate));
  }
  return new Date(candidate).toISOString();
};

type EndpointRule =
  | { readonly kind: "origin"; readonly origin: string }
  | { readonly kind: "domain-suffix"; readonly suffix: string };

const cleanConfiguredEndpoint = (raw: string): string => {
  let value = raw.trim();
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1).trim();
  }
  return value;
};

const endpointOrigins = (
  descriptor: ProviderDescriptor,
  setting: (key: string) => string | undefined,
): readonly EndpointRule[] => {
  const rules: EndpointRule[] = [];
  for (const endpoint of descriptor.endpoints) {
    if (typeof endpoint === "string") {
      const normalized = normalizeEndpoint(endpoint);
      if (normalized !== undefined) rules.push({ kind: "origin", origin: normalized.origin });
      continue;
    }
    if ("domainSuffix" in endpoint) {
      const suffix = endpoint.domainSuffix.trim().toLowerCase();
      if (
        suffix !== "" &&
        !suffix.includes("*") &&
        !suffix.includes("/") &&
        !suffix.includes(":") &&
        !suffix.startsWith(".") &&
        !suffix.endsWith(".")
      ) {
        rules.push({ kind: "domain-suffix", suffix });
      }
      continue;
    }
    const configuredRaw = setting(endpoint.setting) ?? endpoint.default;
    const configured =
      configuredRaw === undefined ? undefined : cleanConfiguredEndpoint(configuredRaw);
    if (configured === undefined) continue;
    const transport =
      endpoint.policy === "https"
        ? "https-only"
        : endpoint.policy === "https-or-loopback-http"
          ? "loopback-http"
          : "private-network-http";
    const normalized = normalizeEndpoint(configured, { transport });
    if (normalized !== undefined) {
      rules.push({ kind: "origin", origin: normalized.origin });
      for (const prefix of endpoint.subdomainPrefixes ?? []) {
        if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(prefix)) continue;
        const derived = new URL(normalized.origin);
        derived.hostname = `${prefix}.${normalized.hostname}`;
        rules.push({ kind: "origin", origin: derived.origin });
      }
    }
  }
  return rules;
};

const endpointAllowed = (url: URL, rules: readonly EndpointRule[]): boolean => {
  if (rules.some((rule) => rule.kind === "origin" && rule.origin === url.origin)) return true;
  const hostname = url.hostname.toLowerCase();
  return rules.some(
    (rule) =>
      rule.kind === "domain-suffix" &&
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      (url.port === "" || url.port === "443") &&
      (hostname === rule.suffix || hostname.endsWith(`.${rule.suffix}`)),
  );
};

const failure = (kind: ClassifiedFetchFailure["kind"], message: string) =>
  new ClassifiedFetchFailure(kind, message);

const missingBrowserCredentialMessage = "No exported browser credential is available";

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === "AbortError";

const redact = (message: string, values: ReadonlySet<string>): string => {
  let redacted = message;
  for (const value of values) {
    if (value !== "") redacted = redacted.replaceAll(value, "[REDACTED]");
  }
  return redacted;
};

// Whole cookie headers are always redacted. Component values need a floor so common
// preference cookies such as `en`, `0`, or `1` cannot corrupt every diagnostic string.
const minimumComponentRedactionLength = 8;
const redactionTextEncoder = new TextEncoder();

const addCookieComponentRedactions = (redactionValues: Set<string>, cookie: string): void => {
  for (const pair of cookie.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    const value = pair.slice(separator + 1).trim();
    if (redactionTextEncoder.encode(value).byteLength >= minimumComponentRedactionLength) {
      redactionValues.add(value);
    }
  }
};

const addSecretRedactions = (
  redactionValues: Set<string>,
  setting: string,
  secret: string | undefined,
): void => {
  if (secret === undefined || secret === "") return;
  redactionValues.add(secret);
  const bearer = /(?:authorization\s*:\s*)?bearer\s+([A-Za-z0-9._~+/=-]+)/iu.exec(secret)?.[1];
  if (bearer !== undefined) redactionValues.add(bearer);
  if (!setting.toUpperCase().includes("COOKIE")) return;
  for (const line of secret.split(/[\r\n]+/u)) addCookieComponentRedactions(redactionValues, line);
};

const text = (body: Uint8Array): string => {
  if (body.byteLength > maximumResponseBytes)
    throw failure("api-failure", "Provider response exceeded 1 MiB");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw failure("parse-failure", "Provider response is not valid UTF-8");
  }
};

const headersFrom = (value: unknown): Record<string, string> => {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw failure("api-failure", "Provider request headers must be a string record");
  }
  const headers: Record<string, string> = {};
  for (const [name, header] of Object.entries(value)) {
    if (typeof header !== "string" || /[\r\n]/u.test(name) || /[\r\n]/u.test(header)) {
      throw failure("api-failure", "Provider request headers are invalid");
    }
    headers[name] = header;
  }
  return headers;
};

const timeoutFrom = (options: Record<string, unknown>): number => {
  const seconds = options.timeoutSeconds;
  if (seconds === undefined) return defaultTimeoutMs;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
    throw failure("api-failure", "Provider request timeout is invalid");
  }
  return Math.max(1_000, Math.min(30_000, seconds * 1_000));
};

const requestBody = (
  method: "GET" | "POST",
  options: Record<string, unknown>,
): Uint8Array | undefined => {
  if (method !== "POST" || options.body === undefined) return undefined;
  try {
    const encoded = new TextEncoder().encode(JSON.stringify(options.body));
    if (encoded.byteLength > maximumResponseBytes) throw new Error("too large");
    return encoded;
  } catch {
    throw failure("api-failure", "Provider request body is invalid or exceeds 1 MiB");
  }
};

const authorizationHeader = (
  descriptor: ProviderDescriptor,
  secret: string,
): readonly [string, string] | undefined => {
  const auth = descriptor.auth;
  if (auth === undefined) return undefined;
  if (auth.type === "provider-managed") return undefined;
  const name =
    auth.type === "x-api-key"
      ? "X-API-Key"
      : auth.type === "header"
        ? (auth.header ?? "Authorization")
        : "Authorization";
  const value =
    auth.type === "bearer"
      ? `Bearer ${secret}`
      : auth.type === "authorization-scheme"
        ? `${auth.scheme ?? ""} ${secret}`.trim()
        : secret;
  return [name, value];
};

const suppressManagedAuth = (
  descriptor: ProviderDescriptor,
  url: URL,
  requestOptions: Readonly<Record<string, unknown>>,
): boolean => {
  const requested = requestOptions.__codexbarSuppressManagedAuth;
  if (requested === undefined) return false;
  const allowed =
    requested === true &&
    ((descriptor.id === "copilot" &&
      url.origin === "https://github.com" &&
      url.pathname === "/settings/billing/budgets") ||
      (descriptor.id === "ollama" &&
        url.origin === "https://ollama.com" &&
        ["/settings", "/api/web_search", "/api/tags"].includes(url.pathname)));
  if (!allowed) {
    throw failure("permission-denied", "Managed auth suppression is not allowed for this request.");
  }
  return true;
};

const openRouterManagementAuthSecret = (
  descriptor: ProviderDescriptor,
  method: "GET" | "POST",
  url: URL,
  requestOptions: Readonly<Record<string, unknown>>,
): string | undefined => {
  const requested = requestOptions.openRouterManagementAuth;
  if (requested === undefined) return undefined;
  const managementSecret = "OPENROUTER_MANAGEMENT_API_KEY";
  if (
    requested !== true ||
    descriptor.id !== "openrouter" ||
    descriptor.settings.find((setting) => setting.key === managementSecret)?.type !== "secure" ||
    method !== "GET" ||
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "openrouter.ai" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/api/v1/activity" ||
    url.hash !== ""
  ) {
    throw failure(
      "permission-denied",
      "OpenRouter management auth is unavailable for this request.",
    );
  }
  return managementSecret;
};

const withoutHeader = (headers: Record<string, string>, name: string): void => {
  for (const key of Object.keys(headers))
    if (key.toLowerCase() === name.toLowerCase()) delete headers[key];
};

const asProviderResponse = (response: HttpResponse): ProviderResponse => ({
  status: response.status,
  bodyText: text(response.body),
  headers: providerResponseHeaders(response.headers),
});

const maximumResponseHeaderCount = 256;
const maximumResponseHeaderNameLength = 256;
const maximumResponseHeaderValueLength = 8_192;

const providerResponseHeaders = (
  values: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> => {
  const headers: Record<string, string> = {};
  let count = 0;
  for (const [name, value] of Object.entries(values)) {
    const normalizedName = name.toLowerCase();
    if (normalizedName === "set-cookie" || normalizedName === "set-cookie2") continue;
    if (
      count >= maximumResponseHeaderCount ||
      name.length === 0 ||
      name.length > maximumResponseHeaderNameLength ||
      value.length > maximumResponseHeaderValueLength ||
      /[\r\n]/u.test(name) ||
      name.includes("\u0000") ||
      value.includes("\u0000")
    ) {
      continue;
    }
    headers[name] = value;
    count += 1;
  }
  return headers;
};

const asProviderBinaryResponse = (response: HttpResponse): ProviderBinaryResponse => {
  if (!(response.body instanceof Uint8Array) || response.body.byteLength > maximumResponseBytes) {
    throw failure("api-failure", "Provider binary response is invalid or exceeds 1 MiB");
  }
  return {
    status: response.status,
    headers: response.headers,
    // The transport retains no mutable buffer shared with a provider.
    body: response.body.slice(),
  };
};

const localFor = (
  providerId: ProviderId,
  local: FirstPartyLocalCapabilities | undefined,
  signal: AbortSignal,
): ProviderLocalCapabilities => ({
  run: async (command, request) => {
    if (local === undefined)
      throw failure(
        "provider-unavailable",
        "Local provider capabilities are not configured by this host.",
      );
    if (localCommands[providerId]?.includes(command) !== true)
      throw failure(
        "permission-denied",
        `Local command '${command}' is not declared for ${providerId}.`,
      );
    if (
      request.args.length > 16 ||
      request.args.some(
        (argument) =>
          typeof argument !== "string" || argument.length > 1_024 || argument.includes("\u0000"),
      )
    ) {
      throw failure("api-failure", "Local command arguments are invalid.");
    }
    const timeoutMs = request.timeoutMs ?? defaultTimeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000)
      throw failure("api-failure", "Local command timeout is invalid.");
    const result = await Effect.runPromise(
      local.run(providerId, command, { ...request, timeoutMs }),
      {
        signal,
      },
    );
    if (
      result.stdout.length > maximumResponseBytes ||
      result.stderr.length > maximumResponseBytes ||
      result.stdout.includes("\u0000") ||
      result.stderr.includes("\u0000")
    ) {
      throw failure("api-failure", "Local command response is invalid or exceeds 1 MiB.");
    }
    return result;
  },
  readData: async (source, request) => {
    if (local === undefined)
      throw failure(
        "provider-unavailable",
        "Local provider capabilities are not configured by this host.",
      );
    if (localData[providerId]?.includes(source) !== true)
      throw failure(
        "permission-denied",
        `Local data '${source}' is not declared for ${providerId}.`,
      );
    const basePath = request?.basePath;
    if (
      basePath !== undefined &&
      (basePath.length === 0 || basePath.length > 4_096 || basePath.includes("\u0000"))
    ) {
      throw failure("api-failure", "Local data path is invalid.");
    }
    const result = await Effect.runPromise(local.readData(providerId, source, request), { signal });
    if (
      result !== undefined &&
      (result.text.length > maximumResponseBytes || result.text.includes("\u0000"))
    )
      throw failure("api-failure", "Local data response is invalid or exceeds 1 MiB.");
    return result;
  },
  fetchAntigravityLocalSnapshot: async () => {
    if (providerId !== "antigravity" || local?.fetchAntigravityLocalSnapshot === undefined)
      throw failure(
        "provider-unavailable",
        "Antigravity local usage is not configured by this host.",
      );
    const result = await Effect.runPromise(local.fetchAntigravityLocalSnapshot(providerId), {
      signal,
    });
    for (const value of [result.quotaSummaryJson, result.userStatusJson]) {
      if (value !== undefined && (value.length > maximumResponseBytes || value.includes("\u0000")))
        throw failure("api-failure", "Antigravity local response is invalid or exceeds 1 MiB.");
    }
    return result;
  },
  fetchKiroUsageLimits: async () => {
    if (local === undefined || local.fetchKiroUsageLimits === undefined)
      throw failure(
        "provider-unavailable",
        "Kiro usage-limit enrichment is not configured by this host.",
      );
    if (providerId !== "kiro")
      throw failure(
        "permission-denied",
        "Kiro usage-limit enrichment is not declared for this provider.",
      );
    const result = await Effect.runPromise(local.fetchKiroUsageLimits(providerId), { signal });
    if (
      !Number.isInteger(result.status) ||
      result.status < 100 ||
      result.status > 599 ||
      result.bodyText.length > maximumResponseBytes ||
      result.bodyText.includes("\u0000")
    )
      throw failure("api-failure", "Kiro usage-limit response is invalid or exceeds 1 MiB.");
    return result;
  },
  fetchGrokLocalSessionSummary: async () => {
    if (local === undefined || local.fetchGrokLocalSessionSummary === undefined)
      throw failure(
        "provider-unavailable",
        "Grok local-session enrichment is not configured by this host.",
      );
    if (providerId !== "grok")
      throw failure(
        "permission-denied",
        "Grok local-session enrichment is not declared for this provider.",
      );
    const result = await Effect.runPromise(local.fetchGrokLocalSessionSummary(providerId), {
      signal,
    });
    if (
      !Number.isSafeInteger(result.sessionCount) ||
      result.sessionCount < 0 ||
      !Number.isSafeInteger(result.totalTokens) ||
      result.totalTokens < 0 ||
      !Array.isArray(result.models) ||
      result.models.length > 64 ||
      result.models.some((model) => typeof model !== "string" || model.length > 256) ||
      (result.primaryModel !== undefined &&
        (typeof result.primaryModel !== "string" || result.primaryModel.length > 256)) ||
      (result.lastSessionAtMs !== undefined &&
        (!Number.isSafeInteger(result.lastSessionAtMs) ||
          result.lastSessionAtMs < 0 ||
          result.lastSessionAtMs > 8_640_000_000_000_000)) ||
      (result.today !== undefined && !/^\d{4}-\d{2}-\d{2}$/u.test(result.today)) ||
      (result.truncated !== undefined && typeof result.truncated !== "boolean") ||
      (result.daily !== undefined &&
        (!Array.isArray(result.daily) ||
          result.daily.length > 366 ||
          result.daily.some(
            (bucket: {
              readonly date: string;
              readonly totalTokens: number;
              readonly sessionCount: number;
              readonly models: readonly string[];
            }) =>
              !/^\d{4}-\d{2}-\d{2}$/u.test(bucket.date) ||
              !Number.isSafeInteger(bucket.totalTokens) ||
              bucket.totalTokens < 0 ||
              !Number.isSafeInteger(bucket.sessionCount) ||
              bucket.sessionCount < 0 ||
              !Array.isArray(bucket.models) ||
              bucket.models.length > 64 ||
              bucket.models.some(
                (model: string) => typeof model !== "string" || model.length > 256,
              ),
          )))
    )
      throw failure("api-failure", "Grok local-session enrichment is invalid.");
    return result;
  },
  fetchGrokCredentials: async () => {
    if (local === undefined || local.fetchGrokCredentials === undefined)
      throw failure(
        "provider-unavailable",
        "Grok OIDC credentials are not configured by this host.",
      );
    if (providerId !== "grok")
      throw failure(
        "permission-denied",
        "Grok OIDC credentials are not declared for this provider.",
      );
    const result = await Effect.runPromise(local.fetchGrokCredentials(providerId), { signal });
    if (
      result !== undefined &&
      (typeof result.accessToken !== "string" ||
        result.accessToken.length === 0 ||
        result.accessToken.length > maximumResponseBytes ||
        typeof result.scope !== "string" ||
        result.scope.length > 4_096 ||
        [
          result.authMode,
          result.email,
          result.firstName,
          result.lastName,
          result.teamId,
          result.principalType,
          result.expiresAt,
        ].some(
          (value) => value !== undefined && (typeof value !== "string" || value.length > 4_096),
        ))
    )
      throw failure("api-failure", "Grok OIDC credential is invalid.");
    return result;
  },
  fetchGrokCliBilling: async () => {
    if (local === undefined || local.fetchGrokCliBilling === undefined)
      throw failure("provider-unavailable", "Grok CLI billing is not configured by this host.");
    if (providerId !== "grok")
      throw failure("permission-denied", "Grok CLI billing is not declared for this provider.");
    const result = await Effect.runPromise(local.fetchGrokCliBilling(providerId), { signal });
    if (
      (result.exitCode !== undefined && !Number.isSafeInteger(result.exitCode)) ||
      (result.signal !== undefined &&
        (typeof result.signal !== "string" || result.signal.length > 128)) ||
      typeof result.stdout !== "string" ||
      typeof result.stderr !== "string" ||
      result.stdout.length > maximumResponseBytes ||
      result.stderr.length > maximumResponseBytes ||
      result.stdout.includes("\u0000") ||
      result.stderr.includes("\u0000")
    )
      throw failure("api-failure", "Grok CLI billing response is invalid or exceeds 1 MiB.");
    return result;
  },
  fetchClaudeCliUsage: async () => {
    if (local === undefined || local.fetchClaudeCliUsage === undefined)
      throw failure("provider-unavailable", "Claude CLI usage is not configured by this host.");
    if (providerId !== "claude")
      throw failure("permission-denied", "Claude CLI usage is not declared for this provider.");
    const result = await Effect.runPromise(local.fetchClaudeCliUsage(providerId), { signal });
    if (
      (result.exitCode !== undefined && !Number.isSafeInteger(result.exitCode)) ||
      (result.signal !== undefined &&
        (typeof result.signal !== "string" || result.signal.length > 128)) ||
      typeof result.stdout !== "string" ||
      typeof result.stderr !== "string" ||
      typeof result.loggedIn !== "boolean" ||
      new TextEncoder().encode(result.stdout).byteLength > maximumResponseBytes ||
      new TextEncoder().encode(result.stderr).byteLength > maximumResponseBytes ||
      result.stdout.includes("\u0000") ||
      result.stderr.includes("\u0000")
    )
      throw failure("api-failure", "Claude CLI usage response is invalid or exceeds 1 MiB.");
    return result;
  },
});

/**
 * Adapts the typed host capabilities to the deliberately small provider JS
 * surface. It is the only first-party path that can resolve credentials or
 * issue network requests; neither surface is returned to callers.
 */
export const makeFirstPartyProviderRuntime = (
  options: FirstPartyProviderRuntimeOptions,
): ProviderRuntimeService => {
  const byId = new Map(options.providers.map((provider) => [provider.descriptor.id, provider]));
  const keyFor = options.credentialKey ?? credentialKeyFor;

  const autoSecretAvailable = (
    descriptor: ProviderDescriptor,
    selectedAccount: FirstPartySelectedAccount | undefined,
    keys: readonly string[],
  ): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      const secureKeys = new Set(
        descriptor.settings
          .filter((setting) => setting.type === "secure")
          .map((setting) => setting.key),
      );
      if (descriptor.auth !== undefined) secureKeys.add(descriptor.auth.secret);
      for (const key of keys) {
        if (!secureKeys.has(key)) continue;
        const selected = ownSetting(selectedAccount?.secureSettings, key);
        if (selected.present) {
          if (selected.value?.trim()) return true;
          continue;
        }
        const injected = yield* options.settings
          .read(descriptor.id, key)
          .pipe(Effect.orElseSucceed(() => undefined));
        const stored = yield* options.credentials
          .read(keyFor(descriptor.id, key))
          .pipe(Effect.orElseSucceed(() => undefined));
        if ((stored ?? injected)?.trim()) return true;
      }
      return false;
    });

  const strategyFor = (
    providerId: ProviderId,
    context: ProviderFetchContext,
    selectedAccount: FirstPartySelectedAccount | undefined,
  ): Effect.Effect<readonly ProviderFetchStrategy[], never> => {
    const provider = byId.get(providerId);
    if (provider === undefined) return Effect.succeed([]);
    return Effect.succeed(
      declaredStrategies(provider)
        .filter((strategy) =>
          selectedStrategyAllowed(providerId, context, selectedAccount, strategy),
        )
        .filter(
          (strategy) =>
            selectedClaudeStrategyMode(selectedAccount) !== undefined ||
            acceptsSource(strategy, context.sourceMode),
        )
        .map(
          (strategy): ProviderFetchStrategy => ({
            id: strategy.id,
            source: sourceFor(strategy),
            isAvailable: () =>
              context.sourceMode !== "auto" || strategy.autoRequiresAnySecret === undefined
                ? Effect.succeed(true)
                : autoSecretAvailable(
                    provider.descriptor,
                    selectedAccount,
                    strategy.autoRequiresAnySecret,
                  ),
            fetch: () =>
              executeProvider(provider, strategy, context, selectedAccount, options, keyFor),
            shouldFallback: (error, fetchContext) =>
              fetchContext.sourceMode === "auto" &&
              (strategy.id !== "claude.admin-api" || options.runtime !== "cli") &&
              error instanceof ClassifiedFetchFailure &&
              (strategy.fallbackOn?.includes(error.kind) === true ||
                // Provider descriptors may narrow fallback within a classified kind (for example,
                // an API strategy that falls back only on HTTP 404, not every API failure).
                strategy.fallbackWhen?.(error) === true),
          }),
        ),
    );
  };
  return {
    fetch: (providerId, context) =>
      resolveSelectedAccount(options, byId.get(providerId)?.descriptor, providerId, context).pipe(
        Effect.flatMap((selectedAccount) =>
          makeProviderFetchPipeline({
            resolveStrategies: (resolvedProviderId, resolvedContext) =>
              strategyFor(resolvedProviderId, resolvedContext, selectedAccount),
          }).fetch(providerId, context),
        ),
        Effect.provideService(Clock, options.clock),
      ),
  };
};

const selectedStrategyAllowed = (
  providerId: ProviderId,
  context: ProviderFetchContext,
  selectedAccount: FirstPartySelectedAccount | undefined,
  strategy: ProviderStrategy,
): boolean => {
  if (providerId === "codex" && strategy.id === "codex.web.dashboard") {
    if (
      context.sourceMode !== "web" ||
      selectedAccount === undefined ||
      selectedAccount.browserSessionCleanupPending === true
    )
      return false;
    const oauth = ownSetting(selectedAccount.secureSettings, "CODEX_ACCESS_TOKEN");
    const pat = ownSetting(selectedAccount.secureSettings, "CODEX_PERSONAL_ACCESS_TOKEN");
    const accountId = ownSetting(selectedAccount.plainSettings, "CODEX_ACCOUNT_ID");
    return (
      oauth.present &&
      pat.present &&
      accountId.present &&
      Boolean(accountId.value?.trim()) &&
      Boolean(selectedAccount.accountEmail?.trim())
    );
  }
  if (selectedAccount === undefined) return true;
  if (providerId === "codex") {
    const oauth = ownSetting(selectedAccount.secureSettings, "CODEX_ACCESS_TOKEN");
    const pat = ownSetting(selectedAccount.secureSettings, "CODEX_PERSONAL_ACCESS_TOKEN");
    const accountId = ownSetting(selectedAccount.plainSettings, "CODEX_ACCOUNT_ID");
    const ownsCredentialNamespace = oauth.present && pat.present && accountId.present;
    if (!ownsCredentialNamespace) return false;
    if (context.sourceMode === "web") return false;
    if (context.sourceMode === "oauth") {
      return Boolean(oauth.value?.trim()) && strategy.id === "codex.oauth";
    }
    if (context.sourceMode === "api") {
      return Boolean(pat.value?.trim()) && strategy.id === "codex";
    }
    if (context.sourceMode === "cli") return false;
    return (Boolean(oauth.value?.trim()) || Boolean(pat.value?.trim())) && strategy.id === "codex";
  }
  if (providerId === "deepinfra") {
    const apiKey = ownSetting(selectedAccount.secureSettings, "DEEPINFRA_API_KEY");
    return apiKey.present && Boolean(apiKey.value?.trim()) && strategy.id === "deepinfra.api";
  }
  if (providerId === "groq") {
    const apiKey = ownSetting(selectedAccount.secureSettings, "GROQ_API_KEY");
    return apiKey.present && Boolean(apiKey.value?.trim()) && strategy.id === "groq.api";
  }
  if (providerId === "venice") {
    const apiKey = ownSetting(selectedAccount.secureSettings, "VENICE_API_KEY");
    return apiKey.present && Boolean(apiKey.value?.trim()) && strategy.id === "venice.api";
  }
  if (providerId === "elevenlabs") {
    const apiKey = ownSetting(selectedAccount.secureSettings, "ELEVENLABS_API_KEY");
    return apiKey.present && Boolean(apiKey.value?.trim()) && strategy.id === "elevenlabs.api";
  }
  if (providerId === "ibmbob") {
    const apiKey = ownSetting(selectedAccount.secureSettings, "BOBSHELL_API_KEY");
    return apiKey.present && Boolean(apiKey.value?.trim()) && strategy.id === "ibmbob.api";
  }
  if (providerId === "neuralwatt") {
    const apiKey = ownSetting(selectedAccount.secureSettings, "NEURALWATT_API_KEY");
    return apiKey.present && Boolean(apiKey.value?.trim()) && strategy.id === "neuralwatt.api";
  }
  if (providerId === "sub2api") {
    const apiKey = ownSetting(selectedAccount.secureSettings, "SUB2API_API_KEY");
    return apiKey.present && Boolean(apiKey.value?.trim()) && strategy.id === "sub2api.api";
  }
  if (providerId === "llmproxy") {
    const apiKey = ownSetting(selectedAccount.secureSettings, "LLM_PROXY_API_KEY");
    return apiKey.present && Boolean(apiKey.value?.trim()) && strategy.id === "llmproxy.api";
  }
  if (providerId === "litellm") {
    const apiKey = ownSetting(selectedAccount.secureSettings, "LITELLM_API_KEY");
    return apiKey.present && Boolean(apiKey.value?.trim()) && strategy.id === "litellm.api";
  }
  if (providerId === "deepseek") {
    const apiKey = ownSetting(selectedAccount.secureSettings, "DEEPSEEK_API_KEY");
    return apiKey.present && Boolean(apiKey.value?.trim()) && strategy.id === "deepseek.api";
  }
  if (providerId === "openai") {
    const adminKey = ownSetting(selectedAccount.secureSettings, "OPENAI_ADMIN_KEY");
    return adminKey.present && Boolean(adminKey.value?.trim()) && strategy.id === "openai.api";
  }
  if (providerId === "openrouter") {
    const apiKey = ownSetting(selectedAccount.secureSettings, "OPENROUTER_API_KEY");
    return apiKey.present && Boolean(apiKey.value?.trim()) && strategy.id === "openrouter.api";
  }
  if (providerId === "abacus") {
    const cookie = ownSetting(selectedAccount.secureSettings, "ABACUS_COOKIE_HEADER");
    return cookie.present && Boolean(cookie.value?.trim()) && strategy.id === "abacus.web";
  }
  if (providerId === "augment") {
    const cookie = ownSetting(selectedAccount.secureSettings, "AUGMENT_COOKIE_HEADER");
    return cookie.present && Boolean(cookie.value?.trim()) && strategy.id === "augment.web";
  }
  if (providerId === "cursor") {
    const cookie = ownSetting(selectedAccount.secureSettings, "CURSOR_COOKIE");
    return cookie.present && Boolean(cookie.value?.trim()) && strategy.id === "cursor.web";
  }
  if (providerId === "mistral") {
    const cookie = ownSetting(selectedAccount.secureSettings, "MISTRAL_COOKIE_HEADER");
    return cookie.present && Boolean(cookie.value?.trim()) && strategy.id === "mistral.web";
  }
  if (providerId === "opencode") {
    const cookie = ownSetting(selectedAccount.secureSettings, "OPENCODE_COOKIE");
    return cookie.present && Boolean(cookie.value?.trim()) && strategy.id === "opencode.web";
  }
  if (providerId === "opencodego") {
    const cookie = ownSetting(selectedAccount.secureSettings, "OPENCODEGO_COOKIE");
    const apiKey = ownSetting(selectedAccount.secureSettings, "OPENCODE_API_KEY");
    return (
      cookie.present &&
      Boolean(cookie.value?.trim()) &&
      apiKey.present &&
      apiKey.value === undefined &&
      strategy.id === "opencodego.web"
    );
  }
  if (providerId === "manus") {
    const cookie = ownSetting(selectedAccount.secureSettings, "MANUS_COOKIE_HEADER");
    return cookie.present && Boolean(cookie.value?.trim()) && strategy.id === "manus.web";
  }
  if (providerId === "stepfun") {
    const token = ownSetting(selectedAccount.secureSettings, "STEPFUN_TOKEN");
    return token.present && Boolean(token.value?.trim()) && strategy.id === "stepfun.web";
  }
  if (providerId === "ollama") {
    const cookie = ownSetting(selectedAccount.secureSettings, "OLLAMA_COOKIE");
    const apiKey = ownSetting(selectedAccount.secureSettings, "OLLAMA_API_KEY");
    const legacyKey = ownSetting(selectedAccount.secureSettings, "OLLAMA_KEY");
    return (
      cookie.present &&
      Boolean(cookie.value?.trim()) &&
      apiKey.present &&
      apiKey.value === undefined &&
      legacyKey.present &&
      legacyKey.value === undefined &&
      strategy.id === "ollama.web"
    );
  }
  if (providerId === "factory") {
    const credential = ownSetting(selectedAccount.secureSettings, "FACTORY_COOKIE_HEADER");
    const apiKey = ownSetting(selectedAccount.secureSettings, "FACTORY_API_KEY");
    return (
      credential.present &&
      Boolean(credential.value?.trim()) &&
      apiKey.present &&
      apiKey.value === undefined &&
      (context.sourceMode === "auto" || context.sourceMode === "web") &&
      strategy.id === "factory.web"
    );
  }
  if (providerId === "qoder") {
    const cookie = ownSetting(selectedAccount.secureSettings, "QODER_COOKIE_HEADER");
    const site = ownSetting(selectedAccount.plainSettings, "QODER_SITE");
    return (
      cookie.present &&
      Boolean(cookie.value?.trim()) &&
      site.present &&
      (site.value === "qoder.com" || site.value === "qoder.com.cn") &&
      (context.sourceMode === "auto" || context.sourceMode === "web") &&
      strategy.id === "qoder.web"
    );
  }
  if (providerId === "minimax") {
    const legacyCookie = ownSetting(selectedAccount.secureSettings, "MINIMAX_COOKIE");
    const cookie = ownSetting(selectedAccount.secureSettings, "MINIMAX_COOKIE_HEADER");
    const authorization = ownSetting(selectedAccount.secureSettings, "MINIMAX_AUTHORIZATION_TOKEN");
    const groupId = ownSetting(selectedAccount.secureSettings, "MINIMAX_GROUP_ID");
    const legacyToken = ownSetting(selectedAccount.secureSettings, "MINIMAX_API_TOKEN");
    const apiKey = ownSetting(selectedAccount.secureSettings, "MINIMAX_API_KEY");
    const codingKey = ownSetting(selectedAccount.secureSettings, "MINIMAX_CODING_API_KEY");
    return (
      legacyCookie.present &&
      legacyCookie.value === undefined &&
      cookie.present &&
      Boolean(cookie.value?.trim()) &&
      authorization.present &&
      groupId.present &&
      legacyToken.present &&
      legacyToken.value === undefined &&
      apiKey.present &&
      apiKey.value === undefined &&
      codingKey.present &&
      codingKey.value === undefined &&
      (context.sourceMode === "auto" || context.sourceMode === "web") &&
      strategy.id === "minimax.web"
    );
  }
  if (providerId === "copilot") {
    const apiToken = ownSetting(selectedAccount.secureSettings, "COPILOT_API_TOKEN");
    return apiToken.present && Boolean(apiToken.value?.trim()) && strategy.id === "copilot.api";
  }
  if (providerId === "zai") {
    const apiKey = ownSetting(selectedAccount.secureSettings, "Z_AI_API_KEY");
    return apiKey.present && Boolean(apiKey.value?.trim()) && strategy.id === "zai.api";
  }
  if (providerId === "grok") {
    const oauth = ownSetting(selectedAccount.secureSettings, "GROK_OAUTH_TOKEN");
    const cookie = ownSetting(selectedAccount.secureSettings, "GROK_COOKIE_HEADER");
    const controlsGrok = oauth.present || cookie.present;
    const selected = selectedGrokStrategyMode(selectedAccount);
    if (controlsGrok && selected === undefined) return false;
    if (context.sourceMode !== "auto") return true;
    if (selected === "oauth") return strategy.kind === "oauth";
    if (selected === "web") return strategy.id === "grok.web";
    return true;
  }
  if (providerId !== "claude") return true;
  const selected = selectedClaudeStrategyMode(selectedAccount);
  if (selected !== undefined) return strategy.id === selected;
  const admin = ownSetting(selectedAccount.secureSettings, "ANTHROPIC_ADMIN_KEY");
  const alternateAdmin = ownSetting(selectedAccount.secureSettings, "ANTHROPIC_ADMIN_API_KEY");
  const oauth = ownSetting(selectedAccount.secureSettings, "CLAUDE_OAUTH_ACCESS_TOKEN");
  const cookie = ownSetting(selectedAccount.secureSettings, "CLAUDE_COOKIE_HEADER");
  if (admin.present || alternateAdmin.present || oauth.present || cookie.present) return false;
  return true;
};

const selectedClaudeStrategyMode = (
  selectedAccount: FirstPartySelectedAccount | undefined,
): string | undefined => {
  if (selectedAccount === undefined) return undefined;
  const admin = ownSetting(selectedAccount.secureSettings, "ANTHROPIC_ADMIN_KEY");
  const alternateAdmin = ownSetting(selectedAccount.secureSettings, "ANTHROPIC_ADMIN_API_KEY");
  const oauth = ownSetting(selectedAccount.secureSettings, "CLAUDE_OAUTH_ACCESS_TOKEN");
  const cookie = ownSetting(selectedAccount.secureSettings, "CLAUDE_COOKIE_HEADER");
  if (
    (admin.present && admin.value?.trim()) ||
    (alternateAdmin.present && alternateAdmin.value?.trim())
  )
    return "claude.admin-api";
  if (oauth.present && oauth.value?.trim()) return "claude.oauth";
  if (cookie.present && cookie.value?.trim()) return "claude.web";
  return undefined;
};

const selectedGrokStrategyMode = (
  selectedAccount: FirstPartySelectedAccount | undefined,
): "oauth" | "web" | undefined => {
  if (selectedAccount === undefined) return undefined;
  const oauth = ownSetting(selectedAccount.secureSettings, "GROK_OAUTH_TOKEN");
  const cookie = ownSetting(selectedAccount.secureSettings, "GROK_COOKIE_HEADER");
  if (oauth.present && oauth.value?.trim()) return "oauth";
  if (cookie.present && cookie.value?.trim()) return "web";
  return undefined;
};

const resolveSelectedAccount = (
  options: FirstPartyProviderRuntimeOptions,
  descriptor: ProviderDescriptor | undefined,
  providerId: ProviderId,
  context: ProviderFetchContext,
): Effect.Effect<FirstPartySelectedAccount | undefined, ClassifiedFetchFailure> => {
  if (options.selectedAccounts === undefined || descriptor === undefined)
    return Effect.succeed(undefined);
  return options.selectedAccounts.resolve(providerId, context).pipe(
    Effect.mapError((error) =>
      error instanceof ClassifiedFetchFailure
        ? error
        : failure("api-failure", "Unable to resolve the selected account."),
    ),
    Effect.flatMap((selected) =>
      Effect.try({
        try: () => validateSelectedAccount(descriptor, selected),
        catch: (error) =>
          error instanceof ClassifiedFetchFailure
            ? error
            : failure("api-failure", "Selected provider account is invalid."),
      }),
    ),
  );
};

const executeProvider = (
  provider: FirstPartyProvider,
  strategy: ProviderStrategy,
  fetchContext: ProviderFetchContext,
  selectedAccount: FirstPartySelectedAccount | undefined,
  options: FirstPartyProviderRuntimeOptions,
  keyFor: (providerId: ProviderId, setting: string) => string,
): Effect.Effect<UsageSnapshot, ClassifiedFetchFailure> => {
  const redactionValues = new Set<string>();
  const abortController = new AbortController();
  let hostCancelled = false;
  return Effect.tryPromise({
    try: async (signal) => {
      const markCancelled = () => {
        hostCancelled = true;
      };
      if (signal.aborted) markCancelled();
      else signal.addEventListener("abort", markCancelled, { once: true });
      const operationSignal = AbortSignal.any([signal, abortController.signal]);
      const executeHttp = async (
        request: HttpRequest,
        requestSignal?: AbortSignal,
      ): Promise<HttpResponse> => {
        const signal =
          requestSignal === undefined
            ? operationSignal
            : AbortSignal.any([operationSignal, requestSignal]);
        try {
          return await Effect.runPromise(options.http.execute(request), {
            signal,
          });
        } catch (error) {
          if (isAbortError(error)) throw error;
          if (hostCancelled || operationSignal.aborted) {
            throw new DOMException("Provider refresh cancelled.", "AbortError");
          }
          if (error instanceof ClassifiedFetchFailure) throw error;
          throw failure(
            "network-failure",
            error instanceof Error ? error.message : "Provider network request failed.",
          );
        }
      };
      const descriptor = provider.descriptor;
      const timeZone = runtimeTimeZone(options.timeZone);
      const settings = new Map<string, string | undefined>();
      const secrets = new Map<string, string | undefined>();
      const secureKeys = new Set(
        descriptor.settings
          .filter((setting) => setting.type === "secure")
          .map((setting) => setting.key),
      );
      if (descriptor.auth !== undefined) secureKeys.add(descriptor.auth.secret);
      for (const setting of descriptor.settings) {
        const selectedOverride = ownSetting(
          secureKeys.has(setting.key)
            ? selectedAccount?.secureSettings
            : selectedAccount?.plainSettings,
          setting.key,
        );
        const injected = selectedOverride.present
          ? undefined
          : await Effect.runPromise(options.settings.read(descriptor.id, setting.key), {
              signal: operationSignal,
            });
        if (secureKeys.has(setting.key)) {
          let stored: string | undefined;
          if (!selectedOverride.present) {
            try {
              stored = await Effect.runPromise(
                options.credentials.read(keyFor(descriptor.id, setting.key)),
                { signal: operationSignal },
              );
            } catch (error) {
              if (injected === undefined) throw error;
            }
          }
          const secret = selectedOverride.present ? selectedOverride.value : (stored ?? injected);
          secrets.set(setting.key, secret);
          addSecretRedactions(redactionValues, setting.key, secret);
        } else {
          settings.set(setting.key, selectedOverride.present ? selectedOverride.value : injected);
        }
      }
      if (descriptor.auth !== undefined && !secrets.has(descriptor.auth.secret)) {
        const selectedOverride = ownSetting(
          selectedAccount?.secureSettings,
          descriptor.auth.secret,
        );
        const injected = selectedOverride.present
          ? undefined
          : await Effect.runPromise(options.settings.read(descriptor.id, descriptor.auth.secret), {
              signal: operationSignal,
            });
        let stored: string | undefined;
        if (!selectedOverride.present) {
          try {
            stored = await Effect.runPromise(
              options.credentials.read(keyFor(descriptor.id, descriptor.auth.secret)),
              { signal: operationSignal },
            );
          } catch (error) {
            if (injected === undefined) throw error;
          }
        }
        const secret = selectedOverride.present ? selectedOverride.value : (stored ?? injected);
        secrets.set(descriptor.auth.secret, secret);
        addSecretRedactions(redactionValues, descriptor.auth.secret, secret);
      }
      const getSetting = (key: string) => settings.get(key);
      const origins = endpointOrigins(descriptor, getSetting);
      const nowMillis = await Effect.runPromise(options.clock.now, { signal: operationSignal });
      const now = () => new Date(nowMillis);
      const request = async (
        method: "GET" | "POST",
        rawUrl: string,
        requestOptions: Record<string, unknown> = {},
        parseJson = false,
      ): Promise<ProviderResponse | ProviderJSONResponse> => {
        const url = new URL(rawUrl);
        if (!endpointAllowed(url, origins))
          throw failure("api-failure", `Provider endpoint is not declared: ${url.origin}`);
        const headers = headersFrom(requestOptions.headers);
        const auth = descriptor.auth;
        const authSuppressed = suppressManagedAuth(descriptor, url, requestOptions);
        const managementAuthSecret = openRouterManagementAuthSecret(
          descriptor,
          method,
          url,
          requestOptions,
        );
        if (authSuppressed && auth?.type !== "provider-managed") {
          withoutHeader(headers, "Authorization");
        }
        if (auth !== undefined && auth.type !== "provider-managed" && !authSuppressed) {
          const secretName = managementAuthSecret ?? auth.secret;
          const secret = secrets.get(secretName) ?? settings.get(secretName);
          if (secret === undefined || secret === "")
            throw failure("missing-credential", `Missing credential ${secretName}`);
          const managedHeader = authorizationHeader(descriptor, secret);
          if (managedHeader !== undefined) {
            const [name, value] = managedHeader;
            withoutHeader(headers, name);
            headers[name] = value;
          }
        }
        const body = requestBody(method, requestOptions);
        const requestSignal = requestOptions.signal;
        if (requestSignal !== undefined && !(requestSignal instanceof AbortSignal)) {
          throw failure("api-failure", "Provider request cancellation signal is invalid");
        }
        const httpRequest: HttpRequest = {
          url: url.href,
          method,
          headers,
          timeoutMs: timeoutFrom(requestOptions),
          ...(body === undefined ? {} : { body }),
        };
        const response = asProviderResponse(
          await executeHttp(httpRequest, requestSignal as AbortSignal | undefined),
        );
        if (!parseJson) return response;
        try {
          return { ...response, json: JSON.parse(response.bodyText) as unknown };
        } catch {
          throw failure("parse-failure", "Provider response was not valid JSON");
        }
      };
      const context: ProviderContext = {
        settings: { get: getSetting, getSecret: (key) => secrets.get(key) },
        http: {
          get: (url, requestOptions) => request("GET", url, requestOptions),
          post: (url, requestOptions) => request("POST", url, requestOptions),
          getJSON: async (url, requestOptions) =>
            (await request("GET", url, requestOptions, true)) as ProviderJSONResponse,
          postJSON: async (url, requestOptions) =>
            (await request("POST", url, requestOptions, true)) as ProviderJSONResponse,
          postBinary: async (rawUrl, requestOptions) => {
            if (!(requestOptions.body instanceof Uint8Array)) {
              throw failure("api-failure", "Provider binary request body must be a Uint8Array");
            }
            if (requestOptions.body.byteLength > maximumResponseBytes) {
              throw failure("api-failure", "Provider binary request body exceeds 1 MiB");
            }
            const url = new URL(rawUrl);
            if (!endpointAllowed(url, origins)) {
              throw failure("api-failure", `Provider endpoint is not declared: ${url.origin}`);
            }
            openRouterManagementAuthSecret(descriptor, "POST", url, requestOptions);
            const headers = headersFrom(requestOptions.headers);
            const auth = descriptor.auth;
            if (auth !== undefined) {
              const secret = secrets.get(auth.secret) ?? settings.get(auth.secret);
              if (secret === undefined || secret === "") {
                throw failure("missing-credential", `Missing credential ${auth.secret}`);
              }
              const managedHeader = authorizationHeader(descriptor, secret);
              if (managedHeader !== undefined) {
                const [name, value] = managedHeader;
                withoutHeader(headers, name);
                headers[name] = value;
              }
            }
            return asProviderBinaryResponse(
              await executeHttp({
                url: url.href,
                method: "POST",
                headers,
                timeoutMs: timeoutFrom(
                  requestOptions.timeoutSeconds === undefined
                    ? {}
                    : { timeoutSeconds: requestOptions.timeoutSeconds },
                ),
                body: requestOptions.body.slice(),
              }),
            );
          },
        },
        browser: {
          cookieHeader: async (domain) => {
            if (
              descriptor.capabilities?.includes("browser-cookies") !== true ||
              !descriptor.cookieDomains?.includes(domain)
            ) {
              throw failure("permission-denied", `Cookie access is not declared for ${domain}`);
            }
            let cookie: string;
            try {
              const cookieHeader = options.browserSessions.cookieHeader(
                descriptor.id,
                domain,
                usesAccountScopedBrowserSession(descriptor.id) ? selectedAccount?.id : undefined,
              );
              cookie = await Effect.runPromise(cookieHeader, { signal: operationSignal });
            } catch (error) {
              if (isAbortError(error)) throw error;
              if (hostCancelled || operationSignal.aborted) {
                throw new DOMException("Provider refresh cancelled.", "AbortError");
              }
              if (error instanceof MissingBrowserCredentialError)
                throw failure("missing-credential", missingBrowserCredentialMessage);
              throw error;
            }
            redactionValues.add(cookie);
            addCookieComponentRedactions(redactionValues, cookie);
            return cookie;
          },
        },
        local: localFor(descriptor.id, options.local, operationSignal),
        ...(selectedAccount === undefined
          ? {}
          : {
              selectedAccount: {
                id: selectedAccount.id,
                ...(selectedAccount.accountEmail === undefined
                  ? {}
                  : { accountEmail: selectedAccount.accountEmail }),
                ...(selectedAccount.externalIdentifier === undefined
                  ? {}
                  : { externalIdentifier: selectedAccount.externalIdentifier }),
              },
            }),
        env: { timeZone },
        sourceMode: fetchContext.sourceMode,
        includeCredits: fetchContext.includeCredits,
        signal: operationSignal,
        date: {
          now,
          nowMillis: () => nowMillis,
          iso: (value) => new Date(value).toISOString(),
          unixSeconds: (value) => new Date(value * 1_000).toISOString(),
          unixMillis: (value) => new Date(value).toISOString(),
          nextDailyReset: (timeZone, hour) => nextDailyReset(nowMillis, timeZone, hour),
          sleep: (milliseconds) =>
            Effect.runPromise(options.clock.sleep(milliseconds), { signal: operationSignal }),
        },
        format: {
          number: (value, formatOptions) =>
            new Intl.NumberFormat("en-US", formatOptions as Intl.NumberFormatOptions).format(value),
          usd: (value) =>
            new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value),
          monthDay: (value) =>
            new Intl.DateTimeFormat("en-US", {
              month: "short",
              day: "numeric",
              timeZone: "UTC",
            }).format(value),
        },
        pct: (used, limit) =>
          !Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0
            ? 100
            : Math.max(0, Math.min(100, (used / limit) * 100)),
        amountFromPercent: (usedPercent, limit) =>
          (Math.max(0, usedPercent) / 100) * Math.max(0, limit),
        fail: {
          authenticationExpired: (message) => failure("authentication-expired", message),
          missingCredential: (message) => failure("missing-credential", message),
          permissionDenied: (message) => failure("permission-denied", message),
          rateLimited: (message) => failure("rate-limited", message),
          providerUnavailable: (message) => failure("provider-unavailable", message),
          parseFailure: (message) => failure("parse-failure", message),
          networkFailure: (message) => failure("network-failure", message),
          apiFailure: (message) => failure("api-failure", message),
        },
      };
      return mapProviderSnapshot(await strategy.fetchUsage(context), descriptor.id, now());
    },
    catch: (error) => error,
  }).pipe(
    Effect.catchIf(
      (error) => isAbortError(error) || hostCancelled,
      () => Effect.interrupt,
    ),
    Effect.mapError((error): ClassifiedFetchFailure => {
      if (error instanceof MissingBrowserCredentialError)
        return failure("missing-credential", missingBrowserCredentialMessage);
      if (error instanceof ClassifiedFetchFailure)
        return failure(error.kind, redact(error.message, redactionValues));
      return failure(
        "api-failure",
        redact(error instanceof Error ? error.message : "Provider refresh failed", redactionValues),
      );
    }),
    Effect.ensuring(Effect.sync(() => abortController.abort())),
  );
};
