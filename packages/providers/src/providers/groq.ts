import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderResponse,
  ProviderStrategy,
} from "../types.ts";
import { normalizeEndpoint } from "@codexbar/core";
import { get, object } from "./_http.ts";

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

export class GroqPrometheusAPIError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GroqPrometheusAPIError";
  }
}

export class InvalidGroqPrometheusScalar extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidGroqPrometheusScalar";
  }
}

export const resolveGroqAPIKey = (ctx: ProviderContext): string | undefined =>
  clean(ctx.settings.getSecret("GROQ_API_KEY")) ?? clean(ctx.settings.get("GROQ_API_KEY"));

export const resolveGroqMetricsEndpoint = (ctx: ProviderContext): URL | undefined => {
  const configuredURL = clean(ctx.settings.get("GROQ_API_URL"));
  return normalizeEndpoint(configuredURL ?? "https://api.groq.com/v1");
};

const parsePrometheusDouble = (value: unknown): number | undefined => {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  if (!/^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const responseSummary = (response: ProviderResponse): string =>
  response.bodyText.slice(0, 500).trim();

const status = (ctx: ProviderContext, response: ProviderResponse): void => {
  if (response.status >= 200 && response.status < 300) return;
  const summary = responseSummary(response);
  if (response.status === 401) {
    throw ctx.fail.authenticationExpired(`Groq metrics access denied: ${summary}`);
  }
  if (response.status === 403) {
    throw ctx.fail.permissionDenied(`Groq metrics access denied: ${summary}`);
  }
  throw ctx.fail.apiFailure(`Groq metrics API error: HTTP ${response.status}: ${summary}`);
};

export const parseGroqPrometheusScalar = (value: unknown): number => {
  const root = object(value);
  if (!root) throw new InvalidGroqPrometheusScalar("response must be an object.");

  if (typeof root.status !== "string") {
    throw new InvalidGroqPrometheusScalar("status is missing.");
  }
  if (root.status !== "success") {
    const error = typeof root.error === "string" ? root.error : "query failed";
    throw new GroqPrometheusAPIError(error);
  }

  const data = root.data == null ? undefined : object(root.data);
  if (root.data != null && data === undefined) {
    throw new InvalidGroqPrometheusScalar("data must be an object.");
  }
  if (data === undefined) return 0;

  const result = data.result;
  if (!Array.isArray(result)) {
    throw new InvalidGroqPrometheusScalar("result must be an array.");
  }

  let sum = 0;
  for (const raw of result) {
    const series = object(raw);
    if (series === undefined) {
      throw new InvalidGroqPrometheusScalar("result series must be an object.");
    }
    if (series.value == null) continue;
    if (!Array.isArray(series.value)) {
      throw new InvalidGroqPrometheusScalar("value must be an array.");
    }
    for (const item of series.value) {
      if (typeof item !== "number" && typeof item !== "string") {
        throw new InvalidGroqPrometheusScalar("value must contain strings or numbers.");
      }
    }
    const value = parsePrometheusDouble(series.value.at(-1));
    if (value !== undefined) sum += value;
  }
  return sum;
};

const parseScalar = (ctx: ProviderContext, response: ProviderResponse): number => {
  let value: unknown;
  try {
    value = JSON.parse(response.bodyText) as unknown;
  } catch {
    throw ctx.fail.parseFailure("Groq response was not valid JSON.");
  }
  try {
    return parseGroqPrometheusScalar(value);
  } catch (error) {
    if (error instanceof GroqPrometheusAPIError) {
      throw ctx.fail.apiFailure(`Groq metrics API error: ${error.message}`);
    }
    if (error instanceof InvalidGroqPrometheusScalar) {
      throw ctx.fail.parseFailure(`Groq metrics parse error: ${error.message}`);
    }
    throw error;
  }
};

const encodeSwiftQueryItemValue = (value: string): string =>
  encodeURIComponent(value).replace(/%28/giu, "(").replace(/%29/giu, ")").replace(/%3A/giu, ":");

export const resolveGroqMetricsQueryURL = (endpoint: URL, query: string): string => {
  const rootURL = endpoint.href.replace(/\/+$/u, "");
  return `${rootURL}/metrics/prometheus/api/v1/query?query=${encodeSwiftQueryItemValue(query)}`;
};

const definition: ProviderDefinition = {
  id: "groq",
  name: "Groq",
  endpoints: ["https://api.groq.com/v1", { setting: "GROQ_API_URL", policy: "https" }],
  settings: [
    { key: "GROQ_API_KEY", title: "API key", type: "secure" },
    { key: "GROQ_API_URL", title: "API URL", type: "plain" },
  ],
  fetchUsage: async (ctx: ProviderContext) => {
    const key = resolveGroqAPIKey(ctx);
    if (!key) {
      throw ctx.fail.missingCredential(
        "Missing Groq API key. Set apiKey in ~/.codexbar/config.json or GROQ_API_KEY.",
      );
    }
    const headers = { Authorization: `Bearer ${key}`, Accept: "application/json" };
    const endpoint = resolveGroqMetricsEndpoint(ctx);
    if (endpoint === undefined) {
      throw ctx.fail.apiFailure(
        "Groq endpoint override GROQ_API_URL must use HTTPS or a bare host.",
      );
    }
    const scalar = async (query: string): Promise<number> => {
      const response = await get(ctx, resolveGroqMetricsQueryURL(endpoint, query), { headers });
      status(ctx, response);
      return parseScalar(ctx, response);
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
