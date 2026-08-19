import type {
  FirstPartyProvider,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { date, get, json, number, object, status, string } from "./_http.ts";
const definition: ProviderDefinition = {
  id: "neuralwatt",
  name: "Neuralwatt",
  endpoints: ["https://api.neuralwatt.com"],
  auth: { type: "bearer", secret: "NEURALWATT_API_KEY" },
  settings: [
    { key: "NEURALWATT_API_KEY", title: "API key", type: "secure" },
    { key: "NEURALWATT_API_URL", title: "API URL", type: "plain" },
  ],
  fetchUsage: async (ctx) => {
    const key =
      ctx.settings.getSecret("NEURALWATT_API_KEY") || ctx.settings.get("NEURALWATT_API_KEY");
    if (!key) throw ctx.fail.missingCredential("Missing Neuralwatt API key.");
    const rootURL = (
      ctx.settings.get("NEURALWATT_API_URL") || "https://api.neuralwatt.com"
    ).replace(/\/+$/, "");
    const response = await get(
      ctx,
      `${rootURL.endsWith("/v1") ? rootURL : `${rootURL}/v1`}/quota`,
      { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } },
    );
    status(ctx, "Neuralwatt", response);
    const parsed = object(json(ctx, "Neuralwatt", response));
    if (!parsed) throw ctx.fail.parseFailure("Neuralwatt response must be an object.");
    const root = parsed;
    const balance = object(root.balance);
    if (!balance) throw ctx.fail.parseFailure("Missing Neuralwatt balance object.");
    const remaining = number(balance.credits_remaining_usd);
    const total = number(balance.total_credits_usd);
    const used = number(balance.credits_used_usd);
    if (remaining === undefined && total === undefined && used === undefined)
      throw ctx.fail.parseFailure("Missing Neuralwatt credit balance fields.");
    const effectiveTotal =
      total && total > 0
        ? total
        : remaining !== undefined && used !== undefined
          ? remaining + used
          : undefined;
    const effectiveUsed =
      used !== undefined
        ? used
        : effectiveTotal !== undefined && remaining !== undefined
          ? effectiveTotal - remaining
          : undefined;
    const subscription = object(root.subscription);
    const included = number(subscription?.kwh_included);
    const kwhUsed = number(subscription?.kwh_used);
    const periodEnd = date(subscription?.current_period_end, ctx);
    const result: Record<string, unknown> = {
      identity: {
        loginMethod: string(subscription?.plan)
          ? `${string(subscription?.plan)} plan`
          : string(balance.accounting_method),
      },
      cost:
        remaining === undefined
          ? undefined
          : { used: remaining, limit: 0, currency: "USD", period: "Neuralwatt prepaid balance" },
    };
    if (effectiveTotal !== undefined)
      result.primary = {
        usedPercent: Math.max(0, Math.min(100, ((effectiveUsed ?? 0) / effectiveTotal) * 100)),
        resetDescription: `${kwhUsed ?? 0} / ${included ?? 0} kWh`,
        ...(periodEnd ? { resetsAt: periodEnd } : {}),
      };
    const allowance = object(object(root.key)?.allowance);
    const al = number(allowance?.limit_usd);
    if (allowance && al && al > 0)
      result.extraRateWindows = [
        {
          id: "key-allowance",
          title: `Key ${string(allowance.period) || "Allowance"}`,
          window: {
            usedPercent:
              allowance.blocked === true ? 100 : ((number(allowance.spent_usd) ?? 0) / al) * 100,
          },
        },
      ];
    return result;
  },
};
const strategy: ProviderStrategy = {
  id: "neuralwatt.api",
  kind: "api",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const neuralwatt: FirstPartyProvider = { ...strategy, descriptor };
