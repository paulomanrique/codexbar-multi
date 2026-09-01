import { object } from "./_http.ts";
import type { ProviderSnapshot } from "../types.ts";

export class InvalidGroqConsoleSession extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidGroqConsoleSession";
  }
}

export class InvalidGroqConsoleActivity extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidGroqConsoleActivity";
  }
}

export interface GroqConsoleSessionInfo {
  readonly sessionToken?: string;
  readonly directJWT?: string;
  readonly sourceLabel: string;
}

export interface GroqConsoleActivityRow {
  readonly organizationName?: string;
  readonly model?: string;
  readonly timestamp: number;
  readonly numRequests?: number;
  readonly contextTokensTotal?: number;
  readonly nonCachedContextTokensTotal?: number;
  readonly generatedTokensTotal?: number;
  readonly costUSD?: number;
}

export interface GroqConsoleModelBreakdown {
  readonly name: string;
  readonly requests: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly costUSD: number;
}

export interface GroqConsoleDailyBucket {
  readonly day: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly costUSD: number;
  readonly requests: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly models: readonly GroqConsoleModelBreakdown[];
}

export interface GroqConsoleUsageSnapshot {
  readonly daily: readonly GroqConsoleDailyBucket[];
  readonly updatedAt: string;
  readonly historyDays: number;
  readonly organizationName?: string;
  readonly accountEmail?: string;
}

const compact = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const base64URLDecode = (value: string): string | undefined => {
  const normalized = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  try {
    return atob(padded);
  } catch {
    return undefined;
  }
};

export const groqConsoleOrganizationID = (jwt: string): string | undefined => {
  const segments = jwt.split(".");
  if (segments.length < 2) return undefined;
  const decoded = base64URLDecode(segments[1] ?? "");
  if (decoded === undefined) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(decoded) as unknown;
  } catch {
    return undefined;
  }
  const root = object(payload);
  const groq = root && object(root["https://groq.com/organization"]);
  const id = groq && compact(groq.id);
  if (id !== undefined) return id;
  const stytch = root && object(root["https://stytch.com/organization"]);
  return stytch && compact(stytch.slug);
};

const normalizeCookieHeader = (header: string | undefined): string | undefined => {
  const trimmed = header?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/^Cookie:\s*/iu, "").trim() || undefined;
};

export const groqConsoleSessionFromCookieHeader = (
  header: string | undefined,
): GroqConsoleSessionInfo | undefined => {
  const normalized = normalizeCookieHeader(header);
  if (normalized === undefined) return undefined;
  let sessionToken: string | undefined;
  let directJWT: string | undefined;
  for (const part of normalized.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!value) continue;
    if (name === "stytch_session") sessionToken = value;
    if (name === "stytch_session_jwt") directJWT = value;
  }
  return sessionToken === undefined && directJWT === undefined
    ? undefined
    : {
        ...(sessionToken === undefined ? {} : { sessionToken }),
        ...(directJWT === undefined ? {} : { directJWT }),
        sourceLabel: "manual",
      };
};

const optionalString = (value: unknown, path: string): string | undefined => {
  if (value == null) return undefined;
  if (typeof value !== "string") throw new InvalidGroqConsoleActivity(`${path} must be a string.`);
  return value;
};

const optionalInteger = (value: unknown, path: string): number | undefined => {
  if (value == null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new InvalidGroqConsoleActivity(`${path} must be an integer.`);
  }
  return value;
};

const optionalDouble = (value: unknown, path: string): number | undefined => {
  if (value == null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new InvalidGroqConsoleActivity(`${path} must be a finite number.`);
  }
  return value;
};

const requiredDouble = (value: unknown, path: string): number => {
  const parsed = optionalDouble(value, path);
  if (parsed === undefined) throw new InvalidGroqConsoleActivity(`${path} is required.`);
  return parsed;
};

export const parseGroqConsoleActivityRows = (
  payload: unknown,
): readonly GroqConsoleActivityRow[] => {
  const root = object(payload);
  if (!root) throw new InvalidGroqConsoleActivity("response must be an object.");
  if (!Array.isArray(root.data)) throw new InvalidGroqConsoleActivity("data must be an array.");
  return root.data.map((entry, index) => {
    const row = object(entry);
    if (!row) throw new InvalidGroqConsoleActivity(`data[${index}] must be an object.`);
    const organizationName = optionalString(
      row.organization_name,
      `data[${index}].organization_name`,
    );
    const model = optionalString(row.model, `data[${index}].model`);
    const numRequests = optionalInteger(row.num_requests, `data[${index}].num_requests`);
    const contextTokensTotal = optionalInteger(
      row.n_context_tokens_total,
      `data[${index}].n_context_tokens_total`,
    );
    const nonCachedContextTokensTotal = optionalInteger(
      row.n_non_cached_context_tokens_total,
      `data[${index}].n_non_cached_context_tokens_total`,
    );
    const generatedTokensTotal = optionalInteger(
      row.n_generated_tokens_total,
      `data[${index}].n_generated_tokens_total`,
    );
    const costUSD = optionalDouble(row.cost, `data[${index}].cost`);
    return {
      ...(organizationName === undefined ? {} : { organizationName }),
      ...(model === undefined ? {} : { model }),
      timestamp: requiredDouble(row.timestamp, `data[${index}].timestamp`),
      ...(numRequests === undefined ? {} : { numRequests }),
      ...(contextTokensTotal === undefined ? {} : { contextTokensTotal }),
      ...(nonCachedContextTokensTotal === undefined ? {} : { nonCachedContextTokensTotal }),
      ...(generatedTokensTotal === undefined ? {} : { generatedTokensTotal }),
      ...(costUSD === undefined ? {} : { costUSD }),
    };
  });
};

const clampHistoryDays = (value: number): number => Math.max(1, Math.min(365, Math.trunc(value)));

const utcDayKey = (date: Date): string => date.toISOString().slice(0, 10);

const startOfUTCDay = (seconds: number): Date => {
  const date = new Date(seconds * 1_000);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
};

const count = (value: number): string => new Intl.NumberFormat("en-US").format(value);

const usd = (value: number): string =>
  new Intl.NumberFormat("en-US", { currency: "USD", style: "currency" }).format(value);

export const makeGroqConsoleUsageSnapshot = (
  rows: readonly GroqConsoleActivityRow[],
  options: {
    readonly updatedAt: Date;
    readonly historyDays?: number;
    readonly accountEmail?: string;
  },
): GroqConsoleUsageSnapshot => {
  const byDay = new Map<
    string,
    { startTime: Date; models: Map<string, GroqConsoleModelBreakdown> }
  >();
  let organizationName: string | undefined;
  for (const row of rows) {
    if (
      organizationName === undefined &&
      row.organizationName !== undefined &&
      row.organizationName !== ""
    ) {
      organizationName = row.organizationName;
    }
    const startTime = startOfUTCDay(row.timestamp);
    const day = utcDayKey(startTime);
    const modelName = row.model === undefined || row.model === "" ? "unknown" : row.model;
    const contextTokens = row.contextTokensTotal ?? 0;
    const nonCached = row.nonCachedContextTokensTotal ?? contextTokens;
    const cached = Math.max(0, contextTokens - nonCached);
    const generated = row.generatedTokensTotal ?? 0;
    const bucket = byDay.get(day) ?? {
      startTime,
      models: new Map<string, GroqConsoleModelBreakdown>(),
    };
    const existing = bucket.models.get(modelName);
    bucket.models.set(modelName, {
      name: modelName,
      requests: (existing?.requests ?? 0) + (row.numRequests ?? 0),
      inputTokens: (existing?.inputTokens ?? 0) + nonCached,
      cachedInputTokens: (existing?.cachedInputTokens ?? 0) + cached,
      outputTokens: (existing?.outputTokens ?? 0) + generated,
      totalTokens: (existing?.totalTokens ?? 0) + contextTokens + generated,
      costUSD: (existing?.costUSD ?? 0) + (row.costUSD ?? 0),
    });
    byDay.set(day, bucket);
  }

  const daily = [...byDay.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([day, bucket]) => {
      const models = [...bucket.models.values()].sort(
        (left, right) => right.totalTokens - left.totalTokens,
      );
      const endTime = new Date(bucket.startTime.getTime() + 24 * 60 * 60 * 1_000);
      return {
        day,
        startTime: bucket.startTime.toISOString(),
        endTime: endTime.toISOString(),
        costUSD: models.reduce((sum, model) => sum + model.costUSD, 0),
        requests: models.reduce((sum, model) => sum + model.requests, 0),
        inputTokens: models.reduce((sum, model) => sum + model.inputTokens, 0),
        cachedInputTokens: models.reduce((sum, model) => sum + model.cachedInputTokens, 0),
        outputTokens: models.reduce((sum, model) => sum + model.outputTokens, 0),
        totalTokens: models.reduce((sum, model) => sum + model.totalTokens, 0),
        models,
      };
    });

  return {
    daily,
    updatedAt: options.updatedAt.toISOString(),
    historyDays: clampHistoryDays(options.historyDays ?? 30),
    ...(organizationName === undefined ? {} : { organizationName }),
    ...(options.accountEmail === undefined ? {} : { accountEmail: options.accountEmail }),
  };
};

export const mapGroqConsoleUsageSnapshot = (
  snapshot: GroqConsoleUsageSnapshot,
): ProviderSnapshot => {
  const label = snapshot.historyDays === 1 ? "Today" : `Last ${snapshot.historyDays} days`;
  const windowCostUSD = snapshot.daily.reduce((sum, bucket) => sum + bucket.costUSD, 0);
  const totals = snapshot.daily.slice(-snapshot.historyDays).reduce(
    (acc, bucket) => ({
      requests: acc.requests + bucket.requests,
      cachedInputTokens: acc.cachedInputTokens + bucket.cachedInputTokens,
      totalTokens: acc.totalTokens + bucket.totalTokens,
    }),
    { requests: 0, cachedInputTokens: 0, totalTokens: 0 },
  );
  const modelTotals = new Map<string, GroqConsoleModelBreakdown>();
  for (const bucket of snapshot.daily) {
    for (const model of bucket.models) {
      const existing = modelTotals.get(model.name);
      modelTotals.set(model.name, {
        name: model.name,
        requests: (existing?.requests ?? 0) + model.requests,
        inputTokens: (existing?.inputTokens ?? 0) + model.inputTokens,
        cachedInputTokens: (existing?.cachedInputTokens ?? 0) + model.cachedInputTokens,
        outputTokens: (existing?.outputTokens ?? 0) + model.outputTokens,
        totalTokens: (existing?.totalTokens ?? 0) + model.totalTokens,
        costUSD: (existing?.costUSD ?? 0) + model.costUSD,
      });
    }
  }
  const topModels = [...modelTotals.values()].sort(
    (left, right) => right.totalTokens - left.totalTokens || left.name.localeCompare(right.name),
  );
  const summaryRows = [
    { label: "Spend", value: usd(windowCostUSD), secondaryValue: label },
    { label: "Requests", value: count(totals.requests) },
    { label: "Tokens", value: count(totals.totalTokens) },
    ...(totals.cachedInputTokens > 0
      ? [{ label: "Cached input", value: count(totals.cachedInputTokens) }]
      : []),
  ];
  const details = [
    {
      title: "Usage summary",
      rows: summaryRows,
      ...(snapshot.daily.length === 0
        ? {}
        : {
            chart: {
              kind: "bars",
              title: "Daily spend",
              unit: "USD",
              points: snapshot.daily.map((bucket) => ({
                label: bucket.day,
                value: bucket.costUSD,
              })),
            },
          }),
    },
    ...(topModels.length === 0
      ? []
      : [
          {
            title: "Models",
            rows: topModels.slice(0, 20).map((model) => ({
              label: model.name,
              value: `${count(model.totalTokens)} tokens`,
              secondaryValue: `${count(model.requests)} requests`,
            })),
          },
        ]),
  ];
  return {
    providerCost: {
      used: windowCostUSD,
      limit: 0,
      currencyCode: "USD",
      period: label,
      updatedAt: snapshot.updatedAt,
    },
    details,
    updatedAt: snapshot.updatedAt,
    identity: {
      ...(snapshot.accountEmail === undefined ? {} : { accountEmail: snapshot.accountEmail }),
      ...(snapshot.organizationName === undefined
        ? {}
        : { accountOrganization: snapshot.organizationName }),
      loginMethod: "Console",
    },
  };
};

export const resolveGroqConsoleActivityURL = (
  endpoint: URL,
  orgID: string,
  window: { readonly start: Date; readonly end: Date },
): string => {
  const url = new URL(endpoint.href);
  url.pathname = `/platform/v1/organizations/${orgID}/activity`;
  url.search = new URLSearchParams({
    start_date: String(Math.trunc(window.start.getTime() / 1_000)),
    end_date: String(Math.trunc(window.end.getTime() / 1_000)),
  }).toString();
  return url.href;
};
