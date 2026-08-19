import type {
  FirstPartyProvider,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { date, get, json, number, object, status, string } from "./_http.ts";
const definition: ProviderDefinition = {
  id: "doubao",
  name: "Doubao",
  endpoints: ["https://ark.cn-beijing.volces.com"],
  auth: { type: "bearer", secret: "ARK_API_KEY" },
  settings: [
    { key: "ARK_API_KEY", title: "API key", type: "secure" },
    { key: "ARK_REGION", title: "Region", type: "plain" },
  ],
  fetchUsage: async (ctx) => {
    const key =
      ctx.settings.getSecret("ARK_API_KEY") ||
      ctx.settings.get("ARK_API_KEY") ||
      ctx.settings.getSecret("DOUBAO_API_KEY") ||
      ctx.settings.get("DOUBAO_API_KEY");
    if (!key) throw ctx.fail.missingCredential("Missing Doubao API key.");
    const response = await get(ctx, "https://ark.cn-beijing.volces.com/api/v3/usage", {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    });
    status(ctx, "Doubao", response);
    const root = object(json(ctx, "Doubao", response));
    if (!root) throw ctx.fail.parseFailure("Doubao response must be an object.");
    const quotas = Array.isArray(root.quotas)
      ? root.quotas
      : Array.isArray(root.data)
        ? root.data
        : [];
    const windows: unknown[] = [];
    for (const raw of quotas) {
      const q = object(raw);
      const percent = number(q?.percent ?? q?.usage_percent);
      if (percent === undefined) continue;
      const label = string(q?.label) || "Quota";
      windows.push({
        id: label.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        title: label,
        window: {
          usedPercent: percent,
          resetsAt: date(q?.reset_at ?? q?.resetAt, ctx),
          resetDescription: q?.total !== undefined ? `${percent}%` : undefined,
        },
      });
    }
    return windows.length
      ? {
          primary: (windows[0] as Record<string, unknown>).window,
          extraRateWindows: windows.slice(1),
          identity: { loginMethod: "API key" },
        }
      : { identity: { loginMethod: "API key" } };
  },
};
const strategy: ProviderStrategy = {
  id: "doubao.api",
  kind: "api",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const doubao: FirstPartyProvider = { ...strategy, descriptor };
