import type {
  FirstPartyProvider,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { date, get, json, number, object, status, string } from "./_http.ts";
const definition: ProviderDefinition = {
  id: "chutes",
  name: "Chutes",
  endpoints: ["https://api.chutes.ai"],
  auth: { type: "bearer", secret: "CHUTES_API_KEY" },
  settings: [
    { key: "CHUTES_API_KEY", title: "API key", type: "secure" },
    { key: "CHUTES_API_URL", title: "API URL", type: "plain" },
  ],
  fetchUsage: async (ctx) => {
    const key = ctx.settings.getSecret("CHUTES_API_KEY") || ctx.settings.get("CHUTES_API_KEY");
    if (!key) throw ctx.fail.missingCredential("Missing Chutes API key.");
    const rootURL = (ctx.settings.get("CHUTES_API_URL") || "https://api.chutes.ai").replace(
      /\/+$/,
      "",
    );
    const headers = { Authorization: `Bearer ${key}`, Accept: "application/json" };
    const response = await get(ctx, `${rootURL}/users/me/subscription_usage`, { headers });
    status(ctx, "Chutes", response);
    const root = object(json(ctx, "Chutes", response));
    if (!root) throw ctx.fail.parseFailure("Chutes response must be an object.");
    const extract = (source: Record<string, unknown>): Record<string, unknown> | undefined => {
      const nested =
        object(source.subscription_usage) || object(source.subscription) || object(source.data);
      return nested || source;
    };
    const payload = extract(root) || root;
    const used = number(payload.used ?? payload.usage ?? payload.used_amount);
    const limit = number(payload.limit ?? payload.quota ?? payload.total);
    const remaining = number(payload.remaining ?? payload.available);
    const percent =
      number(payload.usage_percent ?? payload.used_percent) ??
      (number(payload.percent_remaining) !== undefined
        ? 100 - (number(payload.percent_remaining) as number)
        : used !== undefined && limit !== undefined && limit > 0
          ? (used / limit) * 100
          : undefined);
    const reset = date(payload.reset_at ?? payload.resets_at, ctx);
    const result: Record<string, unknown> = {
      identity: {
        loginMethod:
          string(payload.plan_name ?? payload.plan) ||
          (String(payload.status || "").toLowerCase() === "active"
            ? "Active"
            : "No active subscription"),
      },
    };
    if (percent !== undefined)
      result.primary = {
        usedPercent: Math.max(0, Math.min(100, percent)),
        windowMinutes: 240,
        resetsAt: reset,
        resetDescription:
          used !== undefined && limit !== undefined
            ? `${used}/${limit} ${string(payload.unit) || "credits"}`
            : undefined,
      };
    if (limit !== undefined && remaining !== undefined)
      result.secondary = {
        usedPercent: ((limit - remaining) / limit) * 100,
        resetsAt: date(payload.billing_period_end ?? payload.period_end, ctx),
        resetDescription: `${limit - remaining}/${limit} ${string(payload.unit) || "credits"}`,
      };
    return result;
  },
};
const strategy: ProviderStrategy = {
  id: "chutes.api",
  kind: "api",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const chutes: FirstPartyProvider = { ...strategy, descriptor };
