import type {
  FirstPartyProvider,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { normalizeEndpoint } from "@codexbar/core";
import { date, get, json, object } from "./_http.ts";

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

const definition: ProviderDefinition = {
  id: "llmproxy",
  name: "LLM Proxy",
  endpoints: [{ setting: "LLM_PROXY_BASE_URL", policy: "https-or-private-network-http" }],
  auth: { type: "bearer", secret: "LLM_PROXY_API_KEY" },
  settings: [
    { key: "LLM_PROXY_API_KEY", title: "API key", type: "secure" },
    { key: "LLM_PROXY_BASE_URL", title: "Base URL", type: "plain" },
  ],
  fetchUsage: async (ctx) => {
    const key =
      clean(ctx.settings.getSecret("LLM_PROXY_API_KEY")) ??
      clean(ctx.settings.get("LLM_PROXY_API_KEY"));
    const configured = clean(ctx.settings.get("LLM_PROXY_BASE_URL"));
    if (!key) throw ctx.fail.missingCredential("Missing LLM Proxy API key.");
    if (!configured) throw ctx.fail.missingCredential("Missing LLM Proxy base URL.");
    const endpoint = normalizeEndpoint(configured, { transport: "private-network-http" });
    if (endpoint === undefined) {
      throw ctx.fail.apiFailure(
        "LLM Proxy endpoint override LLM_PROXY_BASE_URL must use HTTPS or private-network HTTP.",
      );
    }
    const quotaURL = new URL(endpoint.href);
    const rootPath = quotaURL.pathname.replace(/\/+$/u, "");
    quotaURL.pathname = rootPath.endsWith("/v1")
      ? `${rootPath}/quota-stats`
      : `${rootPath}/v1/quota-stats`;
    const response = await get(ctx, quotaURL.href, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    });
    if (response.status < 200 || response.status >= 300) {
      const summary = response.bodyText.slice(0, 500).trim();
      throw ctx.fail.apiFailure(
        `LLM Proxy API returned HTTP ${response.status}${summary === "" ? "" : `: ${summary}`}.`,
      );
    }
    const root = object(json(ctx, "LLM Proxy", response));
    const providers = object(root?.providers);
    if (!root || !providers) throw ctx.fail.parseFailure("LLM Proxy providers are missing.");
    const optionalNumber = (value: unknown, field: string): number | undefined => {
      if (value === null || value === undefined) return undefined;
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw ctx.fail.parseFailure(`LLM Proxy ${field} must be a number.`);
      }
      return value;
    };
    const optionalInteger = (value: unknown, field: string): number | undefined => {
      const parsed = optionalNumber(value, field);
      if (parsed !== undefined && !Number.isInteger(parsed)) {
        throw ctx.fail.parseFailure(`LLM Proxy ${field} must be an integer.`);
      }
      return parsed;
    };
    const summary = object(root.summary);
    if (root.summary !== null && root.summary !== undefined && summary === undefined) {
      throw ctx.fail.parseFailure("LLM Proxy summary must be an object.");
    }
    let requests = optionalInteger(summary?.total_requests, "summary.total_requests");
    let tokens = optionalInteger(summary?.total_tokens, "summary.total_tokens");
    let cost = optionalNumber(summary?.approx_cost, "summary.approx_cost");
    let providerRequestTotal = 0;
    let providerTokenTotal = 0;
    let providerCostTotal = 0;
    let hasProviderCost = false;
    let credentialCount = 0;
    let activeCount = 0;
    let exhaustedCount = 0;
    let minimum: number | undefined;
    let reset: string | undefined;
    const rows: Array<{
      readonly id: string;
      readonly requests: number;
      readonly tokens: number;
      readonly cost?: number;
    }> = [];
    for (const [name, raw] of Object.entries(providers)) {
      const p = object(raw);
      if (!p) throw ctx.fail.parseFailure(`LLM Proxy provider ${name} must be an object.`);
      const req = optionalInteger(p.total_requests, `${name}.total_requests`) ?? 0;
      const t = object(p.tokens);
      if (p.tokens !== null && p.tokens !== undefined && t === undefined) {
        throw ctx.fail.parseFailure(`LLM Proxy provider ${name}.tokens must be an object.`);
      }
      const tok =
        (optionalInteger(t?.input_cached, `${name}.tokens.input_cached`) ?? 0) +
        (optionalInteger(t?.input_uncached, `${name}.tokens.input_uncached`) ?? 0) +
        (optionalInteger(t?.output, `${name}.tokens.output`) ?? 0);
      const pcost = optionalNumber(p.approx_cost, `${name}.approx_cost`);
      providerRequestTotal += req;
      providerTokenTotal += tok;
      credentialCount += optionalInteger(p.credential_count, `${name}.credential_count`) ?? 0;
      activeCount += optionalInteger(p.active_count, `${name}.active_count`) ?? 0;
      exhaustedCount += optionalInteger(p.exhausted_count, `${name}.exhausted_count`) ?? 0;
      if (pcost !== undefined) {
        providerCostTotal += pcost;
        hasProviderCost = true;
      }
      const groups = Array.isArray(p.quota_groups)
        ? p.quota_groups
        : Object.values(object(p.quota_groups) ?? {});
      const decodedGroups = groups.map((group) => object(group));
      const groupsAreValid = decodedGroups.every(
        (group) =>
          group !== undefined &&
          (group.remaining_percent === null ||
            group.remaining_percent === undefined ||
            (typeof group.remaining_percent === "number" &&
              Number.isFinite(group.remaining_percent))) &&
          (group.reset_time === null ||
            group.reset_time === undefined ||
            typeof group.reset_time === "string"),
      );
      for (const g of groupsAreValid ? decodedGroups : []) {
        if (g === undefined) continue;
        const remaining = optionalNumber(g.remaining_percent, `${name}.remaining_percent`);
        if (remaining !== undefined && (minimum === undefined || remaining < minimum))
          minimum = remaining;
        let d: string | undefined;
        try {
          d = date(g.reset_time, ctx);
        } catch {
          d = undefined;
        }
        if (d && d > ctx.date.now().toISOString() && (!reset || d < reset)) reset = d;
      }
      rows.push({
        id: name,
        requests: req,
        tokens: tok,
        ...(pcost === undefined ? {} : { cost: pcost }),
      });
    }
    rows.sort((left, right) => right.requests - left.requests || left.id.localeCompare(right.id));
    requests ??= providerRequestTotal;
    tokens ??= providerTokenTotal;
    if (cost === undefined && hasProviderCost && providerCostTotal > 0) cost = providerCostTotal;
    const result: Record<string, unknown> = {
      primary:
        minimum === undefined
          ? undefined
          : {
              usedPercent: Math.max(0, Math.min(100, 100 - minimum)),
              resetsAt: reset,
            },
      secondary: {
        usedPercent: 0,
        resetDescription: `${(requests ?? 0).toLocaleString("en-US")} requests`,
      },
      tertiary: {
        usedPercent: 0,
        resetDescription: `${(tokens ?? 0).toLocaleString("en-US")} tokens`,
      },
      extraRateWindows: rows.slice(0, 3).map((row) => ({
        id: row.id,
        title: row.id,
        window: {
          usedPercent: 0,
          resetDescription: `${row.requests.toLocaleString("en-US")} req · ${row.tokens.toLocaleString("en-US")} tok${row.cost === undefined ? "" : ` · $${row.cost.toFixed(2)}`}`,
        },
      })),
      identity: {
        organization: `${activeCount}/${credentialCount} active keys`,
        loginMethod: "quota-stats",
      },
    };
    if (cost !== undefined)
      result.cost = {
        used: cost,
        limit: 0,
        currency: "USD",
        period: "Approx. spend",
        resetsAt: reset,
      };
    return result;
  },
};
const strategy: ProviderStrategy = {
  id: "llmproxy.api",
  kind: "api",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const llmproxy: FirstPartyProvider = { ...strategy, descriptor };
