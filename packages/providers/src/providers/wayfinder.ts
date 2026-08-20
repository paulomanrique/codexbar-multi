import type {
  FirstPartyProvider,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { get, json, number, object, status, string } from "./_http.ts";

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
const integer = (value: unknown, fallback = 0): number => {
  const result = number(value);
  return result === undefined ? fallback : Math.trunc(result);
};
const plural = (value: number, singular: string, pluralValue: string): string =>
  `${value} ${value === 1 ? singular : pluralValue}`;
const percentage = (value: number): string =>
  value === Math.round(value) ? String(Math.round(value)) : value.toFixed(1);

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
      return object(json(ctx, "Wayfinder", response));
    };
    const health = await requestJSON("healthz");
    const models = await requestJSON("router/models");
    const savings = await requestJSON("v1/savings", ["period", "30d"]);
    if (!health || !models || !savings)
      throw ctx.fail.parseFailure("Wayfinder gateway response must be an object.");
    const routeMap = object(savings.by_route);
    if (!routeMap || !Array.isArray(models.models))
      throw ctx.fail.parseFailure("Wayfinder savings or models response was incomplete.");
    const routes = Object.entries(routeMap)
      .map(([name, value]) => {
        const route = object(value);
        return {
          name,
          requests: integer(route?.requests),
          saved: number(route?.saved) ?? 0,
          tokens: integer(route?.tokens),
        };
      })
      .sort((left, right) => right.requests - left.requests || left.name.localeCompare(right.name));
    const requests = integer(savings.requests);
    const saved = number(savings.saved) ?? 0;
    const savedPct = number(savings.saved_pct) ?? 0;
    const priced = savings.priced === true;
    const offline = health.offline === true;
    const dryRun = models.dry_run === true;
    const gatewayStatus = string(health.status) ?? "unknown";
    const missingKeys = Array.isArray(health.missing_keys)
      ? health.missing_keys.map(string).filter((item): item is string => Boolean(item))
      : [];
    let metrics: string | undefined;
    try {
      const response = await get(ctx, endpoint(base, "metrics").href, { timeoutSeconds: 5 });
      if (response.status >= 200 && response.status < 300) metrics = response.bodyText;
    } catch {
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
    const modelLabel = plural(models.models.length, "model", "models");
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
