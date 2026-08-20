import type {
  FirstPartyProvider,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { number, object, status, string } from "./_http.ts";
const definition: ProviderDefinition = {
  id: "grok",
  name: "Grok",
  endpoints: ["https://grok.com", "https://api.x.ai"],
  settings: [{ key: "GROK_COOKIE_HEADER", title: "Cookie header", type: "secure" }],
  capabilities: ["browser-cookies"],
  cookieDomains: ["grok.com", "x.ai"],
  fetchUsage: async (ctx) => {
    const cookie =
      ctx.settings.getSecret("GROK_COOKIE_HEADER")?.trim() ||
      (await ctx.browser.cookieHeader("grok.com"));
    if (!cookie) throw ctx.fail.missingCredential("Grok web session is not configured.");
    const response = await ctx.http.getJSON("https://grok.com/api/billing", {
      headers: { Cookie: cookie, Accept: "application/json", Origin: "https://grok.com" },
    });
    status(ctx, "Grok", response);
    const root = object(response.json);
    const used =
      number(root?.usagePercentage) ??
      number(root?.used_percent) ??
      number(object(root?.usage)?.percent);
    const reset = string(root?.resetAt) ?? string(root?.reset_at);
    if (used === undefined)
      throw ctx.fail.parseFailure("Grok billing response is missing usage percentage.");
    return {
      primary: {
        usedPercent: Math.max(0, Math.min(100, used)),
        ...(reset ? { resetsAt: ctx.date.iso(reset) } : {}),
      },
      identity: string(root?.plan) ? { loginMethod: string(root?.plan) } : {},
    };
  },
};
const strategy: ProviderStrategy = {
  id: "grok.web",
  kind: "web",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const grok: FirstPartyProvider = { ...strategy, descriptor };
