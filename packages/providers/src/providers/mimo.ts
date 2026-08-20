import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { number, object, status, string } from "./_http.ts";

const clean = (value: string | undefined) => value?.trim() || undefined;
const cookieValid = (header: string) =>
  /(?:^|;\s*)api-platform_serviceToken=/iu.test(header) && /(?:^|;\s*)userId=/iu.test(header);
const baseURL = (ctx: ProviderContext) => {
  const candidate = clean(ctx.settings.get("MIMO_API_URL"));
  if (!candidate) return "https://platform.xiaomimimo.com/api/v1";
  const url = new URL(candidate.includes("://") ? candidate : `https://${candidate}`);
  if (url.protocol !== "https:") throw ctx.fail.apiFailure("MIMO_API_URL must use HTTPS.");
  return url.href.replace(/\/$/u, "");
};
const formatMoney = (ctx: ProviderContext, amount: number, currency: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
const date = (ctx: ProviderContext, value: unknown) => {
  const text = string(value);
  return text && Number.isFinite(Date.parse(`${text.replace(" ", "T")}Z`))
    ? ctx.date.iso(`${text.replace(" ", "T")}Z`)
    : undefined;
};
const header = (cookie: string) => ({
  Cookie: cookie,
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "x-timeZone": "UTC+01:00",
  Origin: "https://platform.xiaomimimo.com",
  Referer: "https://platform.xiaomimimo.com/#/console/balance",
});
const root = (ctx: ProviderContext, value: unknown, title: string) => {
  const parsed = object(value);
  if (!parsed) throw ctx.fail.parseFailure(`${title} response must be an object.`);
  const code = number(parsed.code);
  if (code === 401) throw ctx.fail.authenticationExpired("Xiaomi MiMo login is required.");
  if (code === 403) throw ctx.fail.permissionDenied("Xiaomi MiMo session expired.");
  if (code !== 0)
    throw ctx.fail.parseFailure(
      string(parsed.message) ?? `${title} returned code ${code ?? "unknown"}.`,
    );
  return parsed;
};
const cookie = async (ctx: ProviderContext) =>
  clean(ctx.settings.getSecret("MIMO_COOKIE")) ??
  clean(ctx.settings.get("MIMO_COOKIE")) ??
  clean(await ctx.browser.cookieHeader("platform.xiaomimimo.com"));
const definition: ProviderDefinition = {
  id: "mimo",
  name: "Xiaomi MiMo",
  endpoints: [
    { setting: "MIMO_API_URL", policy: "https", default: "https://platform.xiaomimimo.com/api/v1" },
  ],
  settings: [
    { key: "MIMO_COOKIE", title: "Cookie header", type: "secure" },
    { key: "MIMO_API_URL", title: "API URL", type: "plain" },
  ],
  capabilities: ["browser-cookies"],
  cookieDomains: ["platform.xiaomimimo.com", "xiaomimimo.com"],
  fetchUsage: async (ctx) => {
    const session = await cookie(ctx);
    if (!session || !cookieValid(session))
      throw ctx.fail.missingCredential(
        "Xiaomi MiMo requires api-platform_serviceToken and userId cookies.",
      );
    const base = baseURL(ctx);
    const options = { headers: header(session) };
    const balanceResponse = await ctx.http.getJSON(`${base}/balance`, options);
    status(ctx, "Xiaomi MiMo", balanceResponse);
    const balanceRoot = root(ctx, balanceResponse.json as unknown, "Balance");
    const balanceData = object(balanceRoot.data);
    const balance = number(balanceData?.balance);
    const currency = string(balanceData?.currency);
    if (balance === undefined || !currency)
      throw ctx.fail.parseFailure("Xiaomi MiMo balance response is incomplete.");
    const [detailResponse, usageResponse] = await Promise.all([
      ctx.http.getJSON(`${base}/tokenPlan/detail`, options).catch(() => undefined),
      ctx.http.getJSON(`${base}/tokenPlan/usage`, options).catch(() => undefined),
    ]);
    const detail =
      detailResponse && detailResponse.status >= 200 && detailResponse.status < 300
        ? object(detailResponse.json)?.data
        : undefined;
    const usage =
      usageResponse && usageResponse.status >= 200 && usageResponse.status < 300
        ? object(usageResponse.json)?.data
        : undefined;
    const detailData = object(detail);
    const monthUsage = object(object(usage)?.monthUsage);
    const item = Array.isArray(monthUsage?.items) ? object(monthUsage?.items[0]) : undefined;
    const used = number(item?.used) ?? 0;
    const limit = number(item?.limit) ?? 0;
    const percentage = number(item?.percent) ?? number(monthUsage?.percent) ?? 0;
    const cash = number(balanceData?.cashBalance);
    const gift = number(balanceData?.giftBalance);
    const balanceText =
      cash === undefined || gift === undefined
        ? formatMoney(ctx, balance, currency)
        : `${formatMoney(ctx, balance, currency)} (Paid: ${formatMoney(ctx, cash, currency)} / Granted: ${formatMoney(ctx, gift, currency)})`;
    const plan = string(detailData?.planCode);
    const reset = date(ctx, detailData?.currentPeriodEnd);
    return {
      ...(limit > 0
        ? {
            primary: {
              usedPercent: Math.max(0, Math.min(100, percentage * 100)),
              ...(reset ? { resetsAt: reset, windowMinutes: 43_200 } : {}),
              resetDescription: `${ctx.format.number(used)} / ${ctx.format.number(limit)} Credits`,
            },
          }
        : {}),
      details: [{ title: "Credits", rows: [{ label: "Balance", value: balanceText }] }],
      identity: plan ? { loginMethod: plan.replace(/^./u, (letter) => letter.toUpperCase()) } : {},
    };
  },
};
const strategy: ProviderStrategy = {
  id: "mimo.web",
  kind: "web",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const mimo: FirstPartyProvider = { ...strategy, descriptor };
