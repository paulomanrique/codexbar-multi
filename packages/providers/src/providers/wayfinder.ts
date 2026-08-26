import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { get, json, object, status } from "./_http.ts";

const defaultBaseURL = "http://127.0.0.1:8088";
const clean = (value: string | undefined): string | undefined => {
  let result = value?.trim();
  if (!result) return undefined;
  if (
    (result.startsWith('"') && result.endsWith('"')) ||
    (result.startsWith("'") && result.endsWith("'"))
  )
    result = result.slice(1, -1).trim();
  return result || undefined;
};
const baseURL = (raw: string): URL | undefined => {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    const loopback =
      host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
    if (
      !url.hostname ||
      url.username ||
      url.password ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    )
      return undefined;
    return url;
  } catch {
    return undefined;
  }
};
const endpoint = (base: URL, path: string): URL => {
  const url = new URL(base);
  const prefix = url.pathname.replace(/\/+$/u, "");
  url.pathname = `${prefix}/${path}`.replace(/\/+/gu, "/");
  url.search = "";
  return url;
};
const plural = (value: number, singular: string, pluralValue: string): string =>
  `${value} ${value === 1 ? singular : pluralValue}`;
const percentage = (value: number): string =>
  value === Math.round(value) ? String(Math.round(value)) : value.toFixed(1);

const isAbortError = (error: unknown): boolean =>
  (error instanceof DOMException && error.name === "AbortError") ||
  (error instanceof Error && error.name === "AbortError");

const jsonNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const requiredObject = (ctx: ProviderContext, endpointName: string, value: unknown) => {
  const result = object(value);
  if (result === undefined)
    throw ctx.fail.parseFailure(`Wayfinder ${endpointName} response must be an object.`);
  return result;
};

const requiredString = (
  ctx: ProviderContext,
  endpointName: string,
  value: unknown,
  field: string,
): string => {
  if (typeof value !== "string")
    throw ctx.fail.parseFailure(`Wayfinder ${endpointName}.${field} must be a string.`);
  return value;
};

const requiredBoolean = (
  ctx: ProviderContext,
  endpointName: string,
  value: unknown,
  field: string,
): boolean => {
  if (typeof value !== "boolean")
    throw ctx.fail.parseFailure(`Wayfinder ${endpointName}.${field} must be a boolean.`);
  return value;
};

const requiredNumber = (
  ctx: ProviderContext,
  endpointName: string,
  value: unknown,
  field: string,
): number => {
  const result = jsonNumber(value);
  if (result === undefined)
    throw ctx.fail.parseFailure(`Wayfinder ${endpointName}.${field} must be a number.`);
  return result;
};

const requiredInteger = (
  ctx: ProviderContext,
  endpointName: string,
  value: unknown,
  field: string,
): number => {
  const result = requiredNumber(ctx, endpointName, value, field);
  if (!Number.isInteger(result))
    throw ctx.fail.parseFailure(`Wayfinder ${endpointName}.${field} must be an integer.`);
  return result;
};

const requiredStringArray = (
  ctx: ProviderContext,
  endpointName: string,
  value: unknown,
  field: string,
): readonly string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw ctx.fail.parseFailure(`Wayfinder ${endpointName}.${field} must be an array.`);
  return value.map((item, index) => {
    if (typeof item !== "string")
      throw ctx.fail.parseFailure(`Wayfinder ${endpointName}.${field}[${index}] must be a string.`);
    return item;
  });
};

const modelCount = (ctx: ProviderContext, models: readonly unknown[]): number => {
  models.forEach((item, index) => {
    const model = object(item);
    if (model === undefined)
      throw ctx.fail.parseFailure(`Wayfinder /router/models.models[${index}] must be an object.`);
    requiredString(ctx, "/router/models", model.name, `models[${index}].name`);
  });
  return models.length;
};

const metric = (text: string): number | undefined => {
  let sum: number | undefined;
  let count: number | undefined;
  for (const line of text.split("\n")) {
    const match =
      /^(wayfinder_router_decision_latency_seconds_(sum|count))(?:\{[^}]*\})?\s+([^\s]+)$/u.exec(
        line.trim(),
      );
    if (!match) continue;
    const value = Number(match[3]);
    if (!Number.isFinite(value)) continue;
    if (match[2] === "sum") sum = value;
    else count = value;
  }
  return sum !== undefined && count !== undefined && count > 0 ? (sum / count) * 1_000 : undefined;
};

const definition: ProviderDefinition = {
  id: "wayfinder",
  name: "Wayfinder",
  endpoints: [
    {
      setting: "WAYFINDER_GATEWAY_URL",
      policy: "https-or-loopback-http",
      default: defaultBaseURL,
    },
  ],
  settings: [{ key: "WAYFINDER_GATEWAY_URL", title: "Gateway URL", type: "plain" }],
  fetchUsage: async (ctx) => {
    const configured = clean(ctx.settings.get("WAYFINDER_GATEWAY_URL")) ?? defaultBaseURL;
    const base = baseURL(configured);
    if (!base)
      throw ctx.fail.apiFailure(
        "WAYFINDER_GATEWAY_URL must be HTTPS, or HTTP only for a loopback gateway.",
      );
    const requestJSON = async (path: string, query?: readonly [string, string]) => {
      const url = endpoint(base, path);
      if (query) url.searchParams.set(query[0], query[1]);
      const response = await get(ctx, url.href, {
        headers: { Accept: "application/json" },
        timeoutSeconds: 5,
      });
      status(ctx, "Wayfinder", response);
      return requiredObject(
        ctx,
        path.startsWith("/") ? path : `/${path}`,
        json(ctx, "Wayfinder", response),
      );
    };
    const health = await requestJSON("healthz");
    const models = await requestJSON("router/models");
    const savings = await requestJSON("v1/savings", ["period", "30d"]);
    const routeMap = requiredObject(ctx, "/v1/savings", savings.by_route);
    if (!Array.isArray(models.models))
      throw ctx.fail.parseFailure("Wayfinder /router/models.models must be an array.");
    const routes = Object.entries(routeMap)
      .map(([name, value]) => {
        const route = requiredObject(ctx, "/v1/savings", value);
        return {
          name,
          requests: requiredInteger(
            ctx,
            "/v1/savings",
            route.requests,
            `by_route.${name}.requests`,
          ),
          saved: requiredNumber(ctx, "/v1/savings", route.saved, `by_route.${name}.saved`),
          tokens: requiredInteger(ctx, "/v1/savings", route.tokens, `by_route.${name}.tokens`),
        };
      })
      .sort((left, right) => right.requests - left.requests || left.name.localeCompare(right.name));
    const requests = requiredInteger(ctx, "/v1/savings", savings.requests, "requests");
    const saved = requiredNumber(ctx, "/v1/savings", savings.saved, "saved");
    const savedPct = requiredNumber(ctx, "/v1/savings", savings.saved_pct, "saved_pct");
    const priced = requiredBoolean(ctx, "/v1/savings", savings.priced, "priced");
    const offline = requiredBoolean(ctx, "/healthz", health.offline, "offline");
    const dryRun = requiredBoolean(ctx, "/router/models", models.dry_run, "dry_run");
    const gatewayStatus = requiredString(ctx, "/healthz", health.status, "status");
    const missingKeys = requiredStringArray(ctx, "/healthz", health.missing_keys, "missing_keys");
    const modelsCount = modelCount(ctx, models.models);
    let metrics: string | undefined;
    try {
      const response = await get(ctx, endpoint(base, "metrics").href, { timeoutSeconds: 5 });
      if (response.status >= 200 && response.status < 300) metrics = response.bodyText;
    } catch (error) {
      if (isAbortError(error)) throw error;
      // Metrics are deliberately best-effort in the Swift implementation.
    }
    const avgMs = metrics ? metric(metrics) : undefined;
    const statusLabel = offline
      ? "Offline mode"
      : dryRun
        ? "Dry run"
        : gatewayStatus === "degraded"
          ? missingKeys.length === 0
            ? "Degraded"
            : `Degraded — ${plural(missingKeys.length, "key", "keys")} missing`
          : "Local gateway";
    const modelLabel = plural(modelsCount, "model", "models");
    const gatewaySummary = `${gatewayStatus} · ${modelLabel}${offline ? " · offline" : ""}${dryRun ? " · dry run" : ""}`;
    const routed =
      requests > 0
        ? routes
            .slice(0, 5)
            .map((route) => `${route.name}: ${route.requests.toLocaleString("en-US")}`)
            .join(" · ")
        : undefined;
    const savedSummary =
      requests > 0 && saved > 0
        ? `${priced ? `${saved < 0.01 ? "<$0.01" : ctx.format.usd(saved)} · ` : ""}${percentage(savedPct)}% vs highest-cost route`
        : undefined;
    return {
      details: [
        {
          title: "Usage",
          rows: [
            { label: "Gateway", value: gatewaySummary },
            ...(routed ? [{ label: "Routed", value: routed }] : []),
            ...(savedSummary ? [{ label: "Saved", value: savedSummary }] : []),
            ...(avgMs === undefined
              ? []
              : [{ label: "Avg decision", value: `${avgMs.toFixed(1)} ms` }]),
          ],
        },
      ],
      identity: { organization: `${modelLabel} · local gateway`, loginMethod: statusLabel },
      dataConfidence: "exact",
    };
  },
};

const strategy: ProviderStrategy = {
  id: "wayfinder.api",
  kind: "api",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const wayfinder: FirstPartyProvider = { ...strategy, descriptor };
