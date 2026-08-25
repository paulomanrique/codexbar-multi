import type {
  FirstPartyProvider,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { normalizeEndpoint } from "@codexbar/core";
import { date, get, json, number, object, string } from "./_http.ts";

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
  id: "neuralwatt",
  name: "Neuralwatt",
  endpoints: ["https://api.neuralwatt.com", { setting: "NEURALWATT_API_URL", policy: "https" }],
  settings: [
    { key: "NEURALWATT_API_KEY", title: "API key", type: "secure" },
    { key: "NEURALWATT_API_URL", title: "API URL", type: "plain" },
  ],
  fetchUsage: async (ctx) => {
    const key =
      clean(ctx.settings.getSecret("NEURALWATT_API_KEY")) ??
      clean(ctx.settings.get("NEURALWATT_API_KEY"));
    if (!key) throw ctx.fail.missingCredential("Missing Neuralwatt API key.");
    const configured = clean(ctx.settings.get("NEURALWATT_API_URL"));
    const endpoint = normalizeEndpoint(configured ?? "https://api.neuralwatt.com");
    if (endpoint === undefined) {
      throw ctx.fail.apiFailure(
        "Neuralwatt endpoint override NEURALWATT_API_URL must use HTTPS or a bare host.",
      );
    }
    const quotaURL = new URL(endpoint.href);
    const rootPath = quotaURL.pathname.replace(/\/+$/u, "");
    quotaURL.pathname = rootPath.endsWith("/v1") ? `${rootPath}/quota` : `${rootPath}/v1/quota`;
    const response = await get(ctx, quotaURL.href, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    });
    if (response.status === 401 || response.status === 403) {
      throw ctx.fail.missingCredential("Neuralwatt rejected the API key.");
    }
    if (response.status !== 200) {
      throw ctx.fail.apiFailure(`Neuralwatt API returned HTTP ${response.status}.`);
    }
    const parsed = object(json(ctx, "Neuralwatt", response));
    if (!parsed) throw ctx.fail.parseFailure("Neuralwatt response must be an object.");
    const root = parsed;
    const balance = object(root.balance);
    if (!balance) throw ctx.fail.parseFailure("Missing Neuralwatt balance object.");
    const nonNegative = (value: unknown): number | undefined => {
      const parsedValue = number(value);
      return parsedValue !== undefined && parsedValue >= 0 ? parsedValue : undefined;
    };
    const positive = (value: unknown): number | undefined => {
      const parsedValue = number(value);
      return parsedValue !== undefined && parsedValue > 0 ? parsedValue : undefined;
    };
    const remaining = nonNegative(balance.credits_remaining_usd);
    const total = positive(balance.total_credits_usd);
    const used = nonNegative(balance.credits_used_usd);
    if (remaining === undefined && total === undefined && used === undefined)
      throw ctx.fail.parseFailure("Missing Neuralwatt credit balance fields.");
    const effectiveTotal =
      total ??
      (remaining !== undefined && used !== undefined && remaining + used > 0
        ? remaining + used
        : undefined);
    const effectiveUsed =
      used ??
      (effectiveTotal !== undefined && remaining !== undefined
        ? Math.max(0, effectiveTotal - remaining)
        : undefined);
    const effectiveRemaining =
      remaining ??
      (effectiveTotal !== undefined && effectiveUsed !== undefined
        ? Math.max(0, effectiveTotal - effectiveUsed)
        : undefined);
    const subscription = object(root.subscription);
    const included = positive(subscription?.kwh_included);
    const kwhUsed = nonNegative(subscription?.kwh_used);
    const kwhRemaining = nonNegative(subscription?.kwh_remaining);
    const subscriptionTotal =
      included ??
      (kwhUsed !== undefined && kwhRemaining !== undefined && kwhUsed + kwhRemaining > 0
        ? kwhUsed + kwhRemaining
        : undefined);
    const subscriptionUsed =
      kwhUsed ??
      (subscriptionTotal !== undefined && kwhRemaining !== undefined
        ? Math.max(0, subscriptionTotal - kwhRemaining)
        : undefined);
    const periodStart = date(subscription?.current_period_start, ctx);
    const periodEnd = date(subscription?.current_period_end, ctx);
    const windowMinutes =
      periodStart && periodEnd && Date.parse(periodEnd) > Date.parse(periodStart)
        ? Math.max(1, Math.floor((Date.parse(periodEnd) - Date.parse(periodStart)) / 60_000))
        : undefined;
    const plan = string(subscription?.plan);
    const accountingMethod = string(balance.accounting_method);
    const loginMethod = plan
      ? `${plan.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase())} plan`
      : accountingMethod
        ? accountingMethod.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase())
        : undefined;
    const result: Record<string, unknown> = {
      identity: loginMethod ? { loginMethod } : {},
      cost:
        effectiveRemaining === undefined
          ? undefined
          : {
              used: effectiveRemaining,
              limit: 0,
              currency: "USD",
              period: "Neuralwatt prepaid balance",
            },
    };
    if (subscriptionTotal !== undefined && subscriptionUsed !== undefined)
      result.primary = {
        usedPercent: Math.max(0, Math.min(100, (subscriptionUsed / subscriptionTotal) * 100)),
        ...(windowMinutes === undefined ? {} : { windowMinutes }),
        resetDescription: `${formatKwh(subscriptionUsed)} / ${formatKwh(subscriptionTotal)} kWh`,
        ...(periodEnd ? { resetsAt: periodEnd } : {}),
      };
    const allowance = object(object(root.key)?.allowance);
    const al = number(allowance?.limit_usd);
    const spent = nonNegative(allowance?.spent_usd);
    const blocked = allowance?.blocked === true;
    const allowancePercent = blocked
      ? 100
      : al !== undefined && al > 0 && spent !== undefined
        ? Math.max(0, Math.min(100, (spent / al) * 100))
        : undefined;
    if (allowance && allowancePercent !== undefined)
      result.extraRateWindows = [
        {
          id: "key-allowance",
          title: `Key ${string(allowance.period)?.replace(/\b\w/g, (letter) => letter.toUpperCase()) || "Allowance"}`,
          window: {
            usedPercent: allowancePercent,
          },
        },
      ];
    if (periodEnd && subscription?.auto_renew !== false) result.subscriptionRenewsAt = periodEnd;
    result.dataConfidence = "exact";
    return result;
  },
};

const formatKwh = (value: number): string =>
  Number.isInteger(value) ? value.toFixed(0) : value.toFixed(2);
const strategy: ProviderStrategy = {
  id: "neuralwatt.api",
  kind: "api",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const neuralwatt: FirstPartyProvider = { ...strategy, descriptor };
