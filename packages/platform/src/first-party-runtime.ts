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
  type ProviderFetchContext,
  type ProviderFetchStrategy,
  type ProviderRuntimeService,
  normalizeEndpoint,
} from "@codexbar/core";
import type { ProviderId, UsageSnapshot } from "@codexbar/contracts";
import { mapProviderSnapshot } from "@codexbar/providers";
import type {
  FirstPartyProvider,
  ProviderBinaryResponse,
  ProviderContext,
  ProviderDescriptor,
  ProviderJSONResponse,
  ProviderLocalCapabilities,
  ProviderLocalCommand,
  ProviderLocalData,
  ProviderLocalDataResult,
  ProviderLocalProcessResult,
  ProviderResponse,
} from "@codexbar/providers";

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
  readonly cookieHeader: (providerId: ProviderId, domain: string) => Effect.Effect<string, unknown>;
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
}

export interface FirstPartyProviderRuntimeOptions {
  readonly providers: readonly FirstPartyProvider[];
  readonly settings: FirstPartySettings;
  readonly browserSessions: FirstPartyBrowserSessions;
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

const sourceFor = (provider: FirstPartyProvider): ProviderFetchStrategy["source"] =>
  provider.kind === "web"
    ? "web"
    : provider.kind === "cli"
      ? "cli"
      : provider.kind === "local"
        ? "local-probe"
        : "api-token";

const acceptsSource = (
  provider: FirstPartyProvider,
  mode: ProviderFetchContext["sourceMode"],
): boolean =>
  mode === "auto" ||
  (mode === "web" && provider.kind === "web") ||
  (mode === "cli" && (provider.kind === "cli" || provider.kind === "local")) ||
  (mode === "api" && provider.kind === "api");

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
    const configured = setting(endpoint.setting) ?? endpoint.default;
    if (configured === undefined) continue;
    const transport =
      endpoint.policy === "https"
        ? "https-only"
        : endpoint.policy === "https-or-loopback-http"
          ? "loopback-http"
          : "private-network-http";
    const normalized = normalizeEndpoint(configured, { transport });
    if (normalized !== undefined) rules.push({ kind: "origin", origin: normalized.origin });
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

const redact = (message: string, values: ReadonlySet<string>): string => {
  let redacted = message;
  for (const value of values) {
    if (value !== "") redacted = redacted.replaceAll(value, "[REDACTED]");
  }
  return redacted;
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

const withoutHeader = (headers: Record<string, string>, name: string): void => {
  for (const key of Object.keys(headers))
    if (key.toLowerCase() === name.toLowerCase()) delete headers[key];
};

const asProviderResponse = (response: HttpResponse): ProviderResponse => ({
  status: response.status,
  bodyText: text(response.body),
});

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

  const strategyFor = (
    providerId: ProviderId,
    context: ProviderFetchContext,
  ): Effect.Effect<readonly ProviderFetchStrategy[], never> => {
    const provider = byId.get(providerId);
    if (provider === undefined || !acceptsSource(provider, context.sourceMode))
      return Effect.succeed([]);
    const strategy: ProviderFetchStrategy = {
      id: provider.id,
      source: sourceFor(provider),
      isAvailable: () => Effect.succeed(true),
      fetch: () => executeProvider(provider, context, options, keyFor),
      shouldFallback: () => false,
    };
    return Effect.succeed([strategy]);
  };

  const pipeline = makeProviderFetchPipeline({ resolveStrategies: strategyFor });
  return {
    fetch: (providerId, context) =>
      pipeline.fetch(providerId, context).pipe(Effect.provideService(Clock, options.clock)),
  };
};

const executeProvider = (
  provider: FirstPartyProvider,
  fetchContext: ProviderFetchContext,
  options: FirstPartyProviderRuntimeOptions,
  keyFor: (providerId: ProviderId, setting: string) => string,
): Effect.Effect<UsageSnapshot, ClassifiedFetchFailure> => {
  const redactionValues = new Set<string>();
  const abortController = new AbortController();
  return Effect.tryPromise({
    try: async (signal) => {
      const operationSignal = AbortSignal.any([signal, abortController.signal]);
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
        const injected = await Effect.runPromise(
          options.settings.read(descriptor.id, setting.key),
          {
            signal: operationSignal,
          },
        );
        if (secureKeys.has(setting.key)) {
          let stored: string | undefined;
          try {
            stored = await Effect.runPromise(
              options.credentials.read(keyFor(descriptor.id, setting.key)),
              { signal: operationSignal },
            );
          } catch (error) {
            if (injected === undefined) throw error;
          }
          const secret = stored ?? injected;
          secrets.set(setting.key, secret);
          if (secret !== undefined) redactionValues.add(secret);
        } else {
          settings.set(setting.key, injected);
        }
      }
      if (descriptor.auth !== undefined && !secrets.has(descriptor.auth.secret)) {
        const injected = await Effect.runPromise(
          options.settings.read(descriptor.id, descriptor.auth.secret),
          { signal: operationSignal },
        );
        let stored: string | undefined;
        try {
          stored = await Effect.runPromise(
            options.credentials.read(keyFor(descriptor.id, descriptor.auth.secret)),
            { signal: operationSignal },
          );
        } catch (error) {
          if (injected === undefined) throw error;
        }
        const secret = stored ?? injected;
        secrets.set(descriptor.auth.secret, secret);
        if (secret !== undefined) redactionValues.add(secret);
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
        if (auth !== undefined) {
          const secret = secrets.get(auth.secret) ?? settings.get(auth.secret);
          if (secret === undefined || secret === "")
            throw failure("missing-credential", `Missing credential ${auth.secret}`);
          const managedHeader = authorizationHeader(descriptor, secret);
          if (managedHeader !== undefined) {
            const [name, value] = managedHeader;
            withoutHeader(headers, name);
            headers[name] = value;
          }
        }
        const body = requestBody(method, requestOptions);
        const httpRequest: HttpRequest = {
          url: url.href,
          method,
          headers,
          timeoutMs: timeoutFrom(requestOptions),
          ...(body === undefined ? {} : { body }),
        };
        const response = asProviderResponse(
          await Effect.runPromise(options.http.execute(httpRequest), { signal: operationSignal }),
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
              await Effect.runPromise(
                options.http.execute({
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
                { signal: operationSignal },
              ),
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
            const cookie = await Effect.runPromise(
              options.browserSessions.cookieHeader(descriptor.id, domain),
              { signal: operationSignal },
            );
            redactionValues.add(cookie);
            for (const pair of cookie.split(";")) {
              const separator = pair.indexOf("=");
              if (separator >= 0) redactionValues.add(pair.slice(separator + 1).trim());
            }
            return cookie;
          },
        },
        local: localFor(descriptor.id, options.local, operationSignal),
        env: { timeZone },
        sourceMode: fetchContext.sourceMode,
        date: {
          now,
          nowMillis: () => nowMillis,
          iso: (value) => new Date(value).toISOString(),
          unixSeconds: (value) => new Date(value * 1_000).toISOString(),
          unixMillis: (value) => new Date(value).toISOString(),
          nextDailyReset: (timeZone, hour) => nextDailyReset(nowMillis, timeZone, hour),
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
      return mapProviderSnapshot(await provider.fetchUsage(context), descriptor.id, now());
    },
    catch: (error) =>
      error instanceof ClassifiedFetchFailure
        ? failure(error.kind, redact(error.message, redactionValues))
        : failure(
            "api-failure",
            redact(
              error instanceof Error ? error.message : "Provider refresh failed",
              redactionValues,
            ),
          ),
  }).pipe(Effect.ensuring(Effect.sync(() => abortController.abort())));
};
