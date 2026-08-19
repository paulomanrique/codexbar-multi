import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { get, json, number, object, status } from "./_http.ts";
const definition: ProviderDefinition = {
  id: "groq",
  name: "Groq",
  endpoints: ["https://api.groq.com/v1", { setting: "GROQ_API_URL", policy: "https" }],
  auth: { type: "bearer", secret: "GROQ_API_KEY" },
  settings: [
    { key: "GROQ_API_KEY", title: "API key", type: "secure" },
    { key: "GROQ_API_URL", title: "API URL", type: "plain" },
  ],
  fetchUsage: async (ctx: ProviderContext) => {
    const key = ctx.settings.getSecret("GROQ_API_KEY") || ctx.settings.get("GROQ_API_KEY");
    if (!key) throw ctx.fail.missingCredential("Missing Groq API key.");
    const headers = { Authorization: `Bearer ${key}`, Accept: "application/json" };
    const rootURL = (ctx.settings.get("GROQ_API_URL") || "https://api.groq.com/v1").replace(
      /\/+$/,
      "",
    );
    const scalar = async (query: string): Promise<number> => {
      const response = await get(
        ctx,
        `${rootURL}/metrics/prometheus?query=${encodeURIComponent(query)}`,
        { headers },
      );
      status(ctx, "Groq", response);
      const root = object(json(ctx, "Groq", response));
      const data = root && object(root.data);
      const result = data && Array.isArray(data.result) ? data.result : [];
      let sum = 0;
      for (const raw of result) {
        const row = object(raw);
        const values = row && Array.isArray(row.value) ? row.value : [];
        const value = values.length > 1 ? number(values[1]) : undefined;
        if (value !== undefined) sum += value;
      }
      return sum;
    };
    const [requests, input, output, cache] = await Promise.all([
      scalar("sum(model_project_id_status_code:requests:rate5m)"),
      scalar("sum(model_project_id:tokens_in:rate5m)"),
      scalar("sum(model_project_id:tokens_out:rate5m)"),
      scalar("sum(model_project_id:prompt_cache_hits:rate5m)"),
    ]);
    return {
      primary: {
        usedPercent: 0,
        windowMinutes: 5,
        resetDescription: `${Math.round(requests * 60)} req/min`,
      },
      secondary: {
        usedPercent: 0,
        windowMinutes: 5,
        resetDescription: `${Math.round((input + output) * 60)} tok/min`,
      },
      ...(cache > 0
        ? {
            tertiary: {
              usedPercent: 0,
              windowMinutes: 5,
              resetDescription: `${Math.round(cache * 60)} cache/min`,
            },
          }
        : {}),
      identity: { loginMethod: "Prometheus metrics" },
    };
  },
};
const strategy: ProviderStrategy = {
  id: "groq.api",
  kind: "api",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const groq: FirstPartyProvider = { ...strategy, descriptor };
