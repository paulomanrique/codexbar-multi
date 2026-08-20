import type {
  FirstPartyProvider,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { number, object, status, string } from "./_http.ts";
const definition: ProviderDefinition = {
  id: "augment",
  name: "Augment Code",
  endpoints: ["https://app.augmentcode.com"],
  settings: [{ key: "AUGMENT_COOKIE_HEADER", title: "Cookie header", type: "secure" }],
  capabilities: ["browser-cookies"],
  cookieDomains: ["app.augmentcode.com"],
  fetchUsage: async (ctx) => {
    const cookie =
      ctx.settings.getSecret("AUGMENT_COOKIE_HEADER")?.trim() ||
      (await ctx.browser.cookieHeader("app.augmentcode.com"));
    if (!cookie) throw ctx.fail.missingCredential("Augment session is not configured.");
    const response = await ctx.http.getJSON("https://app.augmentcode.com/api/auth/session", {
      headers: {
        Cookie: cookie,
        Accept: "application/json",
        Origin: "https://app.augmentcode.com",
      },
    });
    status(ctx, "Augment", response);
    const root = object(response.json);
    const usage = object(root?.usage) ?? root;
    const used = number(usage?.usedPercent) ?? number(usage?.used);
    if (used === undefined)
      throw ctx.fail.parseFailure("Augment session response is missing usage.");
    return {
      primary: { usedPercent: Math.max(0, Math.min(100, used)) },
      identity: string(root?.plan) ? { loginMethod: string(root?.plan) } : {},
    };
  },
};
const strategy: ProviderStrategy = {
  id: "augment.web",
  kind: "web",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const augment: FirstPartyProvider = { ...strategy, descriptor };
