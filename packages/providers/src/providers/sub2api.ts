import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { normalizeEndpoint } from "@codexbar/core";
import { get } from "./_http.ts";

const clean = (raw: string | undefined): string | undefined => {
  let value = raw?.trim() ?? "";
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1).trim();
  }
  return value === "" ? undefined : value;
};

const definition: ProviderDefinition = {
  id: "sub2api",
  name: "sub2api",
  endpoints: [{ setting: "SUB2API_BASE_URL", policy: "https-or-loopback-http" }],
  auth: { type: "bearer", secret: "SUB2API_API_KEY" },
  settings: [
    { key: "SUB2API_API_KEY", title: "API key", type: "secure" },
    { key: "SUB2API_BASE_URL", title: "Base URL", type: "plain" },
  ],
  fetchUsage: async (ctx: ProviderContext) => {
    const key =
      clean(ctx.settings.getSecret("SUB2API_API_KEY")) ??
      clean(ctx.settings.get("SUB2API_API_KEY"));
    if (key === undefined) {
      throw ctx.fail.missingCredential(
        "Missing sub2api API key. Add a group API key in Settings or set SUB2API_API_KEY.",
      );
    }
    const configuredBase = clean(ctx.settings.get("SUB2API_BASE_URL"));
    const endpoint =
      configuredBase === undefined
        ? undefined
        : normalizeEndpoint(configuredBase, { transport: "loopback-http" });
    if (endpoint === undefined || endpoint.search !== "" || endpoint.hash !== "") {
      throw ctx.fail.missingCredential(
        "Missing or invalid sub2api base URL. Add one in Settings or set SUB2API_BASE_URL.",
      );
    }
    const usageURL = new URL(endpoint.href);
    const rootPath = usageURL.pathname.replace(/\/+$/u, "");
    usageURL.pathname = rootPath.endsWith("/v1/usage")
      ? rootPath
      : rootPath.endsWith("/v1")
        ? `${rootPath}/usage`
        : `${rootPath}/v1/usage`;
    const timezone: any = ctx.env.timeZone || "UTC";
    usageURL.searchParams.set("days", "30");
    usageURL.searchParams.set("timezone", timezone);
    const response = await get(ctx, usageURL.href, {
      headers: { Authorization: `Bearer ${key}` },
      timeoutSeconds: 15,
    });
    if (response.status === 401 || response.status === 403) {
      throw ctx.fail.authenticationExpired(
        "sub2api rejected the API key. Check that the key is active and assigned to a group.",
      );
    }
    if (response.status === 429) throw ctx.fail.rateLimited("sub2api API returned HTTP 429.");
    if (response.status >= 500) {
      throw ctx.fail.providerUnavailable(`sub2api API returned HTTP ${response.status}.`);
    }
    if (response.status < 200 || response.status >= 300) {
      throw ctx.fail.apiFailure(`sub2api API returned HTTP ${response.status}.`);
    }

    let data;
    try {
      data = JSON.parse(response.bodyText);
    } catch {
      throw ctx.fail.parseFailure("Could not parse sub2api usage: response was not valid JSON");
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw ctx.fail.parseFailure("Could not parse sub2api usage: response must be an object");
    }

    function optional(value: any, field: any, type: any) {
      if (value === null || value === undefined) return null;
      if (typeof value !== type || (type === "number" && !Number.isFinite(value))) {
        throw ctx.fail.parseFailure(`Could not parse sub2api usage: ${field} has an invalid type`);
      }
      return value;
    }
    function requiredNumber(value: any, field: any) {
      const number: any = optional(value, field, "number");
      if (number === null)
        throw ctx.fail.parseFailure(`Could not parse sub2api usage: ${field} is required`);
      return number;
    }
    function requiredString(value: any, field: any) {
      const string: any = optional(value, field, "string");
      if (string === null || !string) {
        throw ctx.fail.parseFailure(`Could not parse sub2api usage: ${field} is required`);
      }
      return string;
    }
    function parseDate(value: any, field: any) {
      const text: any = optional(value, field, "string");
      if (text === null) return undefined;
      try {
        return ctx.date.iso(text);
      } catch {
        throw ctx.fail.parseFailure(`Could not parse sub2api usage: ${field} is not a valid date`);
      }
    }

    optional(data.mode, "mode", "string");
    const isValid: any = optional(data.isValid, "isValid", "boolean");
    optional(data.status, "status", "string");
    const planName: any = optional(data.planName, "planName", "string");
    optional(data.remaining, "remaining", "number");
    const balance: any = optional(data.balance, "balance", "number");
    const rootUnit: any = optional(data.unit, "unit", "string");
    if (isValid === false) {
      throw ctx.fail.authenticationExpired(
        "sub2api rejected the API key. Check that the key is active and assigned to a group.",
      );
    }

    let quota: any = null;
    if (data.quota !== null && data.quota !== undefined) {
      if (!data.quota || typeof data.quota !== "object" || Array.isArray(data.quota)) {
        throw ctx.fail.parseFailure("Could not parse sub2api usage: quota must be an object");
      }
      quota = {
        limit: requiredNumber(data.quota.limit, "quota.limit"),
        used: requiredNumber(data.quota.used, "quota.used"),
        remaining: requiredNumber(data.quota.remaining, "quota.remaining"),
        unit: optional(data.quota.unit, "quota.unit", "string"),
      };
    }
    const unit: any = rootUnit || (quota && quota.unit) || "USD";

    let subscription: any = null;
    if (data.subscription !== null && data.subscription !== undefined) {
      if (
        !data.subscription ||
        typeof data.subscription !== "object" ||
        Array.isArray(data.subscription)
      ) {
        throw ctx.fail.parseFailure(
          "Could not parse sub2api usage: subscription must be an object",
        );
      }
      subscription = {
        dailyUsage:
          optional(data.subscription.daily_usage_usd, "subscription.daily_usage_usd", "number") ||
          0,
        weeklyUsage:
          optional(data.subscription.weekly_usage_usd, "subscription.weekly_usage_usd", "number") ||
          0,
        monthlyUsage:
          optional(
            data.subscription.monthly_usage_usd,
            "subscription.monthly_usage_usd",
            "number",
          ) || 0,
        dailyLimit: optional(
          data.subscription.daily_limit_usd,
          "subscription.daily_limit_usd",
          "number",
        ),
        weeklyLimit: optional(
          data.subscription.weekly_limit_usd,
          "subscription.weekly_limit_usd",
          "number",
        ),
        monthlyLimit: optional(
          data.subscription.monthly_limit_usd,
          "subscription.monthly_limit_usd",
          "number",
        ),
        expiresAt: parseDate(data.subscription.expires_at, "subscription.expires_at"),
      };
    }

    const money: any = (value: any, valueUnit: any = "USD") =>
      valueUnit.toUpperCase() === "USD"
        ? `$${ctx.format.number(value, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })}`
        : `${Number(value).toFixed(2)} ${valueUnit}`;
    const amount: any = (used: any, limit: any, valueUnit: any = "USD") =>
      `${money(used, valueUnit)} / ${money(limit, valueUnit)}`;
    const window: any = (used: any, limit: any, minutes: any, valueUnit: any = "USD") =>
      limit !== null && limit > 0
        ? {
            usedPercent: ctx.pct(used, limit),
            windowMinutes: minutes,
            resetDescription: amount(used, limit, valueUnit),
          }
        : null;
    let primary: any = null;
    let secondary: any = null;
    let tertiary: any = null;
    if (subscription) {
      primary = window(subscription.dailyUsage, subscription.dailyLimit, 1440);
      secondary = window(subscription.weeklyUsage, subscription.weeklyLimit, 10080);
      tertiary = window(subscription.monthlyUsage, subscription.monthlyLimit, 43200);
    } else if (quota) {
      primary = window(quota.used, quota.limit, null, quota.unit || unit);
      if (primary) delete primary.windowMinutes;
    }

    let rateLimits: any = data.rate_limits;
    if (rateLimits === null || rateLimits === undefined) rateLimits = [];
    if (!Array.isArray(rateLimits)) {
      throw ctx.fail.parseFailure("Could not parse sub2api usage: rate_limits must be an array");
    }
    const minuteMap: any = { "5h": 300, "1d": 1440, "7d": 10080 };
    const titleMap: any = { "5h": "5 hour limit", "1d": "Daily limit", "7d": "7 day limit" };
    const extraWindows: any = rateLimits.map((rate: any, index: any) => {
      if (!rate || typeof rate !== "object" || Array.isArray(rate)) {
        throw ctx.fail.parseFailure(
          `Could not parse sub2api usage: rate_limits[${index}] must be an object`,
        );
      }
      const rateWindow: any = requiredString(rate.window, `rate_limits[${index}].window`);
      const limit: any = requiredNumber(rate.limit, `rate_limits[${index}].limit`);
      const used: any = requiredNumber(rate.used, `rate_limits[${index}].used`);
      requiredNumber(rate.remaining, `rate_limits[${index}].remaining`);
      return {
        id: rateWindow,
        title: titleMap[rateWindow.toLowerCase()] || `${rateWindow} limit`,
        window: {
          usedPercent: ctx.pct(used, limit),
          windowMinutes: minuteMap[rateWindow.toLowerCase()],
          resetsAt: parseDate(rate.reset_at, `rate_limits[${index}].reset_at`),
          resetDescription: amount(used, limit),
        },
      };
    });

    function totals(value: any, field: any) {
      if (value === null || value === undefined) return null;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw ctx.fail.parseFailure(`Could not parse sub2api usage: ${field} must be an object`);
      }
      const requests: any = optional(value.requests, `${field}.requests`, "number") || 0;
      const tokens: any = optional(value.total_tokens, `${field}.total_tokens`, "number") || 0;
      if (!Number.isInteger(requests) || !Number.isInteger(tokens)) {
        throw ctx.fail.parseFailure(
          `Could not parse sub2api usage: ${field} counts must be integers`,
        );
      }
      return {
        requests,
        tokens,
        cost: optional(value.actual_cost, `${field}.actual_cost`, "number") || 0,
      };
    }
    let usage: any = data.usage;
    if (usage === null || usage === undefined) usage = {};
    if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
      throw ctx.fail.parseFailure("Could not parse sub2api usage: usage must be an object");
    }
    const rows: any = [];
    if (balance !== null) {
      rows.push({ label: "Balance", value: money(balance, unit) });
    }
    for (const [title, value] of [
      ["Today", totals(usage.today, "usage.today")],
      ["All time", totals(usage.total, "usage.total")],
    ]) {
      if (!value) continue;
      const summary: any = value;
      rows.push({ label: `${title} requests`, value: ctx.format.number(summary.requests) });
      rows.push({
        label: `${title} tokens`,
        value: ctx.format.number(summary.tokens),
        secondaryValue: money(summary.cost),
      });
    }
    const expiresAt: any =
      (subscription && subscription.expiresAt) || parseDate(data.expires_at, "expires_at");
    return {
      primary,
      secondary,
      tertiary,
      extraWindows,
      subscriptionExpiresAt: expiresAt,
      identity: { organization: planName, loginMethod: planName },
      details: rows.length ? [{ title: "Usage summary", rows }] : undefined,
      dataConfidence: "exact",
    };
  },
};
const strategy: ProviderStrategy = {
  id: "sub2api.api",
  kind: "api",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const sub2api: FirstPartyProvider = { ...strategy, descriptor };
