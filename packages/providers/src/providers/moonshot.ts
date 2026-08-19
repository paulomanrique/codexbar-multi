import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { get, json, number, object, status } from "./_http.ts";
const definition: ProviderDefinition = {
  id: "moonshot",
  name: "Moonshot / Kimi Open Platform",
  endpoints: ["https://api.moonshot.ai", "https://api.moonshot.cn"],
  auth: { type: "bearer", secret: "MOONSHOT_API_KEY" },
  settings: [
    { key: "MOONSHOT_API_KEY", title: "API key", type: "secure" },
    { key: "MOONSHOT_REGION", title: "Region", type: "plain" },
  ],
  fetchUsage: async (ctx: ProviderContext) => {
    const key = ctx.settings.getSecret("MOONSHOT_API_KEY") || ctx.settings.get("MOONSHOT_API_KEY");
    if (!key) throw ctx.fail.missingCredential("Missing Moonshot API key.");
    const host =
      (ctx.settings.get("MOONSHOT_REGION") || "international").toLowerCase() === "china"
        ? "api.moonshot.cn"
        : "api.moonshot.ai";
    const response = await get(ctx, `https://${host}/v1/users/me/balance`, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    });
    status(ctx, "Moonshot", response);
    const root = object(json(ctx, "Moonshot", response));
    const data = root && object(root.data);
    if (!root || !data || root.status !== true || root.code !== 0)
      throw ctx.fail.apiFailure("Moonshot balance API returned an unsuccessful response.");
    const balance = number(data.available_balance);
    if (balance === undefined)
      throw ctx.fail.parseFailure("Moonshot available_balance is invalid.");
    const cash = number(data.cash_balance) ?? 0;
    return {
      identity: {
        loginMethod: `Balance: $${balance.toFixed(2)}${cash < 0 ? ` · $${Math.abs(cash).toFixed(2)} in deficit` : ""}`,
      },
    };
  },
};
const strategy: ProviderStrategy = {
  id: "moonshot.api",
  kind: "api",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const moonshot: FirstPartyProvider = { ...strategy, descriptor };
