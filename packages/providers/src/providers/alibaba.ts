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
} from "./alibabatokenplan.ts";

type Region = "intl" | "cn";
type Json = Record<string, unknown>;

const userAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/143 Safari/537.36";
const clean = (value: string | undefined): string | undefined => value?.trim() || undefined;
const selectedRegion = (ctx: ProviderContext): Region =>
  ctx.settings.get("ALIBABA_CODING_PLAN_REGION")?.trim().toLowerCase() === "cn" ? "cn" : "intl";
const gateway = (region: Region) =>
  region === "intl"
    ? "https://modelstudio.console.alibabacloud.com"
    : "https://bailian.console.aliyun.com";
const consoleGateway = (region: Region) =>
  region === "intl"
    ? "https://bailian-singapore-cs.alibabacloud.com"
    : "https://bailian-cs.console.aliyun.com";
const regionId = (region: Region) => (region === "intl" ? "ap-southeast-1" : "cn-beijing");
const commodity = (region: Region) =>
  region === "intl" ? "sfm_codingplan_public_intl" : "sfm_codingplan_public_cn";
const dashboard = (region: Region) =>
  region === "intl"
    ? "https://modelstudio.console.alibabacloud.com/ap-southeast-1/?tab=coding-plan#/efm/coding_plan"
    : "https://bailian.console.aliyun.com/cn-beijing/?tab=model#/efm/coding_plan";
const apiURL = (region: Region) => {
  const url = new URL(`${gateway(region)}/data/api.json`);
  url.searchParams.set(
    "action",
    "zeldaEasy.broadscope-bailian.codingPlan.queryCodingPlanInstanceInfoV2",
  );
  url.searchParams.set("product", "broadscope-bailian");
  url.searchParams.set("api", "queryCodingPlanInstanceInfoV2");
  url.searchParams.set("currentRegionId", regionId(region));
  return url.href;
};
const cookieValue = (header: string, name: string): string | undefined => {
  for (const part of header.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName?.toLowerCase() === name.toLowerCase() && rawValue.length)
      return rawValue.join("=").trim() || undefined;
  }
  return undefined;
};
const form = (values: Readonly<Record<string, string>>) => new URLSearchParams(values).toString();
const asJson = (value: unknown): Json => {
  const result = object(expandOneConsole(value));
  if (!result) throw new Error("not an object");
  return result;
};
const maybeNumber = (value: unknown) => number(value);
const format = (ctx: ProviderContext, value: number) => ctx.format.number(value);

const classifyPayload = (ctx: ProviderContext, root: Json, apiKeyMode: boolean) => {
  const code = string(
    findOneConsoleValue(root, ["statusCode", "status_code", "code", "status"]),
  )?.toLowerCase();
  const message = string(
    findOneConsoleValue(root, ["statusMessage", "status_msg", "message", "msg"]),
  )?.toLowerCase();
  const text = `${code ?? ""} ${message ?? ""}`;
  if (code === "401" || code === "403" || /api key|unauthorized|forbidden/i.test(text))
    throw ctx.fail.authenticationExpired("Alibaba Coding Plan credentials were rejected.");
  if (/needlogin|login|sign in/i.test(text)) {
    if (apiKeyMode)
      throw ctx.fail.authenticationExpired(
        "Alibaba Coding Plan API key is unavailable in this region.",
      );
    throw ctx.fail.authenticationExpired("Alibaba Coding Plan login is required.");
  }
};

const activeInstance = (root: unknown, now: number): Json | undefined => {
  const container = findOneConsoleObject(root, [
    "codingPlanInstanceInfos",
    "coding_plan_instance_infos",
  ]);
  const rows = container?.codingPlanInstanceInfos ?? container?.coding_plan_instance_infos;
  if (!Array.isArray(rows)) return undefined;
  const scored = rows
    .filter((row): row is Json => object(row) !== undefined)
    .map((row) => {
      const statusValue = string(row.status ?? row.instanceStatus)?.toUpperCase();
      const active = row.isActive ?? row.active;
      const end = maybeNumber(row.endTime ?? row.periodEndTime ?? row.expireTime);
      const score =
        statusValue === "VALID" || statusValue === "ACTIVE"
          ? 3
          : active === true
            ? 3
            : end && end > now
              ? 1
              : 0;
      return { row, score };
    });
  return scored.sort((left, right) => right.score - left.score)[0]?.row;
};
const firstQuota = (value: unknown): Json | undefined => {
  const direct = findOneConsoleObject(value, ["codingPlanQuotaInfo", "coding_plan_quota_info"]);
  if (direct) {
    const nested = object(direct.codingPlanQuotaInfo ?? direct.coding_plan_quota_info);
    return nested ?? direct;
  }
  return findOneConsoleObject(value, [
    "per5HourTotalQuota",
    "perFiveHourTotalQuota",
    "perWeekTotalQuota",
    "perBillMonthTotalQuota",
  ]);
};
const window = (
  ctx: ProviderContext,
  quota: Json,
  usedKeys: readonly string[],
  totalKeys: readonly string[],
  resetKeys: readonly string[],
  minutes: number,
  primary: boolean,
) => {
  const used = maybeNumber(findOneConsoleValue(quota, usedKeys));
  const total = maybeNumber(findOneConsoleValue(quota, totalKeys));
  if (used === undefined || total === undefined || total <= 0) return undefined;
  let reset = oneConsoleDate(ctx, findOneConsoleValue(quota, resetKeys));
  // Upstream normalizes stale five-hour reset timestamps so cards never show a past reset.
  if (primary && reset && Date.parse(reset) - ctx.date.nowMillis() < 60_000)
    reset = new Date(ctx.date.nowMillis() + 5 * 60 * 60 * 1_000).toISOString();
  return {
    usedPercent: ctx.pct(Math.max(0, Math.min(used, total)), total),
    windowMinutes: minutes,
    ...(reset ? { resetsAt: reset } : {}),
    resetDescription: `${format(ctx, used)} / ${format(ctx, total)} used`,
  };
};
const snapshot = (ctx: ProviderContext, response: unknown, apiKeyMode: boolean) => {
  let root: Json;
  try {
    root = asJson(response);
  } catch {
    throw ctx.fail.parseFailure("Alibaba Coding Plan response must be a JSON object.");
  }
  classifyPayload(ctx, root, apiKeyMode);
  const instance = activeInstance(root, ctx.date.nowMillis());
  const quota = firstQuota(instance ?? root);
  const plan = string(
    findOneConsoleValue(instance ?? root, ["planName", "plan_name", "instanceName", "packageName"]),
  );
  if (!quota) {
    if (plan) return { identity: { loginMethod: plan } };
    throw ctx.fail.parseFailure("Alibaba Coding Plan response is missing quota data.");
  }
  const primary = window(
    ctx,
    quota,
    ["per5HourUsedQuota", "perFiveHourUsedQuota"],
    ["per5HourTotalQuota", "perFiveHourTotalQuota"],
    ["per5HourQuotaNextRefreshTime", "perFiveHourQuotaNextRefreshTime"],
    300,
    true,
  );
  const secondary = window(
    ctx,
    quota,
    ["perWeekUsedQuota"],
    ["perWeekTotalQuota"],
    ["perWeekQuotaNextRefreshTime"],
    10_080,
    false,
  );
  const tertiary = window(
    ctx,
    quota,
    ["perBillMonthUsedQuota", "perMonthUsedQuota"],
    ["perBillMonthTotalQuota", "perMonthTotalQuota"],
    ["perBillMonthQuotaNextRefreshTime", "perMonthQuotaNextRefreshTime"],
    43_200,
    false,
  );
  if (!primary && !secondary && !tertiary && !plan)
    throw ctx.fail.parseFailure("Alibaba Coding Plan response has no usable quota windows.");
  return {
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    ...(tertiary ? { tertiary } : {}),
    identity: { loginMethod: plan ?? "Alibaba Coding Plan" },
  };
};

const apiKey = (ctx: ProviderContext) =>
  ["ALIBABA_CODING_PLAN_API_KEY", "ALIBABA_QWEN_API_KEY", "DASHSCOPE_API_KEY"]
    .map((key) => clean(ctx.settings.getSecret(key)) ?? clean(ctx.settings.get(key)))
    .find((key): key is string => key !== undefined);
const sessionCookie = async (ctx: ProviderContext, region: Region) =>
  clean(ctx.settings.getSecret("ALIBABA_CODING_PLAN_COOKIE")) ??
  clean(ctx.settings.get("ALIBABA_CODING_PLAN_COOKIE")) ??
  clean(await ctx.browser.cookieHeader(new URL(gateway(region)).host));

const webFetch = async (ctx: ProviderContext, region: Region, cookie: string) => {
  const secToken = cookieValue(cookie, "sec_token") ?? "";
  const params = JSON.stringify({
    Api: "zeldaEasy.broadscope-bailian.codingPlan.queryCodingPlanInstanceInfoV2",
    V: "1.0",
    Data: {
      queryCodingPlanInstanceInfoRequest: { commodityCode: commodity(region), onlyLatestOne: true },
      cornerstoneParam: {
        feTraceId: "codexbar-multi",
        feURL: dashboard(region),
        protocol: "V2",
        console: "ONE_CONSOLE",
        productCode: "p_efm",
        domain: new URL(gateway(region)).host,
        consoleSite: region === "intl" ? "MODELSTUDIO_ALIBABACLOUD" : "BAILIAN_ALIYUN",
        xsp_lang: "en-US",
      },
    },
  });
  const url = new URL(`${consoleGateway(region)}/data/api.json`);
  url.searchParams.set(
    "action",
    region === "intl" ? "IntlBroadScopeAspnGateway" : "BroadScopeAspnGateway",
  );
  url.searchParams.set("product", "sfm_bailian");
  url.searchParams.set(
    "api",
    "zeldaEasy.broadscope-bailian.codingPlan.queryCodingPlanInstanceInfoV2",
  );
  url.searchParams.set("_v", "undefined");
  const response = await ctx.http.postJSON(url.href, {
    body: form({ params, region: regionId(region), ...(secToken ? { sec_token: secToken } : {}) }),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json, text/plain, */*",
      Cookie: cookie,
      Origin: gateway(region),
      Referer: dashboard(region),
      "X-Requested-With": "XMLHttpRequest",
      "User-Agent": userAgent,
      ...(cookieValue(cookie, "login_aliyunid_csrf")
        ? { "x-xsrf-token": cookieValue(cookie, "login_aliyunid_csrf") as string }
        : {}),
    },
  });
  status(ctx, "Alibaba Coding Plan", response);
  return snapshot(ctx, response.json as unknown, false);
};
const apiFetch = async (ctx: ProviderContext, region: Region, token: string) => {
  const response = await ctx.http.postJSON(apiURL(region), {
    body: { queryCodingPlanInstanceInfoRequest: { commodityCode: commodity(region) } },
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "x-api-key": token,
      "X-DashScope-API-Key": token,
      "User-Agent": userAgent,
      Origin: gateway(region),
      Referer: dashboard(region),
    },
  });
  status(ctx, "Alibaba Coding Plan", response);
  return snapshot(ctx, response.json as unknown, true);
};

const definition: ProviderDefinition = {
  id: "alibaba",
  name: "Alibaba",
  endpoints: [
    "https://modelstudio.console.alibabacloud.com",
    "https://bailian.console.aliyun.com",
    "https://bailian-singapore-cs.alibabacloud.com",
    "https://bailian-cs.console.aliyun.com",
  ],
  auth: { type: "provider-managed", secret: "ALIBABA_CODING_PLAN_API_KEY" },
  settings: [
    { key: "ALIBABA_CODING_PLAN_API_KEY", title: "API key", type: "secure" },
    { key: "ALIBABA_CODING_PLAN_COOKIE", title: "Cookie header", type: "secure" },
    { key: "ALIBABA_CODING_PLAN_REGION", title: "Region", type: "plain" },
  ],
  capabilities: ["browser-cookies"],
  cookieDomains: ["modelstudio.console.alibabacloud.com", "bailian.console.aliyun.com"],
  fetchUsage: async (ctx: ProviderContext) => {
    const region = selectedRegion(ctx);
    const cookie = await sessionCookie(ctx, region);
    const token = apiKey(ctx);
    if (cookie) {
      try {
        return await webFetch(ctx, region, cookie);
      } catch (error) {
        if (!token) throw error;
      }
    }
    if (!token)
      throw ctx.fail.missingCredential("Alibaba Coding Plan API key or cookie is not configured.");
    try {
      return await apiFetch(ctx, region, token);
    } catch (error) {
      if (region === "intl") return apiFetch(ctx, "cn", token);
      throw error;
    }
  },
};

const strategy: ProviderStrategy = {
  id: "alibaba-coding-plan.web-api",
  kind: "web",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const alibaba: FirstPartyProvider = { ...strategy, descriptor };
