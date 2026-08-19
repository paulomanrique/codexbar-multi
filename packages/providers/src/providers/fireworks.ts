import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { get, json, number, object, status, string } from "./_http.ts";
const definition: ProviderDefinition = {
  id: "fireworks",
  name: "Fireworks",
  endpoints: ["https://api.fireworks.ai"],
  auth: { type: "bearer", secret: "FIREWORKS_API_KEY" },
  settings: [
    { key: "FIREWORKS_API_KEY", title: "API key", type: "secure" },
    { key: "FIREWORKS_ACCOUNT_SLUG", title: "Account slug", type: "plain" },
  ],
  fetchUsage: async (ctx: ProviderContext) => {
    const key =
      ctx.settings.getSecret("FIREWORKS_API_KEY") || ctx.settings.get("FIREWORKS_API_KEY");
    const slug = ctx.settings.get("FIREWORKS_ACCOUNT_SLUG");
    if (!key) throw ctx.fail.missingCredential("Missing Fireworks API key.");
    if (!slug || !/^[A-Za-z0-9._-]+$/.test(slug))
      throw ctx.fail.missingCredential("Missing or invalid Fireworks account slug.");
    const end = ctx.date.now();
    const start = new Date(end.getTime() - 30 * 86400000);
    const url = `https://api.fireworks.ai/v1/accounts/${slug}/billing/summary?startTime=${encodeURIComponent(start.toISOString())}&endTime=${encodeURIComponent(end.toISOString())}`;
    const response = await get(ctx, url, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    });
    status(ctx, "Fireworks", response);
    const root = object(json(ctx, "Fireworks", response));
    if (!root) throw ctx.fail.parseFailure("Fireworks response must be an object.");
    const rows = Array.isArray(root.lineItems) ? root.lineItems : [];
    let currency: string | undefined;
    let total = 0;
    for (const raw of rows) {
      const row = object(raw);
      const cost = row && object(row.totalCost);
      const code = cost && string(cost.currencyCode);
      const units = cost && number(cost.units);
      const nanos = cost && number(cost.nanos);
      if (code && units !== undefined && nanos !== undefined) {
        currency ??= code;
        if (currency === code) total += units + nanos / 1e9;
      }
    }
    return currency
      ? {
          cost: { used: total, limit: 0, currency: currency, period: "Last 30 days" },
          identity: {},
        }
      : { identity: {} };
  },
};
const strategy: ProviderStrategy = {
  id: "fireworks.api",
  kind: "api",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const fireworks: FirstPartyProvider = { ...strategy, descriptor };
