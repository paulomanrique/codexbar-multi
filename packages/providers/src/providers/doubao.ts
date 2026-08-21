import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderJSONResponse,
  ProviderSnapshot,
  ProviderStrategy,
} from "../types.ts";
import { number, object, string } from "./_http.ts";

const encoder = new TextEncoder();
const emptySha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const algorithm = "HMAC-SHA256";
const service = "ark";
const terminator = "request";
const signedHeaders = "content-type;host;x-content-sha256;x-date";
const defaultContentType = "application/x-www-form-urlencoded; charset=utf-8";
const defaultRegion = "cn-beijing";
const codingPlanURL =
  "https://open.volcengineapi.com/?Action=GetCodingPlanUsage&Version=2024-01-01";
const agentPlanURL = "https://open.volcengineapi.com/?Action=GetAFPUsage&Version=2024-01-01";
const arkProbeURL = "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions";
const probeModels = ["doubao-seed-2.0-code", "doubao-1.5-pro-32k", "doubao-lite-32k"] as const;
const apiKeyKeys = ["ARK_API_KEY", "VOLCENGINE_API_KEY", "DOUBAO_API_KEY"] as const;
const accessKeyKeys = [
  "VOLCENGINE_ACCESS_KEY_ID",
  "VOLCENGINE_ACCESS_KEY",
  "VOLC_ACCESSKEY",
  "DOUBAO_ACCESS_KEY_ID",
] as const;
const secretKeyKeys = [
  "VOLCENGINE_SECRET_ACCESS_KEY",
  "VOLCENGINE_SECRET_KEY",
  "VOLCENGINE_ACCESS_KEY_SECRET",
  "VOLC_SECRETKEY",
  "DOUBAO_SECRET_ACCESS_KEY",
] as const;
const regionKeys = [
  "VOLCENGINE_REGION",
  "VOLCENGINE_REGION_ID",
  "VOLC_REGION",
  "DOUBAO_REGION",
  "ARK_REGION",
] as const;

type Credentials = {
  readonly accessKeyID: string;
  readonly secretAccessKey: string;
  readonly region: string;
};
type Quota = { readonly level: string; readonly percent: number; readonly resetsAt?: string };
type PlanUsage = {
  readonly status?: string;
  readonly updateTime?: string;
  readonly quotas: readonly Quota[];
};
type RateWindow = {
  readonly usedPercent: number;
  readonly windowMinutes?: number;
  readonly resetsAt?: string;
  readonly resetDescription?: string;
};
type NamedWindow = { readonly id: string; readonly title: string; readonly window: RateWindow };
type ArkProbe = {
  readonly remaining: number;
  readonly limit: number;
  readonly resetTime?: string;
  readonly valid: boolean;
  readonly reliable: boolean;
  readonly status: number;
  readonly totalTokens?: number;
};

export class DoubaoApiError extends Error {
  readonly status: number;

  constructor(status: number, summary: string) {
    super(`Doubao API error (${status}): ${summary}`);
    this.status = status;
    this.name = "api-failure";
  }
}

const hex = (value: ArrayBuffer | Uint8Array): string =>
  [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const digest = async (value: string): Promise<string> =>
  hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
const hmac = async (key: Uint8Array, value: string): Promise<Uint8Array> =>
  new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      await crypto.subtle.importKey(
        "raw",
        key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) as ArrayBuffer,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      ),
      encoder.encode(value),
    ),
  );
const hmacHex = async (key: Uint8Array, value: string): Promise<string> =>
  hex(await hmac(key, value));

const percentEncode = (value: string, encodeSlash = true): string => {
  let encoded = "";
  for (const char of value) {
    if (/[A-Za-z0-9\-._~]/u.test(char) || (!encodeSlash && char === "/")) encoded += char;
    else {
      for (const byte of encoder.encode(char))
        encoded += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return encoded;
};
const canonicalURI = (url: URL): string => percentEncode(url.pathname || "/", false);
const canonicalQueryString = (url: URL): string => {
  const pairs = [...url.searchParams.entries()].map(([key, value]) => ({
    key: percentEncode(key),
    value: percentEncode(value),
  }));
  pairs.sort((left, right) =>
    left.key === right.key
      ? left.value.localeCompare(right.value)
      : left.key.localeCompare(right.key),
  );
  return pairs.map((pair) => `${pair.key}=${pair.value}`).join("&");
};
const amzDate = (value: Date): string =>
  value
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d{3}/u, "");

export const signDoubaoVolcengineRequest = async (params: {
  readonly method?: string;
  readonly url: string;
  readonly body?: string;
  readonly accessKeyID: string;
  readonly secretAccessKey: string;
  readonly region: string;
  readonly date: Date;
}): Promise<Readonly<Record<string, string>>> => {
  const url = new URL(params.url);
  const timestamp = amzDate(params.date);
  const dateStamp = timestamp.slice(0, 8);
  const payloadHash = params.body ? await digest(params.body) : emptySha256;
  const contentType = defaultContentType;
  const host = url.host;
  const canonicalRequest = [
    params.method ?? "POST",
    canonicalURI(url),
    canonicalQueryString(url),
    `content-type:${contentType}`,
    `host:${host}`,
    `x-content-sha256:${payloadHash}`,
    `x-date:${timestamp}`,
    "",
    signedHeaders,
    payloadHash,
  ].join("\n");
  const credentialScope = `${dateStamp}/${params.region}/${service}/${terminator}`;
  const stringToSign = [algorithm, timestamp, credentialScope, await digest(canonicalRequest)].join(
    "\n",
  );
  const dateKey = await hmac(encoder.encode(params.secretAccessKey), dateStamp);
  const regionKey = await hmac(dateKey, params.region);
  const serviceKey = await hmac(regionKey, service);
  const signingKey = await hmac(serviceKey, terminator);
  const signature = await hmacHex(signingKey, stringToSign);
  return {
    Accept: "application/json",
    "Content-Type": contentType,
    Host: host,
    "X-Date": timestamp,
    "X-Content-Sha256": payloadHash,
    Authorization: `${algorithm} Credential=${params.accessKeyID}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
};

const cleaned = (value: string | undefined): string | undefined => {
  const trimmed = value
    ?.trim()
    .replace(/^("([\s\S]*)"|'([\s\S]*)')$/, "$2$3")
    .trim();
  return trimmed || undefined;
};
const firstSetting = (ctx: ProviderContext, keys: readonly string[]): string | undefined => {
  for (const key of keys) {
    const found = cleaned(ctx.settings.getSecret(key)) || cleaned(ctx.settings.get(key));
    if (found) return found;
  }
  return undefined;
};
const clamp = (value: number): number => Math.max(0, Math.min(100, value));
const cancelled = (error: unknown): boolean =>
  (error instanceof Error || error instanceof DOMException) &&
  (error.name === "AbortError" || error.name === "CanceledError");
const compactText = (text: string, maxLength = 200): string => {
  const collapsed = [...text]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127 ? " " : character;
    })
    .join("")
    .replaceAll(/\s+/gu, " ")
    .trim();
  return collapsed.length <= maxLength ? collapsed : `${collapsed.slice(0, maxLength)}...`;
};
const epochSeconds = (value: unknown, ctx: ProviderContext): string | undefined => {
  const parsed = number(value);
  return parsed !== undefined && parsed > 0 ? ctx.date.unixSeconds(parsed) : undefined;
};
const epochMillis = (value: unknown, ctx: ProviderContext): string | undefined => {
  const parsed = number(value);
  return parsed !== undefined && parsed > 0 ? ctx.date.unixMillis(parsed) : undefined;
};

const apiErrorSummary = (_statusCode: number, json: unknown, bodyText: string): string => {
  const root = object(json);
  const volcError = object(object(root?.ResponseMetadata)?.Error);
  if (volcError) {
    const code = string(volcError.Code);
    const message = string(volcError.Message);
    if (code && message) return compactText(`${code}: ${message}`);
    if (code) return compactText(code);
    if (message) return compactText(message);
  }
  const nested = string(object(root?.error)?.message);
  if (nested) return compactText(nested);
  const message = string(root?.message);
  if (message) return compactText(message);
  const text = bodyText.trim();
  if (text) return compactText(text);
  return `Unexpected response body (${bodyText.length} bytes).`;
};

const codingPlanCredentials = (ctx: ProviderContext): Credentials | undefined => {
  const accessKeyID = firstSetting(ctx, accessKeyKeys);
  const secretAccessKey = firstSetting(ctx, secretKeyKeys);
  if (!accessKeyID || !secretAccessKey) return undefined;
  return { accessKeyID, secretAccessKey, region: firstSetting(ctx, regionKeys) ?? defaultRegion };
};
const arkApiKey = (ctx: ProviderContext): string | undefined => firstSetting(ctx, apiKeyKeys);

const classified = (error: unknown): boolean =>
  cancelled(error) ||
  error instanceof DoubaoApiError ||
  (typeof error === "object" && error !== null && "kind" in error) ||
  (error instanceof Error &&
    /^(authentication-expired|missing-credential|permission-denied|rate-limited|provider-unavailable|parse-failure|network-failure|api-failure)/u.test(
      error.message,
    ));
const postJSON = async (
  ctx: ProviderContext,
  url: string,
  options?: Record<string, unknown>,
): Promise<ProviderJSONResponse> => {
  try {
    return await ctx.http.postJSON(url, options);
  } catch (error) {
    if (classified(error)) throw error;
    throw ctx.fail.networkFailure(
      `Doubao network error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

const header = (
  headers: Readonly<Record<string, string>> | undefined,
  name: string,
): string | undefined => {
  if (!headers) return undefined;
  const want = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === want) {
      const trimmed = value.trim();
      return trimmed || undefined;
    }
  }
  return undefined;
};
const intHeader = (
  headers: Readonly<Record<string, string>> | undefined,
  name: string,
): number | undefined => {
  const raw = header(headers, name);
  if (raw === undefined) return undefined;
  if (!/^[+-]?\d+$/u.test(raw)) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
};
const parseResetTime = (value: string | undefined, ctx: ProviderContext): string | undefined => {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (Number.isFinite(Date.parse(trimmed))) return ctx.date.iso(trimmed);
  let seconds = 0;
  for (const match of trimmed.matchAll(/(\d+)([dhms])/gu)) {
    const amount = Number(match[1]);
    if (match[2] === "d") seconds += amount * 86_400;
    else if (match[2] === "h") seconds += amount * 3_600;
    else if (match[2] === "m") seconds += amount * 60;
    else seconds += amount;
  }
  if (seconds > 0) return ctx.date.unixMillis(ctx.date.nowMillis() + seconds * 1_000);
  const numeric = Number(trimmed);
  return Number.isFinite(numeric)
    ? ctx.date.unixMillis(ctx.date.nowMillis() + numeric * 1_000)
    : undefined;
};

const rateWindow = (
  quotas: readonly Quota[],
  levels: ReadonlySet<string>,
  minutes: number,
): RateWindow | undefined => {
  const quota = quotas.find((entry) => levels.has(entry.level.toLowerCase()));
  if (!quota) return undefined;
  return {
    usedPercent: clamp(quota.percent),
    windowMinutes: minutes,
    ...(quota.resetsAt === undefined ? {} : { resetsAt: quota.resetsAt }),
  };
};

const extraPlanWindows = (quotas: readonly Quota[]): NamedWindow[] => {
  const extras: NamedWindow[] = [];
  for (const plan of [
    { prefix: "agent_", id: "doubao-agent" },
    { prefix: "coding_team_", id: "doubao-coding-team" },
    { prefix: "agent_team_", id: "doubao-agent-team" },
  ] as const) {
    const primary = rateWindow(
      quotas,
      new Set([
        `${plan.prefix}session`,
        `${plan.prefix}5-hour`,
        `${plan.prefix}five_hour`,
        `${plan.prefix}5h`,
      ]),
      5 * 60,
    );
    const secondary = rateWindow(
      quotas,
      new Set([`${plan.prefix}weekly`, `${plan.prefix}week`]),
      7 * 24 * 60,
    );
    const tertiary = rateWindow(
      quotas,
      new Set([`${plan.prefix}monthly`, `${plan.prefix}month`]),
      30 * 24 * 60,
    );
    if (primary) extras.push({ id: `${plan.id}-session`, title: "5-hour", window: primary });
    if (secondary) extras.push({ id: `${plan.id}-weekly`, title: "Weekly", window: secondary });
    if (tertiary) extras.push({ id: `${plan.id}-monthly`, title: "Monthly", window: tertiary });
  }
  return extras;
};

export const doubaoPlanSnapshot = (usage: PlanUsage): ProviderSnapshot => {
  const primary = rateWindow(
    usage.quotas,
    new Set(["session", "5-hour", "five_hour", "5h"]),
    5 * 60,
  );
  const secondary = rateWindow(usage.quotas, new Set(["weekly", "week"]), 7 * 24 * 60);
  const tertiary = rateWindow(usage.quotas, new Set(["monthly", "month"]), 30 * 24 * 60);
  const extraRateWindows = extraPlanWindows(usage.quotas);
  return {
    ...(primary === undefined ? {} : { primary }),
    ...(secondary === undefined ? {} : { secondary }),
    ...(tertiary === undefined ? {} : { tertiary }),
    ...(extraRateWindows.length === 0 ? {} : { extraRateWindows }),
    identity: usage.status ? { loginMethod: usage.status } : {},
  };
};

const arkSnapshot = (probe: ArkProbe): ProviderSnapshot => {
  if (probe.limit > 0 && probe.reliable) {
    const used = Math.max(0, probe.limit - probe.remaining);
    return {
      primary: {
        usedPercent: clamp((used / probe.limit) * 100),
        ...(probe.resetTime === undefined ? {} : { resetsAt: probe.resetTime }),
        resetDescription: `${used}/${probe.limit} requests`,
      },
      identity: {},
    };
  }
  if (probe.valid) return { identity: {} };
  return {
    primary: {
      usedPercent: 0,
      ...(probe.resetTime === undefined ? {} : { resetsAt: probe.resetTime }),
      resetDescription: "No usage data",
    },
    identity: {},
  };
};

const decodeCodingPlanUsage = (ctx: ProviderContext, json: unknown): PlanUsage => {
  const result = object(object(json)?.Result);
  if (!result) throw ctx.fail.parseFailure("Failed to parse Doubao response: Result is missing.");
  const rawQuotas = result.QuotaUsage;
  if (rawQuotas !== undefined && rawQuotas !== null && !Array.isArray(rawQuotas)) {
    throw ctx.fail.parseFailure("Failed to parse Doubao response: QuotaUsage must be an array.");
  }
  const quotas: Quota[] = [];
  for (const raw of Array.isArray(rawQuotas) ? rawQuotas : []) {
    const quota = object(raw);
    const level = string(quota?.Level);
    const percent = number(quota?.Percent);
    if (level === undefined || percent === undefined) {
      throw ctx.fail.parseFailure(
        "Failed to parse Doubao response: quota is missing Level or Percent.",
      );
    }
    const resetsAt = epochSeconds(quota?.ResetTimestamp, ctx);
    quotas.push({ level, percent, ...(resetsAt === undefined ? {} : { resetsAt }) });
  }
  const updateTime = epochSeconds(result.UpdateTimestamp, ctx);
  const status = string(result.Status);
  return {
    ...(status === undefined ? {} : { status }),
    ...(updateTime === undefined ? {} : { updateTime }),
    quotas,
  };
};

const appendAgentWindow = (
  ctx: ProviderContext,
  quotas: Quota[],
  raw: unknown,
  level: string,
): void => {
  const window = object(raw);
  const quota = number(window?.Quota);
  const used = number(window?.Used);
  if (!window || quota === undefined || quota <= 0 || used === undefined) return;
  const resetsAt = epochMillis(window.ResetTime, ctx);
  quotas.push({
    level,
    percent: clamp((used / quota) * 100),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  });
};

const decodeAgentPlanUsage = (ctx: ProviderContext, json: unknown): PlanUsage => {
  const result = object(object(json)?.Result);
  if (!result) throw ctx.fail.parseFailure("Failed to parse Doubao response: Result is missing.");
  const quotas: Quota[] = [];
  appendAgentWindow(ctx, quotas, result.AFPFiveHour, "agent_5h");
  appendAgentWindow(ctx, quotas, result.AFPWeekly, "agent_weekly");
  appendAgentWindow(ctx, quotas, result.AFPMonthly, "agent_monthly");
  return { quotas };
};

const signedRequest = async (
  ctx: ProviderContext,
  credentials: Credentials,
  url: string,
): Promise<ProviderJSONResponse> => {
  const headers = await signDoubaoVolcengineRequest({
    url,
    accessKeyID: credentials.accessKeyID,
    secretAccessKey: credentials.secretAccessKey,
    region: credentials.region,
    date: ctx.date.now(),
  });
  const response = await postJSON(ctx, url, { method: "POST", headers, timeoutSeconds: 15 });
  if (response.status !== 200) {
    throw new DoubaoApiError(
      response.status,
      apiErrorSummary(response.status, response.json, response.bodyText),
    );
  }
  return response;
};

const fetchAgentPlanUsage = async (
  ctx: ProviderContext,
  credentials: Credentials,
): Promise<PlanUsage> =>
  decodeAgentPlanUsage(ctx, (await signedRequest(ctx, credentials, agentPlanURL)).json);

const mergePlanUsage = (coding: PlanUsage, agent: PlanUsage | undefined): PlanUsage => {
  if (coding.quotas.length === 0 && agent && agent.quotas.length > 0) return agent;
  if (agent && agent.quotas.length > 0) {
    return {
      ...(coding.status === undefined ? {} : { status: coding.status }),
      ...((coding.updateTime ?? agent.updateTime)
        ? { updateTime: coding.updateTime ?? agent.updateTime }
        : {}),
      quotas: [...coding.quotas, ...agent.quotas],
    };
  }
  return coding;
};

const isAgentPlanAbsence = (error: unknown): boolean =>
  error instanceof DoubaoApiError && (error.status === 403 || error.status === 404);

const fetchCodingPlanUsage = async (
  ctx: ProviderContext,
  credentials: Credentials,
): Promise<ProviderSnapshot> => {
  const coding = decodeCodingPlanUsage(
    ctx,
    (await signedRequest(ctx, credentials, codingPlanURL)).json,
  );
  let agent: PlanUsage | undefined;
  try {
    agent = await fetchAgentPlanUsage(ctx, credentials);
  } catch (error) {
    if (cancelled(error)) throw error;
    if (isAgentPlanAbsence(error) || coding.quotas.length > 0) agent = undefined;
    else throw error;
  }
  return doubaoPlanSnapshot(mergePlanUsage(coding, agent));
};

const probeArk = async (ctx: ProviderContext, apiKey: string, model: string): Promise<ArkProbe> => {
  const response = await postJSON(ctx, arkProbeURL, {
    method: "POST",
    timeoutSeconds: 15,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: { model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] },
  });
  if (response.status !== 200 && response.status !== 429) {
    throw new DoubaoApiError(
      response.status,
      apiErrorSummary(response.status, response.json, response.bodyText),
    );
  }
  const remaining = intHeader(response.headers, "x-ratelimit-remaining-requests");
  const limit = intHeader(response.headers, "x-ratelimit-limit-requests");
  const resetTime = parseResetTime(header(response.headers, "x-ratelimit-reset-requests"), ctx);
  const usage = object(object(response.json)?.usage);
  const totalTokens =
    remaining === undefined && limit === undefined ? number(usage?.total_tokens) : undefined;
  return {
    remaining: remaining ?? 0,
    limit: limit ?? 0,
    ...(resetTime === undefined ? {} : { resetTime }),
    valid: true,
    reliable:
      response.status === 429
        ? limit !== undefined
        : limit !== undefined && remaining !== undefined,
    status: response.status,
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
};

const ambiguousZero = (probe: ArkProbe): boolean =>
  probe.status === 200 && probe.reliable && probe.limit > 0 && probe.remaining === 0;

const confirmAmbiguousZero = async (
  ctx: ProviderContext,
  apiKey: string,
  model: string,
  initial: ArkProbe,
): Promise<ArkProbe> => {
  try {
    const confirmation = await probeArk(ctx, apiKey, model);
    if (confirmation.status === 429) return confirmation.reliable ? confirmation : initial;
    if (!ambiguousZero(confirmation)) return confirmation;
    return { ...confirmation, reliable: false };
  } catch (error) {
    if (cancelled(error)) throw error;
    return initial;
  }
};

const fetchArkUsage = async (ctx: ProviderContext, apiKey: string): Promise<ProviderSnapshot> => {
  let lastError: unknown;
  for (const model of probeModels) {
    try {
      const probe = await probeArk(ctx, apiKey, model);
      const resolved = ambiguousZero(probe)
        ? await confirmAmbiguousZero(ctx, apiKey, model, probe)
        : probe;
      return arkSnapshot(resolved);
    } catch (error) {
      if (cancelled(error)) throw error;
      if (error instanceof DoubaoApiError && (error.status === 404 || error.status === 403)) {
        lastError = error;
        continue;
      }
      throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new DoubaoApiError(0, "All probe models failed");
};

const fetchApiUsage = async (ctx: ProviderContext): Promise<ProviderSnapshot> => {
  const credentials = codingPlanCredentials(ctx);
  const apiKey = arkApiKey(ctx);
  let signedError: unknown;
  if (credentials) {
    try {
      return await fetchCodingPlanUsage(ctx, credentials);
    } catch (error) {
      if (cancelled(error)) throw error;
      signedError = error;
    }
  }
  if (!apiKey) {
    if (signedError instanceof Error) throw signedError;
    throw ctx.fail.missingCredential("Missing Doubao API key (ARK_API_KEY).");
  }
  return fetchArkUsage(ctx, apiKey);
};

const definition: ProviderDefinition = {
  id: "doubao",
  name: "Doubao",
  endpoints: ["https://ark.cn-beijing.volces.com", "https://open.volcengineapi.com"],
  settings: [
    { key: "ARK_API_KEY", title: "API key", type: "secure" },
    { key: "VOLCENGINE_API_KEY", title: "Volcengine API key", type: "secure" },
    { key: "DOUBAO_API_KEY", title: "Doubao API key", type: "secure" },
    { key: "VOLCENGINE_ACCESS_KEY_ID", title: "Access key ID", type: "secure" },
    { key: "VOLCENGINE_ACCESS_KEY", title: "Access key ID alias", type: "secure" },
    { key: "VOLC_ACCESSKEY", title: "Volcengine access key alias", type: "secure" },
    { key: "DOUBAO_ACCESS_KEY_ID", title: "Doubao access key ID", type: "secure" },
    { key: "VOLCENGINE_SECRET_ACCESS_KEY", title: "Secret access key", type: "secure" },
    { key: "VOLCENGINE_SECRET_KEY", title: "Secret key alias", type: "secure" },
    { key: "VOLCENGINE_ACCESS_KEY_SECRET", title: "Access key secret alias", type: "secure" },
    { key: "VOLC_SECRETKEY", title: "Volcengine secret alias", type: "secure" },
    { key: "DOUBAO_SECRET_ACCESS_KEY", title: "Doubao secret access key", type: "secure" },
    { key: "ARK_REGION", title: "Region", type: "plain" },
    { key: "VOLCENGINE_REGION", title: "Volcengine region", type: "plain" },
    { key: "VOLCENGINE_REGION_ID", title: "Volcengine region ID", type: "plain" },
    { key: "VOLC_REGION", title: "Volcengine region alias", type: "plain" },
    { key: "DOUBAO_REGION", title: "Doubao region", type: "plain" },
  ],
  fetchUsage: fetchApiUsage,
};

const strategy: ProviderStrategy = {
  id: "doubao.api",
  kind: "api",
  fetchUsage: definition.fetchUsage,
};

export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const doubao: FirstPartyProvider = { ...strategy, descriptor };
