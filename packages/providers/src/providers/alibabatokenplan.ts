import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { number, object, status, string } from "./_http.ts";

type Region = "intl" | "cn" | "intl-personal" | "cn-personal";
class PersonalUsageWindowsUnavailable extends Error {}
type Json = Record<string, unknown>;

const browserUA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/143 Safari/537.36";
const clean = (value: string | undefined): string | undefined => value?.trim() || undefined;
const isRecord = (value: unknown): value is Json => object(value) !== undefined;
const region = (ctx: ProviderContext): Region => {
  const value = ctx.settings.get("ALIBABA_TOKEN_PLAN_REGION")?.trim().toLowerCase();
  return value === "intl" || value === "cn" || value === "intl-personal" || value === "cn-personal"
    ? value
    : "cn";
};
const international = (value: Region) => value === "intl" || value === "intl-personal";
const personal = (value: Region) => value === "intl-personal" || value === "cn-personal";
const gateway = (value: Region) =>
  international(value)
    ? "https://modelstudio.console.alibabacloud.com"
    : "https://bailian.console.aliyun.com";
const rpcGateway = (value: Region) =>
  international(value)
    ? "https://bailian-singapore-cs.alibabacloud.com"
    : "https://bailian-cs.console.aliyun.com";
const regionId = (value: Region) => (international(value) ? "ap-southeast-1" : "cn-beijing");
const dashboard = (value: Region) =>
  international(value)
    ? `https://modelstudio.console.alibabacloud.com/ap-southeast-1/?tab=plan#/efm/subscription/token-plan${personal(value) ? "/personal" : ""}`
    : `https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/token-plan${personal(value) ? "/personal" : ""}`;
const form = (values: Readonly<Record<string, string>>) => new URLSearchParams(values).toString();

/** Expand OneConsole's JSON-in-a-JSON frames before looking for schema keys. */
export const expandOneConsole = (value: unknown): unknown => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length < 1_048_576) {
      try {
        return expandOneConsole(JSON.parse(trimmed) as unknown);
      } catch {
        return value;
      }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(expandOneConsole);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, expandOneConsole(nested)]),
  );
};

export const findOneConsoleObject = (value: unknown, keys: readonly string[]): Json | undefined => {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findOneConsoleObject(item, keys);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (keys.some((key) => value[key] !== undefined)) return value;
  for (const nested of Object.values(value)) {
    const found = findOneConsoleObject(nested, keys);
    if (found) return found;
  }
  return undefined;
};

export const findOneConsoleValue = (value: unknown, keys: readonly string[]): unknown => {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findOneConsoleValue(item, keys);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  for (const key of keys) if (value[key] !== undefined) return value[key];
  for (const nested of Object.values(value)) {
    const found = findOneConsoleValue(nested, keys);
    if (found !== undefined) return found;
  }
  return undefined;
};

export const oneConsoleDate = (ctx: ProviderContext, value: unknown): string | undefined => {
  const parsed = number(value);
  if (parsed !== undefined)
    return parsed > 10_000_000_000 ? ctx.date.unixMillis(parsed) : ctx.date.unixSeconds(parsed);
  const raw = string(value);
  return raw && Number.isFinite(Date.parse(raw)) ? ctx.date.iso(raw) : undefined;
};
export const percentPoints = (value: unknown): number | undefined => {
  const parsed = number(value);
  if (parsed === undefined) return undefined;
  return Math.max(0, Math.min(100, parsed <= 1 ? parsed * 100 : parsed));
};
const cookieValue = (header: string, name: string): string | undefined => {
  const wanted = name.toLowerCase();
  for (const part of header.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName?.toLowerCase() === wanted && rawValue.length)
      return rawValue.join("=").trim() || undefined;
  }
  return undefined;
};
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
  const key = plan.toLowerCase();
  const found = findOneConsoleValue(value, [key]);
  const row = object(found);
  if (!row) return undefined;
  const fiveHour = number(row.five_hour ?? row.fiveHour);
  const weekly = number(row.weekly);
  return fiveHour === undefined && weekly === undefined ? undefined : { fiveHour, weekly };
};
const format = (ctx: ProviderContext, value: number) =>
  ctx.format.number(value, { maximumFractionDigits: Number.isInteger(value) ? 0 : 2 });

const classifyPayload = (ctx: ProviderContext, root: Json): void => {
  const code = string(
    findOneConsoleValue(root, ["errorCode", "code", "status", "statusCode"]),
  )?.toLowerCase();
  const message = string(
    findOneConsoleValue(root, ["errorMsg", "message", "msg", "statusMessage"]),
  )?.toLowerCase();
  const failed = findOneConsoleValue(root, ["successResponse", "success"]);
  if (
    code === "401" ||
    code === "403" ||
    /forbidden|notauthorised|unauthor/i.test(`${code} ${message}`)
  )
    throw ctx.fail.permissionDenied("Alibaba Token Plan session was denied.");
  if (failed === false || /needlogin|login|signin|token.*expired/i.test(`${code} ${message}`)) {
    if (/login|signin|token/i.test(`${code} ${message}`))
      throw ctx.fail.authenticationExpired("Alibaba Token Plan login is required.");
    throw ctx.fail.apiFailure(message || "Alibaba Token Plan request was not successful.");
  }
};

const personalSnapshot = (
  ctx: ProviderContext,
  usageResponse: unknown,
  subscriptionResponse: unknown,
  quotaResponse: unknown,
) => {
  const usageRoot = expandOneConsole(usageResponse);
  const root = object(usageRoot);
  if (!root) throw ctx.fail.parseFailure("Alibaba Token Plan response must be an object.");
  classifyPayload(ctx, root);
  const usage = findOneConsoleObject(usageRoot, ["per5HourPercentage", "per1WeekPercentage"]);
  if (!usage) throw new PersonalUsageWindowsUnavailable();
  const fiveHour = percentPoints(usage.per5HourPercentage);
  const weekly = percentPoints(usage.per1WeekPercentage);
  if (fiveHour === undefined && weekly === undefined) throw new PersonalUsageWindowsUnavailable();
  const plan = planName(expandOneConsole(subscriptionResponse));
  const totals = quotaTotals(expandOneConsole(quotaResponse), plan);
  return {
    ...(fiveHour === undefined
      ? {}
      : {
          primary: {
            usedPercent: fiveHour,
            windowMinutes: 300,
            ...(oneConsoleDate(ctx, usage.per5HourResetTime)
              ? { resetsAt: oneConsoleDate(ctx, usage.per5HourResetTime) }
              : {}),
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
            ...(oneConsoleDate(ctx, usage.per1WeekResetTime)
              ? { resetsAt: oneConsoleDate(ctx, usage.per1WeekResetTime) }
              : {}),
            ...(totals?.weekly === undefined
              ? {}
              : {
                  resetDescription: `${format(ctx, (totals.weekly * weekly) / 100)} / ${format(ctx, totals.weekly)} credits used`,
                }),
          },
        }),
    identity: { loginMethod: plan ?? "Personal" },
  };
};

const teamSnapshot = (ctx: ProviderContext, response: unknown) => {
  const expanded = expandOneConsole(response);
  const root = object(expanded);
  if (!root) throw ctx.fail.parseFailure("Alibaba Token Plan response must be an object.");
  classifyPayload(ctx, root);
  const summary =
    findOneConsoleObject(expanded, [
      "TotalValue",
      "totalQuota",
      "total_value",
      "CycleTotalValue",
    ]) ?? root;
  const total = number(
    findOneConsoleValue(summary, ["TotalValue", "totalQuota", "total_value", "CycleTotalValue"]),
  );
  const remaining = number(
    findOneConsoleValue(summary, [
      "TotalSurplusValue",
      "remainingQuota",
      "total_surplus_value",
      "CycleSurplusValue",
    ]),
  );
  const used =
    number(findOneConsoleValue(summary, ["UsedValue", "usedQuota", "used_value"])) ??
    (total !== undefined && remaining !== undefined ? Math.max(0, total - remaining) : undefined);
  const reset = oneConsoleDate(
    ctx,
    findOneConsoleValue(summary, ["EndTime", "endTime", "resetTime", "expireTime"]),
  );
  if (total === undefined && remaining === undefined && used === undefined)
    throw ctx.fail.parseFailure("Alibaba Token Plan response is missing quota data.");
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

const cookieHeader = async (ctx: ProviderContext, value: Region) =>
  clean(ctx.settings.getSecret("ALIBABA_TOKEN_PLAN_COOKIE")) ??
  clean(ctx.settings.get("ALIBABA_TOKEN_PLAN_COOKIE")) ??
  clean(await ctx.browser.cookieHeader(new URL(gateway(value)).host));

const sessionToken = async (ctx: ProviderContext, cookie: string, value: Region) => {
  const fromCookie = cookieValue(cookie, "sec_token");
  if (fromCookie) return fromCookie;
  try {
    const response = await ctx.http.get(dashboard(value), {
      headers: {
        Cookie: cookie,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "User-Agent": browserUA,
        Referer: `${gateway(value)}/`,
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": "document",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
    });
    if (response.status >= 200 && response.status < 300) {
      const match = /(?:sec_token|secToken|SEC_TOKEN)["']?\s*[=:]\s*["']([^"']+)/u.exec(
        response.bodyText,
      );
      if (match?.[1]) return match[1];
    }
  } catch {
    // Cookie-only request is a documented upstream fallback when the dashboard preflight drifts.
  }
  return undefined;
};

const personalRequest = async (
  ctx: ProviderContext,
  value: Region,
  cookie: string,
  secToken: string | undefined,
  api: string,
  data: Record<string, string>,
) => {
  const origin = gateway(value);
  const params = JSON.stringify({
    Api: api,
    V: "1.0",
    Data: {
      ...data,
      cornerstoneParam: {
        feTraceId: "codexbar-multi",
        feURL: dashboard(value),
        protocol: "V2",
        console: "ONE_CONSOLE",
        productCode: "p_efm",
        switchUserType: 3,
        domain: new URL(origin).host,
        consoleSite: international(value) ? "MODELSTUDIO_ALBABACLOUD" : "BAILIAN_ALIYUN",
        xsp_lang: "en-US",
        ...(cookieValue(cookie, "cna") ? { "X-Anonymous-Id": cookieValue(cookie, "cna") } : {}),
      },
    },
  });
  const url = `${rpcGateway(value)}/data/api.json?action=${international(value) ? "IntlBroadScopeAspnGateway" : "BroadScopeAspnGateway"}&product=sfm_bailian&api=${encodeURIComponent(api)}&_v=undefined`;
  const response = await ctx.http.postJSON(url, {
    body: form({
      product: "sfm_bailian",
      action: international(value) ? "IntlBroadScopeAspnGateway" : "BroadScopeAspnGateway",
      region: regionId(value),
      language: "en-US",
      params,
      ...(secToken ? { sec_token: secToken } : {}),
    }),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json, text/plain, */*",
      Cookie: cookie,
      Origin: origin,
      Referer: dashboard(value),
      "X-Requested-With": "XMLHttpRequest",
      "User-Agent": browserUA,
      ...(cookieValue(cookie, "login_aliyunid_csrf")
        ? { "x-xsrf-token": cookieValue(cookie, "login_aliyunid_csrf") as string }
        : {}),
    },
  });
  status(ctx, "Alibaba Token Plan", response);
  return response.json as unknown;
};

const optionalPersonalRequest = async (
  ctx: ProviderContext,
  value: Region,
  cookie: string,
  secToken: string | undefined,
  api: string,
  data: Record<string, string>,
): Promise<unknown> => {
  try {
    return await personalRequest(ctx, value, cookie, secToken, api, data);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    return {};
  }
};

const definition: ProviderDefinition = {
  id: "alibabatokenplan",
  name: "Alibaba Token Plan",
  endpoints: [
    "https://modelstudio.console.alibabacloud.com",
    "https://bailian.console.aliyun.com",
    "https://bailian-singapore-cs.alibabacloud.com",
    "https://bailian-cs.console.aliyun.com",
  ],
  settings: [
    { key: "ALIBABA_TOKEN_PLAN_COOKIE", title: "Cookie header", type: "secure" },
    { key: "ALIBABA_TOKEN_PLAN_REGION", title: "Region", type: "plain" },
  ],
  capabilities: ["browser-cookies"],
  cookieDomains: ["modelstudio.console.alibabacloud.com", "bailian.console.aliyun.com"],
  fetchUsage: async (ctx: ProviderContext) => {
    const selected = region(ctx);
    const cookie = await cookieHeader(ctx, selected);
    if (!cookie) throw ctx.fail.missingCredential("Alibaba Token Plan cookie is not configured.");
    const secToken = await sessionToken(ctx, cookie, selected);
    if (!personal(selected)) {
      const api = "GetSubscriptionSummary";
      const response = await ctx.http.postJSON(`${gateway(selected)}/data/api.json`, {
        body: form({
          product: "BssOpenAPI-V3",
          action: api,
          params: JSON.stringify({
            ProductCode: international(selected)
              ? "sfm_tokenplanteams_dp_intl"
              : "sfm_tokenplanteams_dp_cn",
          }),
          region: regionId(selected),
          ...(secToken ? { sec_token: secToken } : {}),
        }),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: cookie,
          Origin: gateway(selected),
          Referer: dashboard(selected),
          "User-Agent": browserUA,
        },
      });
      status(ctx, "Alibaba Token Plan", response);
      return teamSnapshot(ctx, response.json as unknown);
    }
    const usageAPI = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage";
    const subscriptionAPI = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/subscription";
    const quotaAPI = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/quota-config";
    const subscription = await optionalPersonalRequest(
      ctx,
      selected,
      cookie,
      secToken,
      subscriptionAPI,
      {
        commodityCode: international(selected)
          ? "sfm_tokenplansolo_public_intl"
          : "sfm_tokenplansolo_public_cn",
      },
    );
    const quota = await optionalPersonalRequest(ctx, selected, cookie, secToken, quotaAPI, {});
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) await ctx.date.sleep?.(400);
      const usage = await personalRequest(ctx, selected, cookie, secToken, usageAPI, {});
      try {
        return personalSnapshot(ctx, usage, subscription, quota);
      } catch (error) {
        if (!(error instanceof PersonalUsageWindowsUnavailable)) throw error;
      }
    }
    throw ctx.fail.providerUnavailable(
      "Alibaba Token Plan usage is temporarily unavailable; it will refresh automatically.",
    );
  },
};

const strategy: ProviderStrategy = {
  id: "alibaba-token-plan.web",
  kind: "web",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const alibabatokenplan: FirstPartyProvider = { ...strategy, descriptor };
