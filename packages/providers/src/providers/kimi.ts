import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { number, object, status, string } from "./_http.ts";

type Dict = Record<string, unknown>;
type Detail = {
  readonly limit: number;
  readonly used?: number;
  readonly remaining?: number;
  readonly resetTime?: string;
};

const trim = (value: string | undefined): string | undefined =>
  value?.trim().replace(/^['"]|['"]$/gu, "") || undefined;
const apiKey = (ctx: ProviderContext): string | undefined =>
  trim(ctx.settings.getSecret("KIMI_CODE_API_KEY") ?? ctx.settings.get("KIMI_CODE_API_KEY"));
const webToken = (ctx: ProviderContext, cookieHeader: string): string | undefined => {
  const configured = trim(
    ctx.settings.getSecret("KIMI_AUTH_TOKEN") ?? ctx.settings.get("KIMI_AUTH_TOKEN"),
  );
  const raw =
    configured ??
    trim(ctx.settings.getSecret("KIMI_MANUAL_COOKIE") ?? ctx.settings.get("KIMI_MANUAL_COOKIE")) ??
    cookieHeader;
  if (!raw) return undefined;
  const match = /(?:^|[;\s])kimi-auth\s*[=:]\s*([A-Za-z0-9._\-+=/]+)/iu.exec(raw);
  if (match?.[1]) return match[1];
  return raw.startsWith("eyJ") && raw.split(".").length === 3 ? raw : undefined;
};
const jsonPayload = (token: string): Dict | undefined => {
  const part = token.split(".")[1];
  if (!part) return undefined;
  try {
    const padded = part
      .replace(/-/gu, "+")
      .replace(/_/gu, "/")
      .padEnd(Math.ceil(part.length / 4) * 4, "=");
    return object(JSON.parse(atob(padded)) as unknown);
  } catch {
    return undefined;
  }
};
const headers = (ctx: ProviderContext, token: string) => {
  const session = jsonPayload(token);
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    Cookie: `kimi-auth=${token}`,
    Origin: "https://www.kimi.com",
    Referer: "https://www.kimi.com/code/console",
    Accept: "*/*",
    "connect-protocol-version": "1",
    "x-language": "en-US",
    "x-msh-platform": "web",
    "r-timezone": ctx.env.timeZone ?? "UTC",
    ...(string(session?.device_id)
      ? { "x-msh-device-id": string(session?.device_id) as string }
      : {}),
    ...(string(session?.ssid) ? { "x-msh-session-id": string(session?.ssid) as string } : {}),
    ...(string(session?.sub) ? { "x-traffic-id": string(session?.sub) as string } : {}),
  };
};
const detail = (raw: unknown): Detail | undefined => {
  const source = object(raw);
  if (!source) return undefined;
  const limit = number(source.limit);
  if (limit === undefined || limit <= 0) return undefined;
  const used = number(source.used);
  const remaining = number(source.remaining);
  const resetTime =
    string(source.resetTime) ??
    string(source.resetAt) ??
    string(source.reset_time) ??
    string(source.reset_at);
  return {
    limit,
    ...(used !== undefined && used >= 0 ? { used } : {}),
    ...(remaining !== undefined && remaining >= 0 && remaining <= limit ? { remaining } : {}),
    ...(resetTime ? { resetTime } : {}),
  };
};
const usageWindow = (ctx: ProviderContext, input: Detail, windowMinutes?: number, rate = false) => {
  const used = input.used ?? (input.remaining === undefined ? 0 : input.limit - input.remaining);
  const reliable = input.used !== undefined || input.remaining !== undefined;
  const reset = input.resetTime ? ctx.date.iso(input.resetTime) : undefined;
  const description = rate
    ? `${rate && windowMinutes ? `Rate: ${ctx.format.number(used)}/${ctx.format.number(input.limit)} per ${windowMinutes % 60 === 0 ? `${windowMinutes / 60} hour${windowMinutes === 60 ? "" : "s"}` : `${windowMinutes} minutes`}` : `Rate: ${ctx.format.number(used)}/${ctx.format.number(input.limit)}`}`
    : `${ctx.format.number(used)}/${ctx.format.number(input.limit)} requests`;
  return {
    usedPercent: ctx.pct(used, input.limit),
    ...(reliable && windowMinutes ? { windowMinutes } : {}),
    ...(reset ? { resetsAt: reset } : {}),
    resetDescription: description,
  };
};
const windowMinutes = (raw: unknown): number | undefined => {
  const source = object(raw);
  if (!source) return undefined;
  const duration = number(source.duration);
  const unit = string(source.timeUnit);
  if (!duration || duration <= 0) return undefined;
  switch (unit) {
    case "TIME_UNIT_MINUTE":
      return duration;
    case "TIME_UNIT_HOUR":
      return duration * 60;
    case "TIME_UNIT_DAY":
      return duration * 1_440;
    default:
      return undefined;
  }
};
const subscription = (ctx: ProviderContext, root: Dict, weekly: Record<string, unknown>) => {
  const balance = object(root.subscriptionBalance);
  const codeWeekly = object(root.ratelimitCode7d);
  const extraRateWindows: Record<string, unknown>[] = [];
  const balanceRatio = number(balance?.amountUsedRatio);
  if (
    balanceRatio !== undefined &&
    Number.isFinite(balanceRatio) &&
    (!string(balance?.feature) || string(balance?.feature) === "FEATURE_OMNI") &&
    (!string(balance?.type) || string(balance?.type) === "SUBSCRIPTION")
  ) {
    extraRateWindows.push({
      id: "kimi-monthly",
      title: "Total usage",
      window: {
        usedPercent: Math.max(0, Math.min(100, balanceRatio * 100)),
        windowMinutes: 43_200,
        ...(string(balance?.expireTime)
          ? { resetsAt: ctx.date.iso(string(balance?.expireTime) as string) }
          : {}),
      },
    });
  }
  const codeRatio = number(codeWeekly?.ratio);
  const codeReset = string(codeWeekly?.resetTime);
  if (codeWeekly?.enabled !== false && codeRatio !== undefined && Number.isFinite(codeRatio)) {
    const weeklyPercent = number(weekly.usedPercent);
    const weeklyReset = string(weekly.resetsAt);
    const duplicate =
      weeklyPercent !== undefined &&
      Math.abs(weeklyPercent - codeRatio * 100) <= 1 &&
      weeklyReset &&
      codeReset &&
      Math.abs(Date.parse(weeklyReset) - Date.parse(codeReset)) <= 5 * 60_000;
    if (!duplicate)
      extraRateWindows.push({
        id: "kimi-code-7d",
        title: "Code 7-day",
        window: {
          usedPercent: Math.max(0, Math.min(100, codeRatio * 100)),
          windowMinutes: 10_080,
          ...(codeReset ? { resetsAt: ctx.date.iso(codeReset) } : {}),
        },
      });
  }
  return extraRateWindows;
};
const fetchWeb = async (ctx: ProviderContext, token: string) => {
  const response = await ctx.http.postJSON(
    "https://www.kimi.com/apiv2/kimi.gateway.billing.v1.BillingService/GetUsages",
    { body: { scope: ["FEATURE_CODING"] }, headers: headers(ctx, token) },
  );
  status(ctx, "Kimi", response);
  const root = object(response.json);
  const usages = Array.isArray(root?.usages) ? root.usages : [];
  const coding = usages.map(object).find((entry) => entry?.scope === "FEATURE_CODING");
  const weeklyDetail = detail(coding?.detail);
  if (!weeklyDetail) throw ctx.fail.parseFailure("Kimi FEATURE_CODING usage is missing.");
  const limit = Array.isArray(coding?.limits) ? object(coding?.limits[0]) : undefined;
  const rateDetail = detail(limit?.detail);
  const weekly = usageWindow(ctx, weeklyDetail, 10_080);
  let subscriptionRoot: Dict = {};
  try {
    const stats = await ctx.http.postJSON(
      "https://www.kimi.com/apiv2/kimi.gateway.membership.v2.MembershipService/GetSubscriptionStats",
      { body: {}, headers: headers(ctx, token) },
    );
    if (stats.status === 200) subscriptionRoot = object(stats.json) ?? {};
  } catch {
    // Subscription enrichment is explicitly best-effort in the Swift oracle.
  }
  const extraRateWindows = subscription(ctx, subscriptionRoot, weekly);
  return {
    primary: weekly,
    ...(rateDetail
      ? { secondary: usageWindow(ctx, rateDetail, windowMinutes(limit?.window) ?? 300, true) }
      : {}),
    ...(extraRateWindows.length ? { extraRateWindows } : {}),
  };
};
const fetchAPI = async (ctx: ProviderContext, key: string) => {
  const response = await ctx.http.getJSON("https://api.kimi.com/coding/v1/usages", {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
  });
  status(ctx, "Kimi Code API", response);
  const root = object(response.json);
  const weeklyDetail = detail(root?.usage);
  if (!weeklyDetail) throw ctx.fail.parseFailure("Kimi Code API usage is missing.");
  const limit = Array.isArray(root?.limits) ? object(root?.limits[0]) : undefined;
  const weekly = usageWindow(ctx, weeklyDetail, 10_080);
  return {
    primary: weekly,
    ...(detail(limit?.detail)
      ? {
          secondary: usageWindow(
            ctx,
            detail(limit?.detail) as Detail,
            windowMinutes(limit?.window) ?? 300,
            true,
          ),
        }
      : {}),
    identity: { loginMethod: "Kimi Code API key" },
  };
};

const definition: ProviderDefinition = {
  id: "kimi",
  name: "Kimi Code",
  endpoints: ["https://www.kimi.com", "https://api.kimi.com"],
  settings: [
    { key: "KIMI_AUTH_TOKEN", title: "Kimi auth token", type: "secure" },
    { key: "KIMI_CODE_API_KEY", title: "Kimi Code API key", type: "secure" },
  ],
  capabilities: ["browser-cookies"],
  cookieDomains: ["www.kimi.com"],
  fetchUsage: async (ctx: ProviderContext) => {
    const key = apiKey(ctx);
    if (key) {
      try {
        return await fetchAPI(ctx, key);
      } catch (error) {
        // Auto order is API first, then web. Explicit source choice is resolved by the registry.
        const cookieHeader = await ctx.browser.cookieHeader("www.kimi.com");
        const token = webToken(ctx, cookieHeader);
        if (!token) throw error;
        return fetchWeb(ctx, token);
      }
    }
    const cookieHeader = await ctx.browser.cookieHeader("www.kimi.com");
    const token = webToken(ctx, cookieHeader);
    if (!token)
      throw ctx.fail.missingCredential("Kimi auth token or Kimi Code API key is not configured.");
    return fetchWeb(ctx, token);
  },
};

const strategy: ProviderStrategy = {
  id: "kimi.web",
  kind: "web",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const kimi: FirstPartyProvider = { ...strategy, descriptor };
