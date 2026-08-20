import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { number, object, status, string } from "./_http.ts";
import {
  expandOneConsole,
  findOneConsoleObject,
  findOneConsoleValue,
  oneConsoleDate,
  percentPoints,
} from "./alibabatokenplan.ts";

type Json = Record<string, unknown>;
const dashboardURL = "https://home.qwencloud.com/billing/subscription/token-plan-individual";
const apiBase = "https://cs-data.qwencloud.com";
const userAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/143 Safari/537.36";
const clean = (value: string | undefined): string | undefined => value?.trim() || undefined;
const form = (values: Readonly<Record<string, string>>) => new URLSearchParams(values).toString();
const cookieValue = (header: string, name: string): string | undefined => {
  for (const item of header.split(";")) {
    const [rawName, ...rawValue] = item.trim().split("=");
    if (rawName?.toLowerCase() === name.toLowerCase() && rawValue.length)
      return rawValue.join("=").trim() || undefined;
  }
  return undefined;
};
const format = (ctx: ProviderContext, value: number) =>
  ctx.format.number(value, { maximumFractionDigits: Number.isInteger(value) ? 0 : 2 });
const planName = (value: unknown): string | undefined => {
  const code = string(
    findOneConsoleValue(value, ["specCode", "spec_code", "planName", "plan_name"]),
  )?.toLowerCase();
  if (!code) return undefined;
  return (
    ({ lite: "Lite", standard: "Standard", pro: "Pro", max: "Max" } as Record<string, string>)[
      code
    ] ?? code
  );
};
const quotaTotals = (value: unknown, plan: string | undefined) => {
  if (!plan) return undefined;
  const row = object(findOneConsoleValue(value, [plan.toLowerCase()]));
  if (!row) return undefined;
  const fiveHour = number(row.five_hour ?? row.fiveHour);
  const weekly = number(row.weekly);
  return fiveHour === undefined && weekly === undefined ? undefined : { fiveHour, weekly };
};
const classify = (ctx: ProviderContext, root: Json) => {
  const code = string(
    findOneConsoleValue(root, ["errorCode", "code", "status", "statusCode"]),
  )?.toLowerCase();
  const message = string(
    findOneConsoleValue(root, ["errorMsg", "message", "msg", "statusMessage"]),
  )?.toLowerCase();
  const text = `${code ?? ""} ${message ?? ""}`;
  if (code === "401" || code === "403" || /forbidden|notauthorised|unauthorized/i.test(text))
    throw ctx.fail.authenticationExpired("Qwen Cloud session was rejected.");
  if (/needlogin|login|sign in|signin|token.*expired/i.test(text))
    throw ctx.fail.authenticationExpired("Qwen Cloud login is required.");
  if (findOneConsoleValue(root, ["successResponse", "success"]) === false)
    throw ctx.fail.apiFailure(message || "Qwen Cloud request was not successful.");
};

const currentSnapshot = (
  ctx: ProviderContext,
  usageData: unknown,
  subscriptionData: unknown,
  quotaData: unknown,
) => {
  const expanded = expandOneConsole(usageData);
  const root = object(expanded);
  if (!root) throw ctx.fail.parseFailure("Qwen Cloud response must be an object.");
  classify(ctx, root);
  const usage = findOneConsoleObject(expanded, ["per5HourPercentage", "per1WeekPercentage"]);
  if (!usage) return undefined;
  const fiveHour = percentPoints(usage.per5HourPercentage);
  const weekly = percentPoints(usage.per1WeekPercentage);
  if (fiveHour === undefined && weekly === undefined) return undefined;
  const plan = planName(expandOneConsole(subscriptionData));
  const totals = quotaTotals(expandOneConsole(quotaData), plan);
  const primaryReset = oneConsoleDate(ctx, usage.per5HourResetTime);
  const weeklyReset = oneConsoleDate(ctx, usage.per1WeekResetTime);
  return {
    ...(fiveHour === undefined
      ? {}
      : {
          primary: {
            usedPercent: fiveHour,
            windowMinutes: 300,
            ...(primaryReset ? { resetsAt: primaryReset } : {}),
            ...(totals?.fiveHour === undefined
              ? {}
              : {
                  resetDescription: `${format(ctx, (totals.fiveHour * fiveHour) / 100)} / ${format(ctx, totals.fiveHour)} credits used`,
                }),
          },
        }),
    ...(weekly === undefined
      ? {}
      : {
          secondary: {
            usedPercent: weekly,
            windowMinutes: 10_080,
            ...(weeklyReset ? { resetsAt: weeklyReset } : {}),
            ...(totals?.weekly === undefined
              ? {}
              : {
                  resetDescription: `${format(ctx, (totals.weekly * weekly) / 100)} / ${format(ctx, totals.weekly)} credits used`,
                }),
          },
        }),
    identity: { loginMethod: plan ?? "Token Plan" },
  };
};

const legacySnapshot = (ctx: ProviderContext, payload: unknown) => {
  const expanded = expandOneConsole(payload);
  const root = object(expanded);
  if (!root) throw ctx.fail.parseFailure("Qwen Cloud response must be an object.");
  classify(ctx, root);
  const summary = findOneConsoleObject(expanded, [
    "TotalValue",
    "TotalSurplusValue",
    "CycleTotalValue",
    "CycleSurplusValue",
  ]);
  const total = number(
    findOneConsoleValue(summary ?? root, [
      "TotalValue",
      "totalQuota",
      "total_value",
      "CycleTotalValue",
    ]),
  );
  const remaining = number(
    findOneConsoleValue(summary ?? root, [
      "TotalSurplusValue",
      "remainingQuota",
      "total_surplus_value",
      "CycleSurplusValue",
    ]),
  );
  const used =
    number(findOneConsoleValue(summary ?? root, ["UsedValue", "usedQuota", "used_value"])) ??
    (total !== undefined && remaining !== undefined ? Math.max(0, total - remaining) : undefined);
  const reset = oneConsoleDate(
    ctx,
    findOneConsoleValue(summary ?? root, ["EndTime", "endTime", "resetTime", "expireTime"]),
  );
  if (total === undefined && used === undefined && remaining === undefined)
    throw ctx.fail.parseFailure("Qwen Cloud response is missing token-plan data.");
  return {
    ...(total && total > 0 && used !== undefined
      ? {
          primary: {
            usedPercent: ctx.pct(used, total),
            windowMinutes: 43_200,
            ...(reset ? { resetsAt: reset } : {}),
            resetDescription: `${format(ctx, used)} / ${format(ctx, total)} credits used`,
          },
        }
      : {}),
    identity: { loginMethod: planName(expanded) ?? "TOKEN PLAN" },
  };
};

const cookieHeader = async (ctx: ProviderContext) =>
  clean(ctx.settings.getSecret("QWEN_CLOUD_COOKIE")) ??
  clean(ctx.settings.get("QWEN_CLOUD_COOKIE")) ??
  clean(await ctx.browser.cookieHeader("home.qwencloud.com"));
const secToken = async (ctx: ProviderContext, cookie: string) => {
  const embedded = cookieValue(cookie, "sec_token");
  if (embedded) return embedded;
  try {
    const response = await ctx.http.get(dashboardURL, {
      headers: { Cookie: cookie, Accept: "text/html,*/*", "User-Agent": userAgent },
    });
    if (response.status >= 200 && response.status < 300) {
      const match = /(?:sec_token|secToken)\s*[=:]\s*["']([^"']+)/iu.exec(response.bodyText);
      if (match?.[1]) return match[1];
    }
  } catch {
    // The upstream client intentionally falls back to a cookie-only request if the HTML token route drifts.
  }
  return undefined;
};
const request = async (
  ctx: ProviderContext,
  cookie: string,
  token: string | undefined,
  api: string,
  data: Record<string, string>,
) => {
  const url = new URL(`${apiBase}/data/api.json`);
  url.searchParams.set("action", "IntlBroadScopeAspnGateway");
  url.searchParams.set("product", "sfm_bailian");
  url.searchParams.set("api", api);
  url.searchParams.set("_v", "undefined");
  const params = JSON.stringify({
    Api: api,
    V: "1.0",
    Data: {
      ...data,
      cornerstoneParam: {
        feTraceId: "codexbar-multi",
        feURL: dashboardURL,
        protocol: "V2",
        console: "ONE_CONSOLE",
        productCode: "p_efm",
        domain: "home.qwencloud.com",
        consoleSite: "QWENCLOUD",
        xsp_lang: "en-US",
        ...(cookieValue(cookie, "cna") ? { "X-Anonymous-Id": cookieValue(cookie, "cna") } : {}),
      },
    },
  });
  const response = await ctx.http.postJSON(url.href, {
    body: form({
      product: "sfm_bailian",
      action: "IntlBroadScopeAspnGateway",
      region: "ap-southeast-1",
      language: "en-US",
      params,
      ...(token ? { sec_token: token } : {}),
    }),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json, text/plain, */*",
      Cookie: cookie,
      Origin: "https://home.qwencloud.com",
      Referer: dashboardURL,
      "X-Requested-With": "XMLHttpRequest",
      "User-Agent": userAgent,
      ...(cookieValue(cookie, "login_aliyunid_csrf")
        ? { "x-xsrf-token": cookieValue(cookie, "login_aliyunid_csrf") as string }
        : {}),
    },
  });
  status(ctx, "Qwen Cloud", response);
  return response.json as unknown;
};

const definition: ProviderDefinition = {
  id: "qwencloud",
  name: "Qwen Cloud",
  endpoints: ["https://home.qwencloud.com", "https://cs-data.qwencloud.com"],
  settings: [{ key: "QWEN_CLOUD_COOKIE", title: "Cookie header", type: "secure" }],
  capabilities: ["browser-cookies"],
  cookieDomains: ["home.qwencloud.com", "cs-data.qwencloud.com", "qwencloud.com"],
  fetchUsage: async (ctx: ProviderContext) => {
    const cookie = await cookieHeader(ctx);
    if (!cookie) throw ctx.fail.missingCredential("Qwen Cloud cookie is not configured.");
    const token = await secToken(ctx, cookie);
    const usageAPI = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage";
    const subscriptionAPI = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/subscription";
    const quotaAPI = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/quota-config";
    const usage = await request(ctx, cookie, token, usageAPI, {});
    const subscription = await request(ctx, cookie, token, subscriptionAPI, {
      commodityCode: "sfm_tokenplansolo_public_intl",
    }).catch(() => ({}));
    const quota = await request(ctx, cookie, token, quotaAPI, {}).catch(() => ({}));
    return currentSnapshot(ctx, usage, subscription, quota) ?? legacySnapshot(ctx, usage);
  },
};
const strategy: ProviderStrategy = {
  id: "qwen-cloud.web",
  kind: "web",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const qwencloud: FirstPartyProvider = { ...strategy, descriptor };
