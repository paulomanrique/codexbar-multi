import type {
  FirstPartyProvider,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { date, get, json, number, object, status } from "./_http.ts";
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
      ctx.settings.getSecret("LLM_PROXY_API_KEY") || ctx.settings.get("LLM_PROXY_API_KEY");
    const configured = ctx.settings.get("LLM_PROXY_BASE_URL");
    if (!key) throw ctx.fail.missingCredential("Missing LLM Proxy API key.");
    if (!configured) throw ctx.fail.missingCredential("Missing LLM Proxy base URL.");
    const base = configured.replace(/\/+$/, "").endsWith("/v1")
      ? configured.replace(/\/+$/, "")
      : `${configured.replace(/\/+$/, "")}/v1`;
    const response = await get(ctx, `${base}/quota-stats`, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    });
    status(ctx, "LLM Proxy", response);
    const root = object(json(ctx, "LLM Proxy", response));
    const providers = object(root?.providers);
    if (!root || !providers) throw ctx.fail.parseFailure("LLM Proxy providers are missing.");
    const summary = object(root.summary);
    let requests = number(summary?.total_requests);
    let tokens = number(summary?.total_tokens);
    let cost = number(summary?.approx_cost);
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
      if (!p) continue;
      const req = number(p.total_requests) ?? 0;
      const t = object(p.tokens);
      const tok =
        (number(t?.input_cached) ?? 0) +
        (number(t?.input_uncached) ?? 0) +
        (number(t?.output) ?? 0);
      const pcost = number(p.approx_cost);
      providerRequestTotal += req;
      providerTokenTotal += tok;
      credentialCount += number(p.credential_count) ?? 0;
      activeCount += number(p.active_count) ?? 0;
      exhaustedCount += number(p.exhausted_count) ?? 0;
      if (pcost !== undefined) {
        providerCostTotal += pcost;
        hasProviderCost = true;
      }
      const groups = Array.isArray(p.quota_groups)
        ? p.quota_groups
        : Object.values(object(p.quota_groups) ?? {});
      for (const group of groups) {
        const g = object(group);
        const remaining = number(g?.remaining_percent);
        if (remaining !== undefined && (minimum === undefined || remaining < minimum))
          minimum = remaining;
        const d = date(g?.reset_time, ctx);
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
