import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
const definition: ProviderDefinition = {
  id: "clawrouter",
  name: "ClawRouter",
  endpoints: [
    "https://clawrouter.openclaw.ai",
    { setting: "CLAWROUTER_BASE_URL", policy: "https" },
  ],
  auth: { type: "bearer", secret: "CLAWROUTER_API_KEY" },
  settings: [
    {
      key: "CLAWROUTER_API_KEY",
      title: "API key",
      subtitle: "ClawRouter policy key used for the usage ledger.",
      type: "secure",
    },
    { key: "CLAWROUTER_BASE_URL", title: "Base URL", type: "plain" },
  ],

  fetchUsage: async (ctx: ProviderContext) => {
    let base: any = (
      ctx.settings.get("CLAWROUTER_BASE_URL") || "https://clawrouter.openclaw.ai"
    ).replace(/\/+$/, "");
    if (!base.endsWith("/v1")) base += "/v1";
    const response: any = await ctx.http.get(`${base}/usage`);
    if (response.status === 401 || response.status === 403) {
      throw ctx.fail.authenticationExpired(
        "ClawRouter rejected the API key. Check the key and its policy status.",
      );
    }
    if (response.status === 429) throw ctx.fail.rateLimited("ClawRouter API returned HTTP 429.");
    if (response.status >= 500) {
      throw ctx.fail.providerUnavailable(`ClawRouter API returned HTTP ${response.status}.`);
    }
    if (response.status < 200 || response.status >= 300) {
      throw ctx.fail.apiFailure(`ClawRouter API returned HTTP ${response.status}.`);
    }
    let payload;
    try {
      payload = JSON.parse(response.bodyText);
    } catch {
      throw ctx.fail.parseFailure("Could not parse ClawRouter usage: response was not valid JSON");
    }
    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      !payload.budget ||
      !payload.usage ||
      !payload.usage.summary ||
      !Array.isArray(payload.usage.providers)
    ) {
      throw ctx.fail.parseFailure("Could not parse ClawRouter usage: response shape is invalid");
    }

    function integer(value: any, field: any) {
      if (!Number.isInteger(value)) {
        throw ctx.fail.parseFailure(
          `Could not parse ClawRouter usage: ${field} must be an integer`,
        );
      }
      return value;
    }
    function micros(value: any, field: any, optional: any) {
      if (optional && (value === null || value === undefined)) return null;
      return integer(value, field) / 1000000;
    }
    function monthlyReset(windowKey: any) {
      if (typeof windowKey !== "string") return null;
      const match: any = windowKey.match(/(\d{4})-(\d{2})$/);
      if (!match) return null;
      let year: any = Number(match[1]);
      let month: any = Number(match[2]) + 1;
      if (month === 13) {
        year += 1;
        month = 1;
      }
      return ctx.date.iso(`${year}-${String(month).padStart(2, "0")}-01T00:00:00Z`);
    }

    const budget: any = payload.budget;
    if (typeof budget.configured !== "boolean" || typeof budget.ledger !== "string") {
      throw ctx.fail.parseFailure("Could not parse ClawRouter usage: budget is invalid");
    }
    const limit: any = micros(budget.limitMicros, "budget.limitMicros", true);
    const spent: any = micros(budget.spentMicros, "budget.spentMicros", true);
    const remaining: any = micros(budget.remainingMicros, "budget.remainingMicros", true);
    const resetsAt: any = monthlyReset(budget.windowKey);
    const summary: any = payload.usage.summary;
    const requestCount: any = integer(summary.requestCount, "summary.requestCount");
    const successCount: any = integer(summary.successCount, "summary.successCount");
    const errorCount: any = integer(summary.errorCount, "summary.errorCount");
    const inputTokens: any = integer(summary.inputTokens, "summary.inputTokens");
    const outputTokens: any = integer(summary.outputTokens, "summary.outputTokens");
    const totalTokens: any = integer(summary.totalTokens, "summary.totalTokens");
    const actualCost: any = micros(summary.actualCostMicros, "summary.actualCostMicros", false);

    const providers: any = payload.usage.providers
      .map((item: any) => {
        if (!item || typeof item.provider !== "string") {
          throw ctx.fail.parseFailure(
            "Could not parse ClawRouter usage: provider name must be a string",
          );
        }
        return {
          provider: item.provider.trim() || "Unknown",
          requests: integer(item.requestCount, "provider.requestCount"),
          success: integer(item.successCount, "provider.successCount"),
          errors: integer(item.errorCount, "provider.errorCount"),
          tokens: integer(item.totalTokens, "provider.totalTokens"),
          cost: micros(item.actualCostMicros, "provider.actualCostMicros", false),
        };
      })
      .sort(
        (a: any, b: any) =>
          b.cost - a.cost || b.requests - a.requests || a.provider.localeCompare(b.provider),
      );

    const result: any = {
      dataConfidence: "exact",
      identity: {
        organization: `${providers.length} routed providers`,
        loginMethod: budget.configured ? "Managed monthly budget" : "Unmetered",
      },
      details: [
        {
          title: "Usage",
          rows: [
            {
              label: "Requests",
              value: String(requestCount),
              secondaryValue: `${successCount} succeeded · ${errorCount} failed`,
            },
            {
              label: "Tokens",
              value: String(totalTokens),
              secondaryValue: `${inputTokens} input · ${outputTokens} output`,
            },
            { label: "Actual cost", value: `$${actualCost.toFixed(6)}` },
            { label: "Budget ledger", value: budget.ledger },
          ],
        },
      ],
    };

    if (spent !== null && limit !== null) {
      if (limit > 0) {
        result.primary = { usedPercent: ctx.pct(spent, limit) };
        if (resetsAt) result.primary.resetsAt = resetsAt;
      }
      result.cost = { used: spent, limit, currency: "USD", period: "This month" };
      if (resetsAt) result.cost.resetsAt = resetsAt;
      result.details[0].rows.push({
        label: "Monthly budget",
        value: `$${spent.toFixed(6)} / $${limit.toFixed(2)}`,
        secondaryValue: remaining === null ? undefined : `$${remaining.toFixed(6)} remaining`,
      });
    } else if (actualCost > 0) {
      result.cost = { used: actualCost, currency: "USD", period: "This month" };
      if (resetsAt) result.cost.resetsAt = resetsAt;
    }

    if (providers.length) {
      let visible: any = providers;
      if (providers.length > 119) {
        const kept: any = providers.slice(0, 119);
        const other: any = providers.slice(119).reduce((sum: any, item: any) => sum + item.cost, 0);
        visible = kept.concat([{ provider: "Other", cost: other }]);
      }
      result.details.push({
        title: "Routed providers",
        rows: providers.slice(0, 20).map((item: any) => ({
          label: item.provider,
          value: `${item.requests} requests`,
          secondaryValue: `$${item.cost.toFixed(6)} · ${item.tokens} tokens`,
        })),
        chart: {
          kind: "bars",
          title: "Provider cost",
          unit: "USD",
          points: visible.map((item: any) => ({ label: item.provider, value: item.cost })),
        },
      });
    }
    return result;
  },
};
const strategy: ProviderStrategy = {
  id: "clawrouter.api",
  kind: "api",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const clawrouter: FirstPartyProvider = { ...strategy, descriptor };
