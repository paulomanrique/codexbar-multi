import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { number, object, status, string } from "./_http.ts";
import { normalizeMiniMaxCookieCredential } from "./minimax-credential.ts";
import {
  looksMiniMaxHTMLSignedOut,
  parseMiniMaxHTML,
  type MiniMaxHTMLTextFallback,
} from "./minimax-html.ts";

type Region = "global" | "cn";
type Service = {
  readonly name: string;
  readonly used: number;
  readonly limit: number;
  readonly percent: number;
  readonly resetsAt?: string;
  readonly windowMinutes?: number;
  readonly label: string;
};

const region = (ctx: ProviderContext): Region =>
  ctx.settings.get("MINIMAX_API_REGION")?.trim() === "cn" ? "cn" : "global";
const host = (region: Region) => (region === "cn" ? "api.minimaxi.com" : "api.minimax.io");
const platformHost = (region: Region) =>
  region === "cn" ? "platform.minimaxi.com" : "platform.minimax.io";
const webFallbackHost = (region: Region) =>
  region === "cn" ? "www.minimaxi.com" : "www.minimax.io";
const apiURL = (region: Region, path: string) => `https://${host(region)}${path}`;
const miniMaxUserAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

const cleanToken = (raw: string | undefined): string | undefined => {
  let value = raw?.trim();
  if (!value) return undefined;
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1).trim();
  }
  if (value.toLowerCase().startsWith("bearer ")) value = value.slice(7).trim();
  return value || undefined;
};
const apiToken = (ctx: ProviderContext): string | undefined =>
  cleanToken(
    ctx.settings.getSecret("MINIMAX_CODING_API_KEY") ?? ctx.settings.get("MINIMAX_CODING_API_KEY"),
  ) ??
  cleanToken(ctx.settings.getSecret("MINIMAX_API_KEY") ?? ctx.settings.get("MINIMAX_API_KEY")) ??
  cleanToken(ctx.settings.getSecret("MINIMAX_API_TOKEN") ?? ctx.settings.get("MINIMAX_API_TOKEN"));
const apiTokenKind = (value: string): "coding-plan" | "standard" | "unknown" =>
  value.toLowerCase().startsWith("sk-cp-")
    ? "coding-plan"
    : value.toLowerCase().startsWith("sk-api-")
      ? "standard"
      : "unknown";

const positive = (value: unknown): number => Math.max(0, number(value) ?? 0);
const payloadData = (root: Record<string, unknown>): Record<string, unknown> =>
  object(root.data) ?? root;
const failureKind = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "kind" in error && typeof error.kind === "string"
    ? error.kind
    : error instanceof Error
      ? /^([a-z]+(?:-[a-z]+)*):/u.exec(error.message)?.[1]
      : undefined;
const failureMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
const isAbort = (error: unknown): boolean => error instanceof Error && error.name === "AbortError";
const isAuthenticationFailure = (error: unknown): boolean =>
  failureKind(error) === "authentication-expired";
const isEndpointFallbackFailure = (error: unknown): boolean => {
  const kind = failureKind(error);
  return (
    kind === "authentication-expired" ||
    kind === "network-failure" ||
    kind === "parse-failure" ||
    (kind === "api-failure" && /HTTP (?:404|405)\b/u.test(failureMessage(error)))
  );
};
const timestamp = (ctx: ProviderContext, value: unknown): string | undefined => {
  const raw = number(value);
  if (raw === undefined || raw <= 0) return undefined;
  return ctx.date.unixMillis(raw > 10_000_000_000 ? raw : raw * 1_000);
};
const duration = (start: unknown, end: unknown): number | undefined => {
  const a = number(start);
  const b = number(end);
  if (a === undefined || b === undefined || b <= a) return undefined;
  const milliseconds = b > 10_000_000_000 ? b - a : (b - a) * 1_000;
  const minutes = Math.round(milliseconds / 60_000);
  return minutes > 0 && Number.isSafeInteger(minutes) ? minutes : undefined;
};

const services = (ctx: ProviderContext, root: Record<string, unknown>): readonly Service[] => {
  const data = payloadData(root);
  const multiServiceRows = Array.isArray(data.services) ? data.services : [];
  if (multiServiceRows.length > 0) {
    const multiServices: Service[] = [];
    for (const raw of multiServiceRows) {
      const row = object(raw);
      if (!row) continue;
      const name = string(row.service_type);
      const window = string(row.window_type);
      const used = number(row.usage);
      const limit = number(row.limit);
      if (!name || !window || used === undefined || limit === undefined || limit <= 0) continue;
      const percent = number(row.percent) ?? ctx.pct(used, limit);
      multiServices.push({
        name,
        used: Math.max(0, used),
        limit,
        percent: Math.max(0, Math.min(100, percent)),
        label: `${name} · ${window}`,
      });
    }
    if (multiServices.length > 0) return multiServices;
  }

  const rows = Array.isArray(data.model_remains) ? data.model_remains : [];
  const result: Service[] = [];
  for (const raw of rows) {
    const row = object(raw);
    if (!row) continue;
    const name = string(row.model_name) ?? "General";
    const intervalTotal = positive(row.current_interval_total_count);
    const intervalRemainingCount = positive(row.current_interval_usage_count);
    const intervalRemaining = number(row.current_interval_remaining_percent);
    const intervalLimit = intervalTotal || (intervalRemaining === undefined ? 0 : 100);
    const intervalUsed = intervalTotal
      ? Math.max(0, intervalTotal - intervalRemainingCount)
      : Math.max(0, 100 - (intervalRemaining ?? 100));
    if (intervalLimit > 0 || intervalRemaining !== undefined) {
      const resetsAt = timestamp(ctx, row.end_time);
      const windowMinutes = duration(row.start_time, row.end_time);
      result.push({
        name,
        used: intervalUsed,
        limit: intervalLimit,
        percent: intervalLimit > 0 ? ctx.pct(intervalUsed, intervalLimit) : intervalUsed,
        ...(resetsAt ? { resetsAt } : {}),
        ...(windowMinutes ? { windowMinutes } : {}),
        label: `${name} · 5 hours`,
      });
    }
    const weeklyTotal = positive(row.current_weekly_total_count);
    const weeklyRemainingCount = positive(row.current_weekly_usage_count);
    const weeklyRemaining = number(row.current_weekly_remaining_percent);
    const weeklyLimit = weeklyTotal || (weeklyRemaining === undefined ? 0 : 100);
    const weeklyUsed = weeklyTotal
      ? Math.max(0, weeklyTotal - weeklyRemainingCount)
      : Math.max(0, 100 - (weeklyRemaining ?? 100));
    if (weeklyLimit > 0 || weeklyRemaining !== undefined) {
      const resetsAt = timestamp(ctx, row.weekly_end_time);
      const windowMinutes = duration(row.weekly_start_time, row.weekly_end_time);
      result.push({
        name,
        used: weeklyUsed,
        limit: weeklyLimit,
        percent: weeklyLimit > 0 ? ctx.pct(weeklyUsed, weeklyLimit) : weeklyUsed,
        ...(resetsAt ? { resetsAt } : {}),
        ...(windowMinutes ? { windowMinutes } : { windowMinutes: 10_080 }),
        label: `${name} · Weekly`,
      });
    }
  }
  return result;
};

const snapshot = (ctx: ProviderContext, root: Record<string, unknown>) => {
  const data = payloadData(root);
  const baseResponse = object(data.base_resp) ?? object(root.base_resp);
  const code = number(baseResponse?.status_code);
  if (code !== undefined && code !== 0) {
    const message = string(baseResponse?.status_msg) ?? `status_code ${code}`;
    const normalized = message.toLowerCase();
    if (
      code === 1004 ||
      normalized.includes("invalid api key") ||
      normalized.includes("cookie") ||
      normalized.includes("log in") ||
      normalized.includes("login")
    ) {
      throw ctx.fail.authenticationExpired("MiniMax credentials expired.");
    }
    throw ctx.fail.apiFailure(`MiniMax API returned ${message}.`);
  }
  const lanes = services(ctx, root);
  if (lanes.length === 0) throw ctx.fail.parseFailure("MiniMax response has no model remains.");
  const primaryIndex = lanes.findIndex((lane) => lane.name.trim().toLowerCase() === "general");
  const ordered =
    primaryIndex > 0
      ? [lanes[primaryIndex] as Service, ...lanes.filter((_, index) => index !== primaryIndex)]
      : lanes;
  const windows = ordered.slice(0, 3).map((lane) => ({
    usedPercent: lane.percent,
    ...(lane.windowMinutes ? { windowMinutes: lane.windowMinutes } : {}),
    ...(lane.resetsAt ? { resetsAt: lane.resetsAt } : {}),
    resetDescription: `${ctx.format.number(lane.used)} / ${ctx.format.number(lane.limit)} ${lane.label}`,
  }));
  const plan =
    string(data.current_subscribe_title) ??
    string(data.plan_name) ??
    string(data.combo_title) ??
    string(data.current_plan_title) ??
    string(object(data.current_combo_card)?.title) ??
    string(data.subscribe_title);
  const pointsBalance =
    number(data.points_balance) ??
    number(data.point_balance) ??
    number(data.credits_balance) ??
    number(data.credit_balance) ??
    number(data.balance);
  return {
    ...(windows[0] ? { primary: windows[0] } : {}),
    ...(windows[1] ? { secondary: windows[1] } : {}),
    ...(windows[2] ? { tertiary: windows[2] } : {}),
    details: [
      {
        title: "Quota services",
        rows: ordered.slice(0, 16).map((lane) => ({
          label: lane.label,
          value: `${ctx.format.number(lane.used)} / ${ctx.format.number(lane.limit)}`,
          secondaryValue: `${Math.round(lane.percent)}% used`,
        })),
      },
    ],
    ...(pointsBalance !== undefined && pointsBalance >= 0
      ? {
          providerCost: {
            used: pointsBalance,
            limit: 0,
            currencyCode: "Points",
            period: "MiniMax points balance",
          },
        }
      : {}),
    identity: plan ? { loginMethod: plan } : {},
  };
};

const tryAPIRegion = async (ctx: ProviderContext, token: string, currentRegion: Region) => {
  const paths = ["/v1/token_plan/remains", "/v1/api/openplatform/coding_plan/remains"] as const;
  let firstCredentialFailure = false;
  let lastError: unknown;
  for (const [index, path] of paths.entries()) {
    try {
      const response = await ctx.http.getJSON(apiURL(currentRegion, path), {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          "MM-API-Source": "CodexBar",
        },
      });
      const body = object(response.json);
      const data = body ? payloadData(body) : undefined;
      const code = number(
        object(data?.base_resp)?.status_code ?? object(body?.base_resp)?.status_code,
      );
      if (response.status === 401 || response.status === 403 || code === 1004) {
        throw ctx.fail.authenticationExpired("MiniMax rejected the API token.");
      }
      status(ctx, "MiniMax", response);
      if (!body) throw ctx.fail.parseFailure("MiniMax response must be an object.");
      return snapshot(ctx, body);
    } catch (error) {
      if (isAbort(error)) throw error;
      lastError = error;
      if (index === 0 && isEndpointFallbackFailure(error)) {
        firstCredentialFailure = isAuthenticationFailure(error);
        continue;
      }
      if (firstCredentialFailure) {
        throw ctx.fail.authenticationExpired("MiniMax rejected the API token.");
      }
      throw error;
    }
  }
  throw lastError ?? ctx.fail.parseFailure("MiniMax API endpoints did not return usage.");
};

const tryAPI = async (ctx: ProviderContext, token: string, requestedRegion: Region) => {
  if (requestedRegion === "cn") return tryAPIRegion(ctx, token, "cn");
  try {
    return await tryAPIRegion(ctx, token, "global");
  } catch (error) {
    if (isAbort(error) || !isAuthenticationFailure(error)) throw error;
    try {
      return await tryAPIRegion(ctx, token, "cn");
    } catch {
      throw error;
    }
  }
};

const webCredential = async (ctx: ProviderContext) => {
  const manualRaw =
    ctx.settings.getSecret("MINIMAX_COOKIE") ??
    ctx.settings.get("MINIMAX_COOKIE") ??
    ctx.settings.getSecret("MINIMAX_COOKIE_HEADER") ??
    ctx.settings.get("MINIMAX_COOKIE_HEADER");
  const manualPresent = Boolean(manualRaw?.trim());
  const manual = normalizeMiniMaxCookieCredential(manualRaw);
  if (manualPresent && manual === undefined) {
    throw ctx.fail.missingCredential("MiniMax manual cookie credential is invalid.");
  }
  const selectedRegion = region(ctx);
  const browserCookie =
    manual === undefined
      ? (await ctx.browser.cookieHeader(platformHost(selectedRegion))).trim()
      : "";
  const browser = normalizeMiniMaxCookieCredential(browserCookie);
  const cookieHeader = manual?.cookieHeader ?? browser?.cookieHeader;
  if (!cookieHeader) {
    throw ctx.fail.missingCredential("MiniMax coding-plan cookie is not configured.");
  }
  const configuredAuthorization = cleanToken(
    ctx.settings.getSecret("MINIMAX_AUTHORIZATION_TOKEN") ??
      ctx.settings.get("MINIMAX_AUTHORIZATION_TOKEN"),
  );
  const configuredGroupID = (
    ctx.settings.getSecret("MINIMAX_GROUP_ID") ?? ctx.settings.get("MINIMAX_GROUP_ID")
  )?.trim();
  const resolvedAPIToken = apiToken(ctx);
  const standardToken =
    resolvedAPIToken && apiTokenKind(resolvedAPIToken) === "standard"
      ? resolvedAPIToken
      : undefined;
  return {
    cookieHeader,
    authorizationToken: configuredAuthorization ?? manual?.authorizationToken ?? standardToken,
    groupId: configuredGroupID || manual?.groupId,
    region: selectedRegion,
  };
};

const webHeaders = (
  currentHost: string,
  selectedRegion: Region,
  credential: Awaited<ReturnType<typeof webCredential>>,
) => {
  const origin = `https://${currentHost}`;
  const refererOrigin = `https://${platformHost(selectedRegion)}`;
  return {
    Cookie: credential.cookieHeader,
    ...(credential.authorizationToken
      ? { Authorization: `Bearer ${credential.authorizationToken}` }
      : {}),
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent": miniMaxUserAgent,
    Origin: origin,
    Referer: `${refererOrigin}/user-center/payment/coding-plan`,
    "X-Requested-With": "XMLHttpRequest",
  };
};

const webPageHeaders = (
  selectedRegion: Region,
  credential: Awaited<ReturnType<typeof webCredential>>,
) => {
  const origin = `https://${platformHost(selectedRegion)}`;
  return {
    Cookie: credential.cookieHeader,
    ...(credential.authorizationToken
      ? { Authorization: `Bearer ${credential.authorizationToken}` }
      : {}),
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent": miniMaxUserAgent,
    Origin: origin,
    Referer: `${origin}/user-center/payment/coding-plan`,
  };
};

const textFallbackSnapshot = (ctx: ProviderContext, fallback: MiniMaxHTMLTextFallback) => {
  const usedPercent = fallback.used_percent ?? 0;
  const resetsAt =
    fallback.resets_at_epoch_ms === undefined
      ? undefined
      : ctx.date.unixMillis(fallback.resets_at_epoch_ms);
  const prompts = fallback.available_prompts;
  const windowMinutes = fallback.window_minutes;
  return {
    primary: {
      usedPercent,
      ...(windowMinutes === undefined ? {} : { windowMinutes }),
      ...(resetsAt === undefined ? {} : { resetsAt }),
      ...(prompts === undefined
        ? {}
        : {
            resetDescription: `${ctx.format.number(prompts)} prompts${
              windowMinutes === undefined ? "" : ` / ${ctx.format.number(windowMinutes / 60)} hours`
            }`,
          }),
    },
    details: [],
    identity: fallback.plan_name ? { loginMethod: fallback.plan_name } : {},
  };
};

const responseContentType = (headers: Readonly<Record<string, string>> | undefined): string => {
  if (!headers) return "";
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "content-type") return value.toLowerCase();
  }
  return "";
};

const fetchWebRemains = async (
  ctx: ProviderContext,
  credential: Awaited<ReturnType<typeof webCredential>>,
) => {
  const query = new URLSearchParams();
  if (credential.groupId) query.set("GroupId", credential.groupId);
  const suffix = query.size > 0 ? `?${query}` : "";
  const hosts = [platformHost(credential.region), webFallbackHost(credential.region)] as const;
  let terminalError: Error | undefined;
  for (const currentHost of hosts) {
    try {
      const response = await ctx.http.getJSON(
        `https://${currentHost}/v1/api/openplatform/coding_plan/remains${suffix}`,
        { headers: webHeaders(currentHost, credential.region, credential) },
      );
      const root = object(response.json);
      const code = number(object(root?.base_resp)?.status_code);
      if (response.status === 401 || response.status === 403 || code === 1004) {
        throw ctx.fail.authenticationExpired("MiniMax coding-plan session expired.");
      }
      status(ctx, "MiniMax", response);
      if (!root) throw ctx.fail.parseFailure("MiniMax response must be an object.");
      return snapshot(ctx, root);
    } catch (error) {
      if (isAbort(error)) throw error;
      terminalError = error instanceof Error ? error : new Error(String(error));
      if (!isEndpointFallbackFailure(error) || isAuthenticationFailure(error)) throw error;
    }
  }
  throw terminalError ?? ctx.fail.apiFailure("MiniMax coding-plan endpoints did not succeed.");
};

const withFallbackPlan = (
  snapshotValue: Record<string, unknown>,
  fallback: MiniMaxHTMLTextFallback,
): Record<string, unknown> => {
  if (!fallback.plan_name) return snapshotValue;
  const identity = object(snapshotValue.identity) ?? {};
  if (string(identity.loginMethod)) return snapshotValue;
  return { ...snapshotValue, identity: { ...identity, loginMethod: fallback.plan_name } };
};

const webUsage = async (ctx: ProviderContext) => {
  const credential = await webCredential(ctx);
  const pageURL = `https://${platformHost(credential.region)}/user-center/payment/coding-plan?cycle_type=3`;
  const pageResponse = await ctx.http.get(pageURL, {
    headers: webPageHeaders(credential.region, credential),
  });
  if (pageResponse.status === 401 || pageResponse.status === 403) {
    throw ctx.fail.authenticationExpired("MiniMax coding-plan session expired.");
  }
  status(ctx, "MiniMax", pageResponse);

  if (responseContentType(pageResponse.headers).includes("application/json")) {
    let parsedJSON: unknown;
    try {
      parsedJSON = JSON.parse(pageResponse.bodyText);
    } catch {
      throw ctx.fail.parseFailure("MiniMax coding-plan response was not valid JSON.");
    }
    const root = object(parsedJSON);
    if (!root) throw ctx.fail.parseFailure("MiniMax response must be an object.");
    return snapshot(ctx, root);
  }
  if (looksMiniMaxHTMLSignedOut(pageResponse.bodyText)) {
    throw ctx.fail.authenticationExpired("MiniMax coding-plan session expired.");
  }
  const parsed = parseMiniMaxHTML(pageResponse.bodyText, { now: ctx.date.now() });
  if (parsed?.source === "next-data") return snapshot(ctx, parsed.payload);
  if (parsed?.source === "text") {
    try {
      return withFallbackPlan(await fetchWebRemains(ctx, credential), parsed.fallback);
    } catch (error) {
      if (isAbort(error) || isAuthenticationFailure(error)) throw error;
      return textFallbackSnapshot(ctx, parsed.fallback);
    }
  }
  return fetchWebRemains(ctx, credential);
};

const definition: ProviderDefinition = {
  id: "minimax",
  name: "MiniMax",
  endpoints: [
    "https://api.minimax.io",
    "https://api.minimaxi.com",
    "https://platform.minimax.io",
    "https://platform.minimaxi.com",
    "https://www.minimax.io",
    "https://www.minimaxi.com",
  ],
  auth: { type: "provider-managed", secret: "MINIMAX_API_KEY" },
  settings: [
    { key: "MINIMAX_CODING_API_KEY", title: "Coding Plan API key", type: "secure" },
    { key: "MINIMAX_API_KEY", title: "API key", type: "secure" },
    { key: "MINIMAX_API_TOKEN", title: "Legacy API token", type: "secure" },
    { key: "MINIMAX_API_REGION", title: "API region", type: "plain" },
    { key: "MINIMAX_COOKIE", title: "Cookie", type: "secure" },
    { key: "MINIMAX_COOKIE_HEADER", title: "Cookie header", type: "secure" },
    { key: "MINIMAX_AUTHORIZATION_TOKEN", title: "Web authorization token", type: "secure" },
    { key: "MINIMAX_GROUP_ID", title: "Group ID", type: "secure" },
  ],
  capabilities: ["browser-cookies"],
  cookieDomains: ["platform.minimax.io", "platform.minimaxi.com"],
  fetchUsage: async (ctx: ProviderContext) => {
    const token = apiToken(ctx);
    if (token) return tryAPI(ctx, token, region(ctx));
    return webUsage(ctx);
  },
};

const legacyStrategy: ProviderStrategy = {
  id: "minimax.api",
  kind: "api",
  fetchUsage: definition.fetchUsage,
};
const apiStrategy: ProviderStrategy = {
  id: "minimax.api",
  kind: "api",
  autoRequiresAnySecret: ["MINIMAX_CODING_API_KEY", "MINIMAX_API_KEY", "MINIMAX_API_TOKEN"],
  fallbackOn: ["authentication-expired", "missing-credential"],
  fallbackWhen: (error) => error.kind === "api-failure" && /HTTP 404\b/u.test(error.message),
  fetchUsage: async (ctx) => {
    const token = apiToken(ctx);
    if (!token) throw ctx.fail.missingCredential("MiniMax API token is not configured.");
    if (apiTokenKind(token) === "standard") {
      throw ctx.fail.missingCredential("MiniMax standard API keys use the coding-plan web flow.");
    }
    return tryAPI(ctx, token, region(ctx));
  },
};
const webStrategy: ProviderStrategy = {
  id: "minimax.web",
  kind: "web",
  fetchUsage: webUsage,
};
const strategies = [apiStrategy, webStrategy] as const;
export const descriptor: ProviderDescriptor = {
  ...definition,
  status: "partial",
  strategy: legacyStrategy,
  strategies,
};
export const minimax: FirstPartyProvider = { ...legacyStrategy, descriptor, strategies };
