import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { normalizeEndpoint } from "@codexbar/core";
import { get, json, number, object, status } from "./_http.ts";

const clean = (raw: string | undefined): string | undefined => {
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

const formatRate = (value: number): string =>
  value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);

const definition: ProviderDefinition = {
  id: "groq",
  name: "Groq",
  endpoints: ["https://api.groq.com/v1", { setting: "GROQ_API_URL", policy: "https" }],
  settings: [
    { key: "GROQ_API_KEY", title: "API key", type: "secure" },
    { key: "GROQ_API_URL", title: "API URL", type: "plain" },
  ],
  fetchUsage: async (ctx: ProviderContext) => {
    const key =
      clean(ctx.settings.getSecret("GROQ_API_KEY")) ?? clean(ctx.settings.get("GROQ_API_KEY"));
    if (!key) throw ctx.fail.missingCredential("Missing Groq API key.");
    const headers = { Authorization: `Bearer ${key}`, Accept: "application/json" };
    const configuredURL = clean(ctx.settings.get("GROQ_API_URL"));
    const endpoint = normalizeEndpoint(configuredURL ?? "https://api.groq.com/v1");
    if (endpoint === undefined) {
      throw ctx.fail.apiFailure(
        "Groq endpoint override GROQ_API_URL must use HTTPS or a bare host.",
      );
    }
    const rootURL = endpoint.href.replace(/\/+$/u, "");
    const scalar = async (query: string): Promise<number> => {
      const response = await get(
        ctx,
        `${rootURL}/metrics/prometheus/api/v1/query?query=${encodeURIComponent(query)}`,
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
        resetDescription: `${formatRate(requests * 60)} req/min`,
      },
      secondary: {
        usedPercent: 0,
        windowMinutes: 5,
        resetDescription: `${formatRate((input + output) * 60)} tok/min`,
      },
      ...(cache > 0
        ? {
            tertiary: {
              usedPercent: 0,
              windowMinutes: 5,
              resetDescription: `${formatRate(cache * 60)} cache/min`,
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
