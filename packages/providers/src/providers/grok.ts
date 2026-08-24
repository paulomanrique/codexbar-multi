import type {
  FirstPartyProvider,
  ProviderBinaryResponse,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderGrokCredentials,
  ProviderStrategy,
} from "../types.ts";
import { grokLocalSessionDetails } from "./grok-local-session.ts";

const endpoint = "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig";
const proxyEndpoint = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const settingsEndpoint = "https://cli-chat-proxy.grok.com/v1/settings";
const grpcRequestBody = new Uint8Array([0, 0, 0, 0, 0]);
const oidcScopePrefix = "https://auth.x.ai::";
const legacySessionScope = "https://accounts.x.ai/sign-in";

class GrokGrpcError extends Error {
  readonly status: number;
  readonly rpcMessage: string;

  constructor(status: number, rpcMessage: string) {
    super(`Grok billing gRPC status ${status}: ${rpcMessage}`);
    this.status = status;
    this.rpcMessage = rpcMessage;
  }
}

class GrokHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Grok billing returned HTTP ${status}`);
    this.status = status;
  }
}

const decoded = (value: string): string => {
  try {
    return decodeURIComponent(value.trim());
  } catch {
    return value.trim();
  }
};

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

const normalizedOAuthToken = (value: string | undefined): string | undefined => {
  let token = value?.trim() ?? "";
  if (token.toLowerCase().startsWith("bearer ")) token = token.slice(7).trim();
  if (
    token === "" ||
    token.toLowerCase().startsWith("cookie:") ||
    token.toLowerCase().startsWith("xai-") ||
    token.includes("=")
  )
    return undefined;
  return token;
};

const isoDate = (value: unknown): string | undefined => {
  const text = nonEmptyString(value);
  if (text === undefined || !Number.isFinite(Date.parse(text))) return undefined;
  return new Date(text).toISOString();
};

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

/** Pure port of GrokCredentialsStore.parse: OIDC wins only when it has a usable bearer. */
export const parseGrokAuthJson = (data: Uint8Array): ProviderGrokCredentials | undefined => {
  if (data.byteLength === 0 || data.byteLength > 1024 * 1024)
    throw new Error("Grok auth JSON is invalid.");
  let root: Readonly<Record<string, unknown>> | undefined;
  try {
    root = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)));
  } catch {
    throw new Error("Grok auth JSON is invalid.");
  }
  if (root === undefined) throw new Error("Grok auth JSON must be an object.");
  let oidc: readonly [string, Readonly<Record<string, unknown>>] | undefined;
  let legacy: readonly [string, Readonly<Record<string, unknown>>] | undefined;
  for (const [scope, candidate] of Object.entries(root)) {
    const entry = record(candidate);
    if (entry === undefined || normalizedOAuthToken(nonEmptyString(entry.key)) === undefined)
      continue;
    if (scope.startsWith(oidcScopePrefix)) oidc = [scope, entry];
    else if (scope === legacySessionScope || scope.includes("/sign-in")) legacy = [scope, entry];
  }
  const selected = oidc ?? legacy;
  if (selected === undefined) return undefined;
  const [scope, entry] = selected;
  const accessToken = normalizedOAuthToken(nonEmptyString(entry.key));
  if (accessToken === undefined) return undefined;
  const authMode = nonEmptyString(entry.auth_mode);
  const email = nonEmptyString(entry.email);
  const firstName = nonEmptyString(entry.first_name);
  const lastName = nonEmptyString(entry.last_name);
  const teamId = nonEmptyString(entry.team_id);
  const principalType = nonEmptyString(entry.principal_type);
  const expiresAt = isoDate(entry.expires_at);
  return {
    accessToken,
    scope,
    ...(authMode === undefined ? {} : { authMode }),
    ...(email === undefined ? {} : { email }),
    ...(firstName === undefined ? {} : { firstName }),
    ...(lastName === undefined ? {} : { lastName }),
    ...(teamId === undefined ? {} : { teamId }),
    ...(principalType === undefined ? {} : { principalType }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
};

const pastedGrokCredentials = (value: string | undefined): ProviderGrokCredentials | undefined => {
  const accessToken = normalizedOAuthToken(value);
  return accessToken === undefined ? undefined : { accessToken, scope: "", authMode: "oidc" };
};

const isExpired = (credentials: ProviderGrokCredentials, now: Date): boolean =>
  credentials.expiresAt !== undefined && Date.parse(credentials.expiresAt) <= now.getTime();

const grokPlan = (value: unknown): string | undefined => {
  const source = nonEmptyString(value);
  if (source === undefined) return undefined;
  const normalized = source.replaceAll(/[_\s-]+/gu, "").toLowerCase();
  if (normalized === "supergrokheavy" || normalized === "heavy") return "SuperGrok Heavy";
  if (normalized === "supergrok") return "SuperGrok";
  return source;
};

const grokIdentity = (credentials: ProviderGrokCredentials, tier?: string) => {
  const loginMethod =
    tier ?? (credentials.authMode?.toLowerCase() === "oidc" ? "SuperGrok" : credentials.authMode);
  return {
    ...(credentials.email === undefined ? {} : { accountEmail: credentials.email }),
    ...(credentials.teamId === undefined ? {} : { accountOrganization: credentials.teamId }),
    ...(loginMethod === undefined ? {} : { loginMethod }),
  };
};

const grpcHeaderFields = (
  headers: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> => {
  const fields: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase().startsWith("grpc-")) fields[name.toLowerCase()] = decoded(value);
  }
  return fields;
};

type GrpcFrame = { readonly flags: number; readonly body: Uint8Array };

const grpcFrames = (body: Uint8Array): readonly GrpcFrame[] => {
  const frames: GrpcFrame[] = [];
  let index = 0;
  while (index < body.length) {
    if (index + 5 > body.length) return [];
    const length =
      body[index + 1]! * 2 ** 24 +
      body[index + 2]! * 2 ** 16 +
      body[index + 3]! * 2 ** 8 +
      body[index + 4]!;
    const start = index + 5;
    const end = start + length;
    if (end > body.length) return [];
    frames.push({ flags: body[index]!, body: body.slice(start, end) });
    index = end;
  }
  return frames;
};

const grpcTrailerFields = (body: Uint8Array): Readonly<Record<string, string>> => {
  const fields: Record<string, string> = {};
  for (const frame of grpcFrames(body)) {
    if ((frame.flags & 0x80) === 0) continue;
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(frame.body);
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/u)) {
      const separator = line.indexOf(":");
      if (separator >= 0)
        fields[line.slice(0, separator).trim().toLowerCase()] = decoded(line.slice(separator + 1));
    }
  }
  return fields;
};

const throwGrpcStatus = (fields: Readonly<Record<string, string>>): void => {
  const status = Number(fields["grpc-status"]);
  if (Number.isInteger(status) && status !== 0)
    throw new GrokGrpcError(status, fields["grpc-message"] ?? "");
};

const readVarint = (bytes: Uint8Array, start: number): readonly [number, number] | undefined => {
  let value = 0;
  let shift = 0;
  for (let index = start; index < bytes.length && shift < 53; index += 1, shift += 7) {
    const byte = bytes[index]!;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return [value, index + 1];
  }
  return undefined;
};

type Fixed32 = { readonly path: readonly number[]; readonly value: number; readonly order: number };
type Varint = { readonly path: readonly number[]; readonly value: number };
type Scan = {
  readonly fixed32: readonly Fixed32[];
  readonly varints: readonly Varint[];
  readonly order: number;
};

const scanProtobuf = (
  bytes: Uint8Array,
  depth = 0,
  path: readonly number[] = [],
  initialOrder = 0,
): Scan => {
  const fixed32: Fixed32[] = [];
  const varints: Varint[] = [];
  let order = initialOrder;
  let index = 0;
  while (index < bytes.length) {
    const fieldStart = index;
    const key = readVarint(bytes, index);
    if (key === undefined || key[0] === 0) {
      index = fieldStart + 1;
      continue;
    }
    index = key[1];
    const fieldPath = [...path, Math.floor(key[0] / 8)];
    switch (key[0] & 7) {
      case 0: {
        const value = readVarint(bytes, index);
        if (value === undefined) index = fieldStart + 1;
        else {
          varints.push({ path: fieldPath, value: value[0] });
          index = value[1];
        }
        break;
      }
      case 1:
        if (index + 8 > bytes.length) return { fixed32, varints, order };
        index += 8;
        break;
      case 2: {
        const length = readVarint(bytes, index);
        if (length === undefined || length[0] > bytes.length - length[1]) {
          index = fieldStart + 1;
          break;
        }
        const end = length[1] + length[0];
        if (depth < 4) {
          const nested = scanProtobuf(bytes.slice(length[1], end), depth + 1, fieldPath, order);
          fixed32.push(...nested.fixed32);
          varints.push(...nested.varints);
          order = nested.order;
        }
        index = end;
        break;
      }
      case 5:
        if (index + 4 > bytes.length) return { fixed32, varints, order };
        fixed32.push({
          path: fieldPath,
          value: new DataView(bytes.buffer, bytes.byteOffset + index, 4).getFloat32(0, true),
          order,
        });
        order += 1;
        index += 4;
        break;
      default:
        index = fieldStart + 1;
    }
  }
  return { fixed32, varints, order };
};

const looksLikeProtobuf = (body: Uint8Array): boolean => {
  const first = body[0];
  return first !== undefined && first >> 3 > 0 && [0, 1, 2, 5].includes(first & 7);
};

/** Swift-oracle compatible parser for GetGrokCreditsConfig gRPC-web responses. */
export const parseGrokGrpcWebResponse = (
  body: Uint8Array,
  now: Date = new Date(),
): { readonly usedPercent: number; readonly resetsAt?: string } => {
  const frames = grpcFrames(body);
  const payloads = frames.filter((frame) => (frame.flags & 0x80) === 0).map((frame) => frame.body);
  if (payloads.length === 0 && looksLikeProtobuf(body)) payloads.push(body);
  if (payloads.length === 0) throw new Error("Grok billing returned no protobuf payload.");
  const scan = payloads.reduce<Scan>(
    (result, payload) => {
      const next = scanProtobuf(payload, 0, [], result.order);
      return {
        fixed32: [...result.fixed32, ...next.fixed32],
        varints: [...result.varints, ...next.varints],
        order: next.order,
      };
    },
    { fixed32: [], varints: [], order: 0 },
  );
  const percent = scan.fixed32
    .filter(
      (field) =>
        field.path.at(-1) === 1 &&
        Number.isFinite(field.value) &&
        field.value >= 0 &&
        field.value <= 100,
    )
    .sort(
      (left, right) => left.path.length - right.path.length || left.order - right.order,
    )[0]?.value;
  const resets = scan.varints
    .filter((field) => field.value >= 1_700_000_000 && field.value <= 2_100_000_000)
    .map((field) => ({ ...field, date: new Date(field.value * 1_000) }))
    .filter((field) => field.date > now)
    .sort((left, right) => left.date.getTime() - right.date.getTime());
  const reset =
    resets.find(
      (field) =>
        field.path.length === 3 &&
        field.path[0] === 1 &&
        field.path[1] === 5 &&
        field.path[2] === 1,
    )?.date ?? resets[0]?.date;
  const hasUsagePeriod = scan.varints.some(
    (field) =>
      (field.path[0] === 1 && field.path[1] === 6) ||
      (field.path.length === 3 &&
        field.path[0] === 1 &&
        field.path[1] === 8 &&
        field.path[2] === 1 &&
        [1, 2].includes(field.value)),
  );
  const usedPercent =
    percent ?? (scan.fixed32.length === 0 && reset !== undefined && hasUsagePeriod ? 0 : undefined);
  if (usedPercent === undefined) throw new Error("Could not parse Grok web billing usage.");
  return { usedPercent, ...(reset === undefined ? {} : { resetsAt: reset.toISOString() }) };
};

const retryable = (error: unknown): boolean =>
  (error instanceof GrokHttpError && [408, 502, 503, 504].includes(error.status)) ||
  (error instanceof GrokGrpcError &&
    (error.status === 4 ||
      (error.status === 1 && /timeout|deadline|expired/iu.test(error.message))));

const classify = (ctx: ProviderContext, error: unknown): Error => {
  if (error instanceof GrokHttpError) {
    if ([401, 403].includes(error.status))
      return ctx.fail.authenticationExpired("Grok billing rejected the web session.");
    if (error.status === 429) return ctx.fail.rateLimited("Grok billing returned HTTP 429.");
    if (error.status >= 500)
      return ctx.fail.providerUnavailable(`Grok billing returned HTTP ${error.status}.`);
    return ctx.fail.apiFailure(error.message);
  }
  if (error instanceof GrokGrpcError) {
    const message = error.message.toLowerCase();
    const badCredential =
      error.status === 16 ||
      (error.status === 7 &&
        (message.includes("bad-credentials") ||
          message.includes("unauthenticated") ||
          (message.includes("oauth2") && message.includes("could not be validated")) ||
          (message.includes("access token") &&
            (message.includes("invalid") ||
              message.includes("expired") ||
              message.includes("could not be validated")))));
    if (badCredential)
      return ctx.fail.authenticationExpired("Grok billing rejected the web session.");
    if (error.status === 9 && message.trim().endsWith("no personal team"))
      return ctx.fail.providerUnavailable(
        "Grok team usage is unavailable from the current billing surface.",
      );
    return ctx.fail.apiFailure(error.message);
  }
  if (error instanceof Error) return ctx.fail.parseFailure(error.message);
  return ctx.fail.apiFailure("Grok billing failed.");
};

const fetchOnce = async (ctx: ProviderContext, cookie: string): Promise<ProviderBinaryResponse> => {
  if (ctx.http.postBinary === undefined)
    throw ctx.fail.providerUnavailable("Grok gRPC-web support is not configured by this host.");
  const response = await ctx.http.postBinary(endpoint, {
    body: grpcRequestBody,
    timeoutSeconds: 15,
    headers: {
      Cookie: cookie,
      Origin: "https://grok.com",
      Referer: "https://grok.com/?_s=usage",
      Accept: "*/*",
      "Content-Type": "application/grpc-web+proto",
      "x-grpc-web": "1",
      "x-user-agent": "connect-es/2.1.1",
      "User-Agent": "CodexBar",
    },
  });
  if (response.status !== 200) throw new GrokHttpError(response.status);
  throwGrpcStatus(grpcHeaderFields(response.headers));
  throwGrpcStatus(grpcTrailerFields(response.body));
  return response;
};

const fetchOAuthGrpcOnce = async (
  ctx: ProviderContext,
  credentials: ProviderGrokCredentials,
): Promise<ProviderBinaryResponse> => {
  if (ctx.http.postBinary === undefined)
    throw ctx.fail.providerUnavailable("Grok gRPC-web support is not configured by this host.");
  const response = await ctx.http.postBinary(endpoint, {
    body: grpcRequestBody,
    timeoutSeconds: 15,
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      Origin: "https://grok.com",
      Referer: "https://grok.com/?_s=usage",
      Accept: "*/*",
      "Content-Type": "application/grpc-web+proto",
      "x-grpc-web": "1",
      "x-user-agent": "connect-es/2.1.1",
      "User-Agent": "CodexBar",
    },
  });
  if (response.status !== 200) throw new GrokHttpError(response.status);
  throwGrpcStatus(grpcHeaderFields(response.headers));
  throwGrpcStatus(grpcTrailerFields(response.body));
  return response;
};

const proxyHeaders = (credentials: ProviderGrokCredentials): Readonly<Record<string, string>> => ({
  Authorization: `Bearer ${credentials.accessToken}`,
  "x-xai-token-auth": "xai-grok-cli",
  Accept: "application/json",
  "User-Agent": "CodexBar",
});

const proxyStatus = (ctx: ProviderContext, status: number): never => {
  if (status === 401 || status === 403)
    throw ctx.fail.authenticationExpired("Grok CLI proxy rejected credentials. Run 'grok login'.");
  if (status === 429) throw ctx.fail.rateLimited("Grok CLI proxy returned HTTP 429.");
  if (status >= 500) throw ctx.fail.providerUnavailable(`Grok CLI proxy returned HTTP ${status}.`);
  throw ctx.fail.apiFailure(`Grok CLI proxy returned HTTP ${status}.`);
};

type GrokCreditsSnapshot = {
  readonly usedPercent?: number;
  readonly resetsAt?: string;
  readonly subscriptionTier?: string;
};

/** Pure port of GrokCreditsProxyFetcher.parseSnapshot. */
export const parseGrokCreditsProxyResponse = (value: unknown): GrokCreditsSnapshot => {
  const root = record(value);
  const config = root === undefined ? undefined : record(root.config);
  if (config === undefined) throw new Error("Grok CLI proxy response is invalid.");
  const currentPeriod = record(config.currentPeriod);
  const resetsAt = isoDate(currentPeriod?.end) ?? isoDate(config.billingPeriodEnd);
  const percent = config.creditUsagePercent;
  const cap = record(config.onDemandCap)?.val;
  const used = record(config.onDemandUsed)?.val;
  const subscriptionTier = grokPlan(config.subscriptionTier ?? root?.subscriptionTier);
  const details = {
    ...(resetsAt === undefined ? {} : { resetsAt }),
    ...(subscriptionTier === undefined ? {} : { subscriptionTier }),
  };
  if (typeof percent === "number" && Number.isFinite(percent)) {
    return { ...details, usedPercent: Math.max(0, Math.min(100, percent)) };
  }
  if (
    typeof cap === "number" &&
    Number.isFinite(cap) &&
    cap > 0 &&
    typeof used === "number" &&
    Number.isFinite(used)
  ) {
    return { ...details, usedPercent: Math.max(0, Math.min(100, (used / cap) * 100)) };
  }
  if (resetsAt !== undefined) return details;
  throw new Error("Grok CLI proxy response has no usage data.");
};

const settingsTier = async (
  ctx: ProviderContext,
  credentials: ProviderGrokCredentials,
): Promise<string | undefined> => {
  try {
    const response = await ctx.http.get(settingsEndpoint, {
      timeoutSeconds: 2,
      headers: proxyHeaders(credentials),
    });
    if (response.status !== 200) return undefined;
    return grokPlan(record(JSON.parse(response.bodyText))?.subscription_tier_display);
  } catch {
    // Plan enrichment is best-effort and must not erase a valid billing result.
    return undefined;
  }
};

const resolvedOAuthCredentials = async (ctx: ProviderContext): Promise<ProviderGrokCredentials> => {
  const pasted = pastedGrokCredentials(ctx.settings.getSecret("GROK_OAUTH_TOKEN"));
  if (pasted !== undefined) return pasted;
  const fromFile = await ctx.local?.fetchGrokCredentials?.();
  if (fromFile === undefined || isExpired(fromFile, ctx.date.now()))
    throw ctx.fail.missingCredential(
      "Grok OAuth credentials are not configured. Run 'grok login'.",
    );
  return fromFile;
};

const oauthProxyUsage = async (ctx: ProviderContext) => {
  const credentials = await resolvedOAuthCredentials(ctx);
  const response = await ctx.http.get(proxyEndpoint, {
    timeoutSeconds: 15,
    headers: proxyHeaders(credentials),
  });
  if (response.status !== 200) return proxyStatus(ctx, response.status);
  let parsed: GrokCreditsSnapshot;
  try {
    parsed = parseGrokCreditsProxyResponse(JSON.parse(response.bodyText));
  } catch (error) {
    throw ctx.fail.parseFailure(
      error instanceof Error ? error.message : "Grok CLI proxy response is invalid.",
    );
  }
  const tier = (await settingsTier(ctx, credentials)) ?? parsed.subscriptionTier;
  const identity = grokIdentity(credentials, tier);
  if (parsed.usedPercent === undefined) return { identity };
  return {
    primary: {
      usedPercent: parsed.usedPercent,
      ...(parsed.resetsAt === undefined ? {} : { resetsAt: parsed.resetsAt }),
    },
    identity,
  };
};

const cliBillingUsage = async (ctx: ProviderContext) => {
  if (ctx.local?.fetchGrokCliBilling === undefined)
    throw ctx.fail.providerUnavailable("Grok CLI billing is not configured by this host.");
  const result = await ctx.local.fetchGrokCliBilling();
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (/authentication required|grok login|not authenticated/iu.test(output))
    throw ctx.fail.authenticationExpired("Grok billing requires authentication. Run 'grok login'.");
  if (result.exitCode !== 0)
    throw ctx.fail.providerUnavailable(
      `Grok CLI exited with status ${result.exitCode ?? "unknown"}.`,
    );
  const lines = result.stdout.split(/\r?\n/u).filter((line) => line.trim() !== "");
  let billing: Readonly<Record<string, unknown>> | undefined;
  for (const line of lines) {
    if (new TextEncoder().encode(line).byteLength > 256 * 1024)
      throw ctx.fail.parseFailure("Grok CLI response line exceeded 256 KiB.");
    let message: Readonly<Record<string, unknown>> | undefined;
    try {
      message = record(JSON.parse(line));
    } catch {
      continue;
    }
    if (message?.id === 2) {
      if (record(message.error) !== undefined)
        throw ctx.fail.apiFailure(
          nonEmptyString(record(message.error)?.message) ?? "Grok CLI billing failed.",
        );
      billing = record(message.result);
      break;
    }
  }
  if (billing === undefined) throw ctx.fail.parseFailure("Grok CLI billing response is missing.");
  const cycle = record(billing.billingCycle);
  const limit = record(billing.monthlyLimit)?.val;
  const used = record(record(billing.usage)?.totalUsed)?.val;
  if (
    typeof limit !== "number" ||
    !Number.isFinite(limit) ||
    limit <= 0 ||
    typeof used !== "number" ||
    !Number.isFinite(used)
  )
    throw ctx.fail.parseFailure("Grok CLI billing response has no included usage.");
  const start = isoDate(cycle?.billingPeriodStart);
  const end = isoDate(cycle?.billingPeriodEnd);
  const windowMinutes =
    start === undefined || end === undefined
      ? undefined
      : Math.floor((Date.parse(end) - Date.parse(start)) / 60_000);
  return {
    primary: {
      usedPercent: Math.max(0, Math.min(100, (used / limit) * 100)),
      ...(end === undefined ? {} : { resetsAt: end }),
      ...(windowMinutes === undefined || windowMinutes <= 0 ? {} : { windowMinutes }),
    },
  };
};

const oauthGrpcUsage = async (ctx: ProviderContext) => {
  const credentials = await resolvedOAuthCredentials(ctx);
  let response: ProviderBinaryResponse;
  try {
    response = await fetchOAuthGrpcOnce(ctx, credentials);
  } catch (error) {
    if (error instanceof GrokHttpError || error instanceof GrokGrpcError)
      throw classify(ctx, error);
    throw error;
  }
  try {
    const primary = parseGrokGrpcWebResponse(response.body, ctx.date.now());
    const tier = await settingsTier(ctx, credentials);
    return { primary, identity: grokIdentity(credentials, tier) };
  } catch (error) {
    throw classify(ctx, error);
  }
};

const definition: ProviderDefinition = {
  id: "grok",
  name: "Grok",
  endpoints: ["https://grok.com", "https://cli-chat-proxy.grok.com"],
  settings: [
    { key: "GROK_OAUTH_TOKEN", title: "SuperGrok OAuth token", type: "secure" },
    { key: "GROK_COOKIE_HEADER", title: "Cookie header", type: "secure" },
  ],
  capabilities: ["browser-cookies"],
  cookieDomains: ["grok.com"],
  fetchUsage: async (ctx) => {
    const cookie =
      ctx.settings.getSecret("GROK_COOKIE_HEADER")?.trim() ||
      (await ctx.browser.cookieHeader("grok.com"));
    if (!cookie) throw ctx.fail.missingCredential("Grok web session is not configured.");
    let response: ProviderBinaryResponse;
    try {
      response = await fetchOnce(ctx, cookie);
    } catch (error) {
      if (!retryable(error)) {
        if (error instanceof GrokHttpError || error instanceof GrokGrpcError)
          throw classify(ctx, error);
        throw error;
      }
      try {
        response = await fetchOnce(ctx, cookie);
      } catch (retryError) {
        if (retryError instanceof GrokHttpError || retryError instanceof GrokGrpcError)
          throw classify(ctx, retryError);
        throw retryError;
      }
    }
    try {
      const primary = parseGrokGrpcWebResponse(response.body, ctx.date.now());
      // Local sessions are observational diagnostics only. They never create
      // a quota fallback and cannot make a successful billing response fail.
      const localSummary = await ctx.local?.fetchGrokLocalSessionSummary?.().catch(() => undefined);
      return {
        primary,
        ...(localSummary === undefined ? {} : { details: grokLocalSessionDetails(localSummary) }),
      };
    } catch (error) {
      throw classify(ctx, error);
    }
  },
};

const grokAutoFallbackOn = [
  "authentication-expired",
  "missing-credential",
  "provider-unavailable",
  "parse-failure",
  "network-failure",
  "rate-limited",
  "permission-denied",
  "api-failure",
] as const;

const webStrategy: ProviderStrategy = {
  id: "grok.web",
  kind: "web",
  fetchUsage: definition.fetchUsage,
  fallbackOn: grokAutoFallbackOn,
};
const cliStrategy: ProviderStrategy = {
  id: "grok.cli",
  kind: "cli",
  fetchUsage: cliBillingUsage,
  fallbackOn: grokAutoFallbackOn,
};
const oauthProxyStrategy: ProviderStrategy = {
  id: "grok.oauth",
  kind: "oauth",
  fetchUsage: oauthProxyUsage,
  fallbackOn: grokAutoFallbackOn,
};
const oauthGrpcStrategy: ProviderStrategy = {
  id: "grok.oauth-grpc",
  kind: "oauth",
  fetchUsage: oauthGrpcUsage,
};
export const descriptor: ProviderDescriptor = {
  ...definition,
  status: "partial",
  strategy: webStrategy,
  strategies: [cliStrategy, oauthProxyStrategy, webStrategy, oauthGrpcStrategy],
};
export const grok: FirstPartyProvider = {
  ...webStrategy,
  descriptor,
  strategies: [cliStrategy, oauthProxyStrategy, webStrategy, oauthGrpcStrategy],
};
