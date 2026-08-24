import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { get, json, number, object, status, string } from "./_http.ts";

const cleanAPIKey = (raw: string | undefined): string | undefined => {
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
  id: "deepinfra",
  name: "DeepInfra",
  endpoints: ["https://api.deepinfra.com"],
  settings: [
    { key: "DEEPINFRA_API_KEY", title: "API key", type: "secure" },
    { key: "DEEPINFRA_TOKEN", title: "Legacy API token", type: "secure" },
  ],
  fetchUsage: async (ctx: ProviderContext) => {
    const key =
      cleanAPIKey(ctx.settings.getSecret("DEEPINFRA_API_KEY")) ??
      cleanAPIKey(ctx.settings.get("DEEPINFRA_API_KEY")) ??
      cleanAPIKey(ctx.settings.getSecret("DEEPINFRA_TOKEN")) ??
      cleanAPIKey(ctx.settings.get("DEEPINFRA_TOKEN"));
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
    const recentValue = number(c.recent);
    if (stripe === undefined || recentValue === undefined || !Array.isArray(u.months))
      throw ctx.fail.parseFailure("DeepInfra billing response is missing required fields.");
    const recent = Math.max(0, recentValue);
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
