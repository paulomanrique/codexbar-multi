import type {
  FirstPartyProvider,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { number, object, status, string } from "./_http.ts";
const definition: ProviderDefinition = {
  id: "kilo",
  name: "Kilo Code",
  endpoints: ["https://api.kilo.ai", "https://app.kilo.ai"],
  settings: [{ key: "KILO_BEARER_TOKEN", title: "Bearer token", type: "secure" }],
  fetchUsage: async (ctx) => {
    const token = ctx.settings.getSecret("KILO_BEARER_TOKEN")?.trim();
    if (!token)
      throw ctx.fail.missingCredential(
        "Kilo credential discovery requires the CredentialStore adapter.",
      );
    const response = await ctx.http.getJSON("https://api.kilo.ai/api/profile", {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    status(ctx, "Kilo", response);
    const root = object(response.json);
    const usage = object(root?.usage) ?? root;
    const used = number(usage?.used) ?? number(usage?.usedPercent);
    const limit = number(usage?.limit);
    if (used === undefined) throw ctx.fail.parseFailure("Kilo profile is missing usage.");
    return {
      primary: {
        usedPercent: limit && limit > 0 ? ctx.pct(used, limit) : Math.max(0, Math.min(100, used)),
      },
      identity: string(root?.plan) ? { loginMethod: string(root?.plan) } : {},
    };
  },
};
const strategy: ProviderStrategy = {
  id: "kilo.api",
  kind: "api",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const kilo: FirstPartyProvider = { ...strategy, descriptor };
