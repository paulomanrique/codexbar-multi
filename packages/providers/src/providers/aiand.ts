import type {
  FirstPartyProvider,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { get, json, object, status, string } from "./_http.ts";
const definition: ProviderDefinition = {
  id: "aiand",
  name: "ai&",
  endpoints: ["https://api.aiand.com"],
  auth: { type: "bearer", secret: "AIAND_API_KEY" },
  settings: [{ key: "AIAND_API_KEY", title: "API key", type: "secure" }],
  fetchUsage: async (ctx) => {
    const key = ctx.settings.getSecret("AIAND_API_KEY") || ctx.settings.get("AIAND_API_KEY");
    if (!key) throw ctx.fail.missingCredential("Missing ai& API key.");
    let after: string | undefined;
    let afterID: string | undefined;
    let complete = false;
    let totalScaled = 0n;
    let scale = 0;
    let currency: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const query = new URLSearchParams({ range: "30days", limit: "100" });
      if (after) query.set("after", after);
      if (afterID) query.set("after_id", afterID);
      const response = await get(ctx, `https://api.aiand.com/logs?${query.toString()}`, {
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      });
      status(ctx, "ai&", response);
      const root = object(json(ctx, "ai&", response));
      if (!root || !Array.isArray(root.data))
        throw ctx.fail.parseFailure("ai& logs response data must be an array.");
      const rows = root.data;
      for (const raw of rows) {
        const row = object(raw);
        const rawCost = row && string(row.cost);
        const code = row && string(row.currency);
        if (rawCost !== undefined && code && /^-?(?:\d+)(?:\.\d+)?$/.test(rawCost)) {
          currency ??= code.toUpperCase();
          if (currency === code.toUpperCase()) {
            const [whole, fractional = ""] = rawCost.split(".");
            const nextScale = fractional.length;
            if (nextScale > scale) {
              totalScaled *= 10n ** BigInt(nextScale - scale);
              scale = nextScale;
            }
            totalScaled += BigInt(`${whole}${fractional}`) * 10n ** BigInt(scale - nextScale);
          }
        }
      }
      if (root?.has_more !== true) {
        complete = true;
        break;
      }
      after = string(root.next_after);
      afterID = string(root.next_after_id);
      if (!after || !afterID) break;
    }
    return currency
      ? {
          cost: {
            used: Number(totalScaled) / 10 ** scale,
            limit: 0,
            currency,
            period: complete ? "Last 30 days" : "Last 30 days (partial)",
          },
          dataConfidence: complete ? "exact" : "estimated",
        }
      : { dataConfidence: complete ? "exact" : "estimated" };
  },
};
const strategy: ProviderStrategy = {
  id: "aiand.api",
  kind: "api",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const aiand: FirstPartyProvider = { ...strategy, descriptor };
