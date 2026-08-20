import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderResponse,
  ProviderStrategy,
} from "../types.ts";
import { json, number, object, string } from "./_http.ts";

type Dict = Record<string, unknown>;
const clean = (value: string | undefined): string | undefined => value?.trim() || undefined;
const csrf = (cookie: string): string | undefined =>
  /(?:^|;\s*)csrftoken=([^;\r\n]+)/iu.exec(cookie)?.[1]?.trim();
const adminHeaders = (cookie: string, token: string | undefined, referer: string) => ({
  Accept: "*/*",
  Cookie: cookie,
  Referer: referer,
  Origin: "https://admin.mistral.ai",
  ...(token ? { "X-CSRFTOKEN": token } : {}),
});
const response = (ctx: ProviderContext, raw: ProviderResponse, label: string): Dict => {
  if (raw.status === 401 || raw.status === 403)
    throw ctx.fail.authenticationExpired("Mistral session is invalid or expired.");
  if (raw.status < 200 || raw.status >= 300)
    throw ctx.fail.apiFailure(`Mistral ${label} returned HTTP ${raw.status}.`);
  const parsed = object(json(ctx, "Mistral", raw));
  if (!parsed) throw ctx.fail.parseFailure(`Mistral ${label} response must be an object.`);
  return parsed;
};
const entryCost = (entry: Dict, prices: Map<string, number>): number => {
  const metric = string(entry.billing_metric);
  const group = string(entry.billing_group);
  const units = number(entry.value_paid) ?? number(entry.value) ?? 0;
  const price = metric && group ? prices.get(`${metric}::${group}`) : undefined;
  const cost = units * (price ?? 0);
  return Number.isFinite(cost) ? cost : 0;
};
const allModels = (root: Dict): readonly [string, Dict][] => {
  const result: [string, Dict][] = [];
  const add = (models: unknown) => {
    const source = object(models);
    if (!source) return;
    for (const [name, raw] of Object.entries(source)) {
      const model = object(raw);
      if (model) result.push([name.split("::")[0] ?? name, model]);
    }
  };
  for (const category of ["completion", "ocr", "connectors", "audio"])
    add(object(root[category])?.models);
  const libraries = object(root.libraries_api);
  add(object(libraries?.pages)?.models);
  add(object(libraries?.tokens)?.models);
  const tuning = object(root.fine_tuning);
  add(tuning?.training);
  add(tuning?.storage);
  return result;
};
const usage = (ctx: ProviderContext, root: Dict) => {
  const prices = new Map<string, number>();
  if (Array.isArray(root.prices)) {
    for (const raw of root.prices) {
      const price = object(raw);
      const metric = string(price?.billing_metric);
      const group = string(price?.billing_group);
      const value = number(price?.price);
      if (metric && group && value !== undefined && Number.isFinite(value))
        prices.set(`${metric}::${group}`, value);
    }
  }
  let total = 0;
  let input = 0;
  let output = 0;
  let cached = 0;
  const daily = new Map<string, { cost: number; input: number; output: number; cached: number }>();
  for (const [, model] of allModels(root)) {
    for (const [kind, target] of [
      ["input", "input"],
      ["output", "output"],
      ["cached", "cached"],
    ] as const) {
      const entries = Array.isArray(model[kind]) ? model[kind] : [];
      for (const raw of entries) {
        const entry = object(raw);
        if (!entry) continue;
        const units = number(entry.value_paid) ?? number(entry.value) ?? 0;
        const cost = entryCost(entry, prices);
        if (Number.isFinite(total + cost)) total += cost;
        if (target === "input") input += units;
        else if (target === "output") output += units;
        else cached += units;
        const day = string(entry.timestamp)?.slice(0, 10);
        if (day) {
          const bucket = daily.get(day) ?? { cost: 0, input: 0, output: 0, cached: 0 };
          if (Number.isFinite(bucket.cost + cost)) bucket.cost += cost;
          bucket[target] += units;
          daily.set(day, bucket);
        }
      }
    }
  }
  const currency = string(root.currency)?.toUpperCase() || "XXX";
  const symbol =
    string(root.currency_symbol) ||
    (currency === "EUR" ? "€" : currency === "XXX" ? "¤" : currency);
  return {
    cost: Math.max(0, total),
    currency,
    symbol,
    input,
    output,
    cached,
    daily: [...daily.entries()].sort(([a], [b]) => a.localeCompare(b)),
  };
};
const consoleCookie = (cookie: string, token: string): string => {
  const sessions = cookie
    .split(";")
    .map((part) => part.trim())
    .filter((part) => /^ory_session_/iu.test(part));
  return [`csrftoken=${token}`, ...sessions].join("; ");
};

const definition: ProviderDefinition = {
  id: "mistral",
  name: "Mistral",
  endpoints: ["https://admin.mistral.ai", "https://console.mistral.ai"],
  settings: [{ key: "MISTRAL_COOKIE_HEADER", title: "Cookie header", type: "secure" }],
  capabilities: ["browser-cookies"],
  cookieDomains: ["admin.mistral.ai", "console.mistral.ai"],
  fetchUsage: async (ctx: ProviderContext) => {
    const cookie =
      clean(
        ctx.settings.getSecret("MISTRAL_COOKIE_HEADER") ??
          ctx.settings.get("MISTRAL_COOKIE_HEADER"),
      ) ?? clean(await ctx.browser.cookieHeader("admin.mistral.ai"));
    if (!cookie || !/(?:^|;\s*)ory_session_/iu.test(cookie))
      throw ctx.fail.missingCredential("Mistral requires an ory_session_* cookie header.");
    const csrfToken = csrf(cookie);
    const now = ctx.date.now();
    const request = await ctx.http.getJSON(
      `https://admin.mistral.ai/api/billing/v2/usage?month=${now.getUTCMonth() + 1}&year=${now.getUTCFullYear()}`,
      { headers: adminHeaders(cookie, csrfToken, "https://admin.mistral.ai/organization/usage") },
    );
    const root = response(ctx, request, "usage");
    const parsed = usage(ctx, root);
    let credits: number | undefined;
    let vibe: { usedPercent: number; resetsAt?: string } | undefined;
    // Both enrichments are deliberately best-effort, matching the Swift deadline policy.
    try {
      const creditResponse = await ctx.http.getJSON(
        "https://admin.mistral.ai/api/billing/credits",
        {
          headers: adminHeaders(cookie, csrfToken, "https://admin.mistral.ai/organization/billing"),
          timeoutSeconds: ctx.__codexbarOptionalRequestTimeoutSeconds ?? 4,
        },
      );
      if (creditResponse.status === 200) {
        const root = object(creditResponse.json);
        const amount =
          (number(root?.wallet_amount) ?? 0) +
          (number(root?.credit_notes_amount) ?? 0) -
          (number(root?.ongoing_usage_balance) ?? 0);
        if (Number.isFinite(amount)) credits = Math.max(0, amount);
      }
    } catch {
      // optional
    }
    if (csrfToken) {
      try {
        const vibeResponse = await ctx.http.getJSON(
          "https://console.mistral.ai/api-ui/trpc/billing.vibeUsage?batch=1&input=%7B%220%22%3A%7B%22json%22%3Anull%2C%22meta%22%3A%7B%22values%22%3A%5B%22undefined%22%5D%2C%22v%22%3A1%7D%7D%7D",
          {
            headers: {
              Accept: "*/*",
              Cookie: consoleCookie(cookie, csrfToken),
              "X-CSRFToken": csrfToken,
            },
            timeoutSeconds: ctx.__codexbarOptionalRequestTimeoutSeconds ?? 4,
          },
        );
        if (vibeResponse.status === 200 && Array.isArray(vibeResponse.json)) {
          const data = object(object(object(vibeResponse.json[0])?.result)?.data)?.json;
          const usedPercent = number(object(data)?.usagePercentage);
          const reset = string(object(data)?.resetAt);
          if (usedPercent !== undefined && usedPercent >= 0 && usedPercent <= 100)
            vibe = { usedPercent, ...(reset ? { resetsAt: ctx.date.iso(reset) } : {}) };
        }
      } catch {
        // optional
      }
    }
    return {
      cost: { used: parsed.cost, limit: 0, currency: parsed.currency, period: "This month" },
      ...(vibe
        ? {
            extraRateWindows: [{ id: "mistral-monthly-plan", title: "Monthly Plan", window: vibe }],
          }
        : {}),
      details: [
        {
          title: "API usage",
          rows: [
            { label: "Input tokens", value: ctx.format.number(parsed.input) },
            { label: "Output tokens", value: ctx.format.number(parsed.output) },
            { label: "Cached tokens", value: ctx.format.number(parsed.cached) },
            ...(credits === undefined
              ? []
              : [{ label: "Available credits", value: `${parsed.symbol}${credits.toFixed(2)}` }]),
          ],
          ...(parsed.daily.length
            ? {
                chart: {
                  kind: "bars" as const,
                  title: "Daily spend",
                  unit: parsed.currency,
                  points: parsed.daily
                    .slice(-128)
                    .map(([label, bucket]) => ({ label, value: bucket.cost })),
                },
              }
            : {}),
        },
      ],
      identity: { loginMethod: `API spend: ${parsed.symbol}${parsed.cost.toFixed(4)} this month` },
      dataConfidence: "exact" as const,
    };
  },
};

const strategy: ProviderStrategy = {
  id: "mistral.web",
  kind: "web",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const mistral: FirstPartyProvider = { ...strategy, descriptor };
