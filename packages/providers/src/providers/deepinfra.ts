import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { get, json, number, object, status, string } from "./_http.ts";
const definition: ProviderDefinition = {
  id: "deepinfra",
  name: "DeepInfra",
  endpoints: ["https://api.deepinfra.com"],
  auth: { type: "bearer", secret: "DEEPINFRA_API_KEY" },
  settings: [{ key: "DEEPINFRA_API_KEY", title: "API key", type: "secure" }],
  fetchUsage: async (ctx: ProviderContext) => {
    const key =
      ctx.settings.getSecret("DEEPINFRA_API_KEY") || ctx.settings.get("DEEPINFRA_API_KEY");
    if (!key) throw ctx.fail.missingCredential("Missing DeepInfra API key.");
    const headers = { Authorization: `Bearer ${key}`, Accept: "application/json" };
    const check = await get(ctx, "https://api.deepinfra.com/payment/checklist?compute_owed=true", {
      headers,
    });
    status(ctx, "DeepInfra", check);
    const usage = await get(ctx, "https://api.deepinfra.com/payment/usage?from=current", {
      headers,
    });
    status(ctx, "DeepInfra", usage);
    const c = object(json(ctx, "DeepInfra", check));
    const u = object(json(ctx, "DeepInfra", usage));
    const months = u && Array.isArray(u.months) ? u.months : [];
    if (!c || !u) throw ctx.fail.parseFailure("DeepInfra billing response must be an object.");
    const stripe = number(c.stripe_balance);
    const recent = Math.max(0, number(c.recent) ?? 0);
    if (stripe === undefined) throw ctx.fail.parseFailure("DeepInfra stripe_balance is invalid.");
    const last = months.length ? object(months[months.length - 1]) : undefined;
    const monthCost = Math.max(0, (number(last?.total_cost) ?? recent * 100) / 100);
    const net = stripe + recent;
    const limit = number(c.limit);
    const balance = Math.max(0, -net);
    const owed = Math.max(0, net);
    const detail = `${owed > 0 ? `$${owed.toFixed(2)} owed` : `$${balance.toFixed(2)} available`} · $${monthCost.toFixed(2)} spent this month`;
    const result: Record<string, unknown> = {
      primary: {
        usedPercent: c.suspended === true || owed > 0 || balance <= 0 ? 100 : 0,
        resetDescription:
          c.suspended === true
            ? `Suspended${string(c.suspend_reason) ? `: ${string(c.suspend_reason)}` : ""} · ${detail}`
            : detail,
      },
      identity: {},
    };
    if (limit !== undefined && limit > 0)
      result.cost = { used: recent, limit, currency: "USD", period: "Billing cycle" };
    return result;
  },
};
const strategy: ProviderStrategy = {
  id: "deepinfra.api",
  kind: "api",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const deepinfra: FirstPartyProvider = { ...strategy, descriptor };
