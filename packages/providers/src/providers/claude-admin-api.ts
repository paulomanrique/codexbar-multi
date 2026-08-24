import type { ProviderContext, ProviderJSONResponse } from "../types.ts";
import { object, string } from "./_http.ts";

const costReportURL = "https://api.anthropic.com/v1/organizations/cost_report";
const messagesUsageURL = "https://api.anthropic.com/v1/organizations/usage_report/messages";
const maxDailyBuckets = 31;
const anthropicVersion = "2023-06-01";
const userAgent = "CodexBar/1.0";

type DateRange = {
  readonly startingAt: string;
  readonly endingAt: string;
};

type CostBreakdown = {
  readonly name: string;
  readonly costUSD: number;
};

type ModelBreakdown = {
  readonly name: string;
  readonly inputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
};

type DailyBucket = {
  readonly day: string;
  readonly startTime: Date;
  readonly endTime: Date;
  readonly costUSD: number;
  readonly inputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly costItems: readonly CostBreakdown[];
  readonly models: readonly ModelBreakdown[];
};

type Summary = {
  readonly costUSD: number;
  readonly inputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
};

type DailyAccumulator = {
  readonly startingAt: string;
  readonly endingAt: string;
  costUSD: number;
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  readonly costItems: Map<string, number>;
  readonly models: Map<string, ModelAccumulator>;
};

type ModelAccumulator = {
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export const cleanClaudeAdminAPIKey = (raw: string | undefined): string | undefined => {
  let trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === "") return undefined;
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  return trimmed === "" ? undefined : trimmed;
};

export const normalizeClaudeAdminAPIKey = (raw: string | undefined): string | undefined => {
  const trimmed = cleanClaudeAdminAPIKey(raw);
  if (trimmed === undefined) return undefined;
  const lower = trimmed.toLowerCase();
  if (lower.includes("cookie:") || trimmed.includes("=")) return undefined;
  if (lower.startsWith("bearer ")) {
    const bearerTrimmed = trimmed.slice("bearer ".length).trim();
    return bearerTrimmed.toLowerCase().startsWith("sk-ant-admin") ? bearerTrimmed : undefined;
  }
  return lower.startsWith("sk-ant-admin") ? trimmed : undefined;
};

export const claudeAdminDailyRange = (now: Date): DateRange => {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const start = new Date(today - (maxDailyBuckets - 1) * 86_400_000);
  const end = new Date(today + 86_400_000);
  return {
    startingAt: start.toISOString().replace(".000Z", "Z"),
    endingAt: end.toISOString().replace(".000Z", "Z"),
  };
};

export const claudeAdminURL = (endpoint: "cost" | "messages", range: DateRange): string => {
  const url = new URL(endpoint === "cost" ? costReportURL : messagesUsageURL);
  url.searchParams.set("starting_at", range.startingAt);
  url.searchParams.set("ending_at", range.endingAt);
  url.searchParams.set("bucket_width", "1d");
  url.searchParams.set("limit", String(maxDailyBuckets));
  url.searchParams.append("group_by[]", endpoint === "cost" ? "description" : "model");
  return url.href;
};

const adminHeaders = (apiKey: string): Readonly<Record<string, string>> => ({
  "x-api-key": apiKey,
  "anthropic-version": anthropicVersion,
  Accept: "application/json",
  "User-Agent": userAgent,
});

const adminStatus = (
  ctx: ProviderContext,
  endpoint: "cost_report" | "messages",
  response: ProviderJSONResponse,
): void => {
  if (response.status === 200) return;
  const message = `Claude Admin API ${endpoint} returned HTTP ${response.status}.`;
  if (response.status === 401) throw ctx.fail.authenticationExpired(message);
  if (response.status === 403) throw ctx.fail.permissionDenied(message);
  if (response.status === 429) throw ctx.fail.rateLimited(message);
  throw ctx.fail.apiFailure(message);
};

const rfc3339InternetDate = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|[+-]\d{2}:\d{2})$/u;

const parseDate = (value: unknown): Date | undefined => {
  const raw = string(value);
  if (raw === undefined) return undefined;
  const match = rfc3339InternetDate.exec(raw);
  if (match === null) return undefined;
  const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw, zone] = match;
  if (
    yearRaw === undefined ||
    monthRaw === undefined ||
    dayRaw === undefined ||
    hourRaw === undefined ||
    minuteRaw === undefined ||
    secondRaw === undefined ||
    zone === undefined
  )
    return undefined;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const second = Number(secondRaw);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    return undefined;
  if (zone !== "Z") {
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return undefined;
  }
  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) ? parsed : undefined;
};

const dayKey = (date: Date): string => date.toISOString().slice(0, 10);

const displayName = (raw: unknown, fallback: string): string => string(raw) ?? fallback;

const amountFromLowestUSDUnit = (value: unknown, ctx: ProviderContext): number => {
  if (typeof value !== "string") {
    throw ctx.fail.parseFailure("Claude Admin API cost_report amount has an invalid shape.");
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const optionalIntegerFrom = (value: unknown, ctx: ProviderContext, field: string): number => {
  if (value == null) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw ctx.fail.parseFailure(`Claude Admin API messages ${field} has an invalid shape.`);
  }
  return value;
};

const optionalObjectFrom = (value: unknown, ctx: ProviderContext, field: string) => {
  if (value == null) return undefined;
  const parsed = object(value);
  if (parsed === undefined) {
    throw ctx.fail.parseFailure(`Claude Admin API messages ${field} has an invalid shape.`);
  }
  return parsed;
};

const optionalStringFrom = (
  value: unknown,
  ctx: ProviderContext,
  field: string,
): string | undefined => {
  if (value == null) return undefined;
  if (typeof value !== "string") {
    throw ctx.fail.parseFailure(`Claude Admin API ${field} has an invalid shape.`);
  }
  return string(value);
};

const requiredData = (
  value: unknown,
  ctx: ProviderContext,
  endpoint: "cost_report" | "messages",
): readonly unknown[] => {
  const root = object(value);
  if (!root || !Array.isArray(root.data)) {
    throw ctx.fail.parseFailure(`Claude Admin API ${endpoint} response has an invalid shape.`);
  }
  return root.data;
};

const accumulatorFor = (
  accumulators: Map<string, DailyAccumulator>,
  startingAt: string,
  endingAt: string,
): DailyAccumulator => {
  const existing = accumulators.get(startingAt);
  if (existing !== undefined) return existing;
  const created: DailyAccumulator = {
    startingAt,
    endingAt,
    costUSD: 0,
    inputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costItems: new Map(),
    models: new Map(),
  };
  accumulators.set(startingAt, created);
  return created;
};

const modelFor = (models: Map<string, ModelAccumulator>, name: string): ModelAccumulator => {
  const existing = models.get(name);
  if (existing !== undefined) return existing;
  const created: ModelAccumulator = {
    inputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
  models.set(name, created);
  return created;
};

const sortedCostItems = (items: Map<string, number>): readonly CostBreakdown[] =>
  [...items.entries()]
    .map(([name, costUSD]) => ({ name, costUSD }))
    .sort((a, b) => b.costUSD - a.costUSD || compareNames(a.name, b.name));

const compareNames = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const sortedModels = (models: Map<string, ModelAccumulator>): readonly ModelBreakdown[] =>
  [...models.entries()]
    .map(([name, model]) => ({ name, ...model }))
    .sort((a, b) => b.totalTokens - a.totalTokens || compareNames(a.name, b.name));

const makeDailyBucket = (accumulator: DailyAccumulator): DailyBucket | undefined => {
  const start = parseDate(accumulator.startingAt);
  const end = parseDate(accumulator.endingAt);
  if (start === undefined || end === undefined) return undefined;
  return {
    day: dayKey(start),
    startTime: start,
    endTime: end,
    costUSD: accumulator.costUSD,
    inputTokens: accumulator.inputTokens,
    cacheCreationInputTokens: accumulator.cacheCreationInputTokens,
    cacheReadInputTokens: accumulator.cacheReadInputTokens,
    outputTokens: accumulator.outputTokens,
    totalTokens: accumulator.totalTokens,
    costItems: sortedCostItems(accumulator.costItems),
    models: sortedModels(accumulator.models),
  };
};

const emptySummary: Summary = {
  costUSD: 0,
  inputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
};

const summarize = (daily: readonly DailyBucket[]): Summary =>
  daily.reduce(
    (total, day) => ({
      costUSD: total.costUSD + day.costUSD,
      inputTokens: total.inputTokens + day.inputTokens,
      cacheCreationInputTokens: total.cacheCreationInputTokens + day.cacheCreationInputTokens,
      cacheReadInputTokens: total.cacheReadInputTokens + day.cacheReadInputTokens,
      outputTokens: total.outputTokens + day.outputTokens,
      totalTokens: total.totalTokens + day.totalTokens,
    }),
    emptySummary,
  );

const topModels = (daily: readonly DailyBucket[]): readonly ModelBreakdown[] => {
  const totals = new Map<string, ModelAccumulator>();
  for (const day of daily) {
    for (const model of day.models) {
      const total = modelFor(totals, model.name);
      total.inputTokens += model.inputTokens;
      total.cacheCreationInputTokens += model.cacheCreationInputTokens;
      total.cacheReadInputTokens += model.cacheReadInputTokens;
      total.outputTokens += model.outputTokens;
      total.totalTokens += model.totalTokens;
    }
  }
  return sortedModels(totals);
};

const topCostItems = (daily: readonly DailyBucket[]): readonly CostBreakdown[] => {
  const totals = new Map<string, number>();
  for (const day of daily) {
    for (const item of day.costItems) {
      totals.set(item.name, (totals.get(item.name) ?? 0) + item.costUSD);
    }
  }
  return sortedCostItems(totals);
};

const countString = (ctx: ProviderContext, value: number): string =>
  ctx.format.number(value, { maximumFractionDigits: 0 });

export const parseClaudeAdminAPIUsage = (
  costsPayload: unknown,
  messagesPayload: unknown,
  ctx: ProviderContext,
) => {
  const accumulators = new Map<string, DailyAccumulator>();

  for (const bucketValue of requiredData(costsPayload, ctx, "cost_report")) {
    const bucket = object(bucketValue);
    if (!bucket || !Array.isArray(bucket.results)) {
      throw ctx.fail.parseFailure("Claude Admin API cost_report bucket has an invalid shape.");
    }
    const startingAt = string(bucket.starting_at);
    const endingAt = string(bucket.ending_at);
    if (startingAt === undefined || endingAt === undefined) {
      throw ctx.fail.parseFailure("Claude Admin API cost_report bucket is missing dates.");
    }
    const accumulator = accumulatorFor(accumulators, startingAt, endingAt);
    for (const resultValue of bucket.results) {
      const result = object(resultValue);
      if (!result) {
        throw ctx.fail.parseFailure("Claude Admin API cost_report result has an invalid shape.");
      }
      const value = amountFromLowestUSDUnit(result.amount, ctx) / 100;
      accumulator.costUSD += value;
      const description = optionalStringFrom(result.description, ctx, "cost_report description");
      const costType = optionalStringFrom(result.cost_type, ctx, "cost_report cost_type");
      const name = displayName(description, displayName(costType, "Claude API"));
      accumulator.costItems.set(name, (accumulator.costItems.get(name) ?? 0) + value);
    }
  }

  for (const bucketValue of requiredData(messagesPayload, ctx, "messages")) {
    const bucket = object(bucketValue);
    if (!bucket || !Array.isArray(bucket.results)) {
      throw ctx.fail.parseFailure("Claude Admin API messages bucket has an invalid shape.");
    }
    const startingAt = string(bucket.starting_at);
    const endingAt = string(bucket.ending_at);
    if (startingAt === undefined || endingAt === undefined) {
      throw ctx.fail.parseFailure("Claude Admin API messages bucket is missing dates.");
    }
    const accumulator = accumulatorFor(accumulators, startingAt, endingAt);
    for (const resultValue of bucket.results) {
      const result = object(resultValue);
      if (!result) {
        throw ctx.fail.parseFailure("Claude Admin API messages result has an invalid shape.");
      }
      const cacheCreation = optionalObjectFrom(result.cache_creation, ctx, "cache_creation");
      const inputTokens = optionalIntegerFrom(
        result.uncached_input_tokens,
        ctx,
        "uncached_input_tokens",
      );
      const cacheCreationInputTokens =
        optionalIntegerFrom(
          cacheCreation?.ephemeral_1h_input_tokens,
          ctx,
          "ephemeral_1h_input_tokens",
        ) +
        optionalIntegerFrom(
          cacheCreation?.ephemeral_5m_input_tokens,
          ctx,
          "ephemeral_5m_input_tokens",
        );
      const cacheReadInputTokens = optionalIntegerFrom(
        result.cache_read_input_tokens,
        ctx,
        "cache_read_input_tokens",
      );
      const outputTokens = optionalIntegerFrom(result.output_tokens, ctx, "output_tokens");
      const totalTokens =
        inputTokens + cacheCreationInputTokens + cacheReadInputTokens + outputTokens;
      accumulator.inputTokens += inputTokens;
      accumulator.cacheCreationInputTokens += cacheCreationInputTokens;
      accumulator.cacheReadInputTokens += cacheReadInputTokens;
      accumulator.outputTokens += outputTokens;
      accumulator.totalTokens += totalTokens;
      const modelName = optionalStringFrom(result.model, ctx, "messages model");
      const model = modelFor(accumulator.models, displayName(modelName, "Claude API"));
      model.inputTokens += inputTokens;
      model.cacheCreationInputTokens += cacheCreationInputTokens;
      model.cacheReadInputTokens += cacheReadInputTokens;
      model.outputTokens += outputTokens;
      model.totalTokens += totalTokens;
    }
  }

  const now = ctx.date.now();
  const daily = [...accumulators.values()]
    .map(makeDailyBucket)
    .filter((bucket): bucket is DailyBucket => bucket !== undefined && bucket.startTime <= now)
    .sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
  const last30 = daily.slice(-30);
  const last7 = daily.slice(-7);
  const today = daily.filter((bucket) => bucket.startTime <= now && now < bucket.endTime);
  const total = summarize(last30);
  const seven = summarize(last7);
  const current = today.length === 0 ? emptySummary : summarize(today);
  const rows = [
    { label: "Today spend", value: ctx.format.usd(current.costUSD) },
    { label: "7d spend", value: ctx.format.usd(seven.costUSD) },
    { label: "30d spend", value: ctx.format.usd(total.costUSD) },
    { label: "Today tokens", value: countString(ctx, current.totalTokens) },
    { label: "30d tokens", value: countString(ctx, total.totalTokens) },
    { label: "Cache read", value: countString(ctx, total.cacheReadInputTokens) },
  ];
  const topModel = topModels(daily)[0];
  if (topModel !== undefined) rows.push({ label: "Top model", value: topModel.name });

  const details = [
    {
      title: "Usage summary",
      rows,
      ...(daily.length === 0
        ? {}
        : {
            chart: {
              kind: "bars" as const,
              title: "Daily spend",
              unit: "USD",
              points: daily.map((bucket) => ({ label: bucket.day, value: bucket.costUSD })),
            },
          }),
    },
  ];
  const costs = topCostItems(daily);
  if (costs.length > 0) {
    details.push({
      title: "Cost items",
      rows: costs.slice(0, 20).map((item) => ({
        label: item.name,
        value: ctx.format.usd(item.costUSD),
      })),
    });
  }

  return {
    providerCost: {
      used: total.costUSD,
      limit: 0,
      currencyCode: "USD",
      period: "Last 30 days",
    },
    details,
    identity: {
      providerId: "claude",
      loginMethod: "Admin API",
    },
  };
};

export const fetchClaudeAdminAPIUsage = async (ctx: ProviderContext, rawKey: string) => {
  const apiKey = cleanClaudeAdminAPIKey(rawKey);
  if (apiKey === undefined) {
    throw ctx.fail.missingCredential("Claude Admin API needs an Anthropic Admin API key.");
  }
  const range = claudeAdminDailyRange(ctx.date.now());
  const options = { headers: adminHeaders(apiKey) };
  const costs = await ctx.http.getJSON(claudeAdminURL("cost", range), options);
  adminStatus(ctx, "cost_report", costs);
  const messages = await ctx.http.getJSON(claudeAdminURL("messages", range), options);
  adminStatus(ctx, "messages", messages);
  return parseClaudeAdminAPIUsage(costs.json, messages.json, ctx);
};
