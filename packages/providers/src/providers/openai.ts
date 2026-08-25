import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";

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

class OpenAIHTTPError extends Error {
  readonly endpoint: string;
  readonly status: number;

  constructor(endpoint: string, status: number) {
    super(
      endpoint === "credit balance"
        ? status === 401
          ? "OpenAI rejected this key for credit balance access (HTTP 401). Use an organization Admin API key for usage; project and service-account keys do not provide organization usage access."
          : status === 403
            ? "OpenAI API credit balance endpoint returned HTTP 403. Use a legacy/user API key with billing access; project keys may not expose credit grants."
            : `OpenAI API credit balance error: HTTP ${status}`
        : `OpenAI API usage ${endpoint} error: HTTP ${status}`,
    );
    this.name = "OpenAIHTTPError";
    this.endpoint = endpoint;
    this.status = status;
  }

  get credentialRejected(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === "AbortError";

const definition: ProviderDefinition = {
  id: "openai",
  name: "OpenAI",
  endpoints: ["https://api.openai.com"],
  settings: [
    { key: "OPENAI_ADMIN_KEY", title: "Admin API key", type: "secure" },
    { key: "OPENAI_API_KEY", title: "API key", type: "secure" },
    { key: "OPENAI_PROJECT_ID", title: "Project ID", type: "plain" },
    { key: "OPENAI_HISTORY_DAYS", title: "History days", type: "plain" },
  ],

  fetchUsage: async (ctx: ProviderContext) => {
    const adminKey =
      clean(ctx.settings.getSecret("OPENAI_ADMIN_KEY")) ??
      clean(ctx.settings.get("OPENAI_ADMIN_KEY"));
    const legacyKey =
      clean(ctx.settings.getSecret("OPENAI_API_KEY")) ?? clean(ctx.settings.get("OPENAI_API_KEY"));
    const apiKey = adminKey ?? legacyKey;
    if (!apiKey) throw ctx.fail.missingCredential("Missing OpenAI API key.");
    const usesAdminKey = adminKey !== undefined;
    const projectID: any = clean(ctx.settings.get("OPENAI_PROJECT_ID"));
    const allowsLegacyBalanceFallback = projectID === undefined || !usesAdminKey;
    const usageRequestOptions = {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      timeoutSeconds: 20,
    };
    const balanceRequestOptions = {
      headers: usageRequestOptions.headers,
      timeoutSeconds: 15,
    };
    const rawHistoryDays: any = Number(ctx.settings.get("OPENAI_HISTORY_DAYS") || "30");
    const historyDays: any = Number.isInteger(rawHistoryDays)
      ? Math.max(1, Math.min(365, rawHistoryDays))
      : 30;

    function finite(value: any, field: any, optional: any) {
      if (optional && (value === null || value === undefined || value === "")) return null;
      const number: any =
        typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
      if (!Number.isFinite(number)) throw new Error(`OpenAI ${field} must be numeric`);
      return number;
    }
    function integer(value: any, field: any, optional: any) {
      const number: any = finite(value, field, optional);
      if (number === null) return null;
      if (!Number.isInteger(number)) throw new Error(`OpenAI ${field} must be an integer`);
      return number;
    }
    function name(value: any, fallback: any) {
      return typeof value === "string" && value.trim() ? value.trim() : fallback;
    }
    function usd(value: any) {
      return ctx.format.usd(Math.max(0, value));
    }
    function numberText(value: any) {
      return ctx.format.number(value, { maximumFractionDigits: 1 });
    }
    function queryURL(path: any, range: any, groupBy: any, page: any) {
      const query: any = [
        `start_time=${range.start}`,
        `end_time=${range.end}`,
        "bucket_width=1d",
        `limit=${range.limit}`,
        `group_by=${encodeURIComponent(groupBy)}`,
      ];
      if (projectID) query.push(`project_ids=${encodeURIComponent(projectID)}`);
      if (page) query.push(`page=${encodeURIComponent(page)}`);
      return `https://api.openai.com${path}?${query.join("&")}`;
    }
    function ranges() {
      const today: any = ctx.date.now();
      today.setUTCHours(0, 0, 0, 0);
      let cursor: any = Math.floor(today.getTime() / 1000) - (historyDays - 1) * 86400;
      let remaining: any = historyDays;
      const result: any = [];
      while (remaining > 0) {
        const limit: any = Math.min(31, remaining);
        result.push({ start: cursor, end: cursor + limit * 86400, limit });
        cursor += limit * 86400;
        remaining -= limit;
      }
      return result;
    }
    async function pages(path: any, groupBy: any, endpoint: string) {
      const buckets: any = [];
      for (const range of ranges()) {
        let page: any = null;
        const seen: any = new Set();
        for (let count = 0; count < 100; count += 1) {
          const response: any = await ctx.http.getJSON(
            queryURL(path, range, groupBy, page),
            usageRequestOptions,
          );
          if (response.status !== 200) throw new OpenAIHTTPError(endpoint, response.status);
          const body: any = response.json;
          if (
            !body ||
            typeof body !== "object" ||
            Array.isArray(body) ||
            !Array.isArray(body.data) ||
            typeof body.has_more !== "boolean"
          ) {
            throw new Error(`Failed to parse OpenAI ${path} page`);
          }
          buckets.push(...body.data);
          if (!body.has_more) break;
          if (typeof body.next_page !== "string" || !body.next_page.trim()) {
            throw new Error(`OpenAI ${path} pagination cursor missing`);
          }
          page = body.next_page.trim();
          if (seen.has(page)) throw new Error(`OpenAI ${path} pagination cursor repeated`);
          seen.add(page);
          if (count === 99) throw new Error(`OpenAI ${path} pagination exceeded 100 pages`);
        }
      }
      return buckets;
    }

    try {
      const costBuckets: any = await pages("/v1/organization/costs", "line_item", "costs");
      const completionBuckets: any = await pages(
        "/v1/organization/usage/completions",
        "model",
        "completions",
      );
      const daily: any = new Map();
      function bucket(raw: any) {
        if (
          !raw ||
          typeof raw !== "object" ||
          Array.isArray(raw) ||
          !Number.isInteger(raw.start_time) ||
          !Number.isInteger(raw.end_time) ||
          !Array.isArray(raw.results)
        ) {
          throw new Error("Failed to parse OpenAI usage bucket");
        }
        let value: any = daily.get(raw.start_time);
        if (!value) {
          value = {
            start: raw.start_time,
            end: raw.end_time,
            cost: 0,
            requests: 0,
            input: 0,
            cached: 0,
            output: 0,
            tokens: 0,
            models: new Map(),
            lines: new Map(),
          };
          daily.set(raw.start_time, value);
        }
        return value;
      }
      for (const raw of costBuckets) {
        const day: any = bucket(raw);
        for (const item of raw.results) {
          if (!item || typeof item !== "object")
            throw new Error("Failed to parse OpenAI cost result");
          const amount: any = item.amount ? finite(item.amount.value, "cost amount", true) || 0 : 0;
          day.cost += amount;
          const line: any = name(item.line_item, "API");
          day.lines.set(line, (day.lines.get(line) || 0) + amount);
        }
      }
      for (const raw of completionBuckets) {
        const day: any = bucket(raw);
        for (const item of raw.results) {
          if (!item || typeof item !== "object")
            throw new Error("Failed to parse OpenAI completion result");
          const input: any = integer(item.input_tokens, "input_tokens", true) || 0;
          const cached: any = integer(item.input_cached_tokens, "input_cached_tokens", true) || 0;
          const audioInput: any = integer(item.input_audio_tokens, "input_audio_tokens", true) || 0;
          const output: any = integer(item.output_tokens, "output_tokens", true) || 0;
          const audioOutput: any =
            integer(item.output_audio_tokens, "output_audio_tokens", true) || 0;
          const requests: any = integer(item.num_model_requests, "num_model_requests", true) || 0;
          const tokens: any = input + audioInput + output + audioOutput;
          day.requests += requests;
          day.input += input + audioInput;
          day.cached += cached;
          day.output += output + audioOutput;
          day.tokens += tokens;
          const modelName: any = name(item.model, "Responses and Chat Completions");
          const model: any = day.models.get(modelName) || { requests: 0, tokens: 0 };
          model.requests += requests;
          model.tokens += tokens;
          day.models.set(modelName, model);
        }
      }
      const days: any = Array.from((daily as any).values()).sort(
        (a: any, b: any) => a.start - b.start,
      );
      const totals: any = days.reduce(
        (sum: any, day: any) => {
          sum.cost += day.cost;
          sum.requests += day.requests;
          sum.input += day.input;
          sum.cached += day.cached;
          sum.output += day.output;
          sum.tokens += day.tokens;
          return sum;
        },
        { cost: 0, requests: 0, input: 0, cached: 0, output: 0, tokens: 0 },
      );
      const models: any = new Map();
      const lines: any = new Map();
      for (const day of days) {
        for (const [modelName, value] of day.models) {
          const model: any = models.get(modelName) || { requests: 0, tokens: 0 };
          model.requests += value.requests;
          model.tokens += value.tokens;
          models.set(modelName, model);
        }
        for (const [line, cost] of day.lines) lines.set(line, (lines.get(line) || 0) + cost);
      }
      const topModels: any = Array.from(models.entries()).sort(
        (a: any, b: any) => b[1].tokens - a[1].tokens || a[0].localeCompare(b[0]),
      );
      const topLines: any = Array.from(lines.entries()).sort(
        (a: any, b: any) => b[1] - a[1] || a[0].localeCompare(b[0]),
      );
      const chartDays: any = days.slice(-120);
      const summaryRows: any = [
        { label: "Spend", value: usd(totals.cost), secondaryValue: `Last ${historyDays} days` },
        { label: "Requests", value: numberText(totals.requests) },
        {
          label: "Tokens",
          value: numberText(totals.tokens),
          secondaryValue: `${numberText(totals.input)} input · ${numberText(totals.output)} output`,
        },
        { label: "Cached input", value: numberText(totals.cached) },
      ];
      if (days.length > chartDays.length) {
        summaryRows.push({ label: "Chart range", value: `Last ${chartDays.length} days` });
      }
      const details: any = [
        {
          title: "Usage summary",
          rows: summaryRows,
          chart: {
            kind: "bars",
            title: "Daily spend",
            unit: "USD",
            points: chartDays.map((day: any) => ({
              label: new Date(day.start * 1000).toISOString().slice(0, 10),
              value: day.cost,
            })),
          },
        },
      ];
      if (topModels.length) {
        details.push({
          title: "Models",
          rows: topModels.slice(0, 24).map((item: any) => ({
            label: item[0],
            value: `${numberText(item[1].tokens)} tokens`,
            secondaryValue: `${item[1].requests} requests`,
          })),
        });
      }
      if (topLines.length) {
        details.push({
          title: "Line items",
          rows: topLines.slice(0, 24).map((item: any) => ({ label: item[0], value: usd(item[1]) })),
        });
      }
      const identity: any = { loginMethod: projectID ? `Admin API: ${projectID}` : "Admin API" };
      if (projectID) identity.organization = `Project: ${projectID}`;
      return {
        cost: {
          used: totals.cost,
          currency: "USD",
          period: historyDays === 1 ? "Today" : `Last ${historyDays} days`,
        },
        identity,
        details,
      };
    } catch (usageError) {
      if (isAbortError(usageError) || !allowsLegacyBalanceFallback) throw usageError;
      try {
        const response: any = await ctx.http.getJSON(
          "https://api.openai.com/v1/dashboard/billing/credit_grants",
          balanceRequestOptions,
        );
        if (response.status !== 200) {
          throw new OpenAIHTTPError("credit balance", response.status);
        }
        const body: any = response.json;
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          throw new Error("Failed to parse OpenAI credit_grants response");
        }
        const requiredBillingNumber = (value: unknown, field: string): number => {
          if (typeof value !== "number" || !Number.isFinite(value)) {
            throw new Error(`OpenAI ${field} must be numeric`);
          }
          return value;
        };
        const optionalBillingNumber = (value: unknown, field: string): number | null => {
          if (value === null || value === undefined) return null;
          return requiredBillingNumber(value, field);
        };
        const granted = requiredBillingNumber(body.total_granted, "total_granted");
        const used = requiredBillingNumber(body.total_used, "total_used");
        const available = requiredBillingNumber(body.total_available, "total_available");
        const nowMillis = ctx.date.now().getTime();
        let grantRows: readonly unknown[] = [];
        if (body.grants !== null && body.grants !== undefined) {
          if (
            typeof body.grants !== "object" ||
            Array.isArray(body.grants) ||
            !Array.isArray(body.grants.data)
          ) {
            throw new Error("Failed to parse OpenAI credit_grants response");
          }
          grantRows = body.grants.data;
        }
        const futureExpiries = grantRows
          .map((raw, index) => {
            if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
              throw new Error(`OpenAI grants.data[${index}] must be an object`);
            }
            const item = raw as Record<string, unknown>;
            optionalBillingNumber(item.grant_amount, "grant_amount");
            optionalBillingNumber(item.used_amount, "used_amount");
            return optionalBillingNumber(item.expires_at, "expires_at");
          })
          .filter((value): value is number => value !== null && value * 1000 > nowMillis)
          .sort((a, b) => a - b);
        const nextExpiry = futureExpiries.at(0);
        const resetsAt = nextExpiry === undefined ? null : ctx.date.unixSeconds(nextExpiry);
        const primary: any = {
          usedPercent: granted > 0 ? ctx.pct(used, granted) : available > 0 ? 0 : 100,
          resetDescription: `${usd(available)} available`,
        };
        if (resetsAt) primary.resetsAt = resetsAt;
        const cost: any = {
          used: Math.max(0, used),
          limit: Math.max(0, granted),
          currency: "USD",
          period: "API credits",
        };
        if (resetsAt) cost.resetsAt = resetsAt;
        return {
          primary,
          cost,
          identity: { loginMethod: `API balance: ${usd(available)}` },
          details: [
            {
              title: "API credits",
              rows: [
                { label: "Available", value: usd(available) },
                { label: "Used", value: usd(used) },
                { label: "Granted", value: usd(granted) },
              ],
            },
          ],
        };
      } catch (balanceError) {
        if (isAbortError(balanceError)) throw balanceError;
        if (usageError instanceof OpenAIHTTPError && usageError.credentialRejected) {
          throw balanceError;
        }
        throw usageError;
      }
    }
  },
};
const strategy: ProviderStrategy = {
  id: "openai.api",
  kind: "api",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const openai: FirstPartyProvider = { ...strategy, descriptor };
