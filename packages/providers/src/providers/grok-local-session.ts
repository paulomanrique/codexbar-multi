/**
 * Pure projection of Grok CLI session signal files. Filesystem traversal stays
 * in the platform package so provider policy remains portable and testable.
 */
export type GrokLocalSessionSignal = {
  readonly modifiedAtMs: number;
  readonly totalTokensBeforeCompaction: number;
  readonly contextTokensUsed: number;
  readonly primaryModelId?: string;
  readonly modelsUsed: readonly string[];
};

export type GrokLocalSessionSummary = {
  readonly sessionCount: number;
  readonly totalTokens: number;
  readonly lastSessionAtMs?: number;
  readonly primaryModel?: string;
  readonly models: readonly string[];
  /** Present only for the host-owned spend projection, never a quota window. */
  readonly daily?: readonly GrokLocalDailyBucket[];
  /** Local-calendar day represented by the scan clock. */
  readonly today?: string;
  /** Scanner bounds mean the local history is readable but partial. */
  readonly truncated?: boolean;
};

export type GrokLocalDailyBucket = {
  readonly date: string;
  readonly totalTokens: number;
  readonly sessionCount: number;
  readonly models: readonly string[];
};

export interface GrokLocalSessionSummaryOptions {
  /** Opt-in so existing diagnostic callers do not receive unneeded history. */
  readonly includeDaily?: boolean;
  readonly scannedAtMs?: number;
  readonly truncated?: boolean;
  /** Injectable for deterministic tests and host-selected local calendars. */
  readonly dayKey?: (timestamp: number) => string | undefined;
}

export const GROK_LOCAL_SESSION_MAX_TOTAL_TOKENS = Number.MAX_SAFE_INTEGER;

export const grokLocalSessionDayKey = (timestamp: number): string | undefined => {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return undefined;
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Foundation's `as? Int` accepts only integral JSON numbers for these fields. */
const integer = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : 0;

const nonemptyString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
};

/** Preserve valid signed counters while never overflowing the JS-safe total. */
const addTokens = (total: number, value: number): number => {
  const next = total + value;
  if (Number.isSafeInteger(next)) return next;
  return next < 0 ? Number.MIN_SAFE_INTEGER : GROK_LOCAL_SESSION_MAX_TOTAL_TOKENS;
};

/** Parses only the allow-listed fields from one already bounded JSON object. */
export const parseGrokLocalSessionSignal = (
  value: unknown,
  modifiedAtMs: number,
): GrokLocalSessionSignal | undefined => {
  if (!isRecord(value) || !Number.isFinite(modifiedAtMs)) return undefined;
  const modelsUsed =
    Array.isArray(value.modelsUsed) && value.modelsUsed.every((model) => typeof model === "string")
      ? value.modelsUsed.flatMap((model) => {
          const trimmed = model.trim();
          return trimmed === "" ? [] : [trimmed];
        })
      : [];
  const primaryModelId = nonemptyString(value.primaryModelId);
  return {
    modifiedAtMs,
    totalTokensBeforeCompaction: integer(value.totalTokensBeforeCompaction),
    contextTokensUsed: integer(value.contextTokensUsed),
    ...(primaryModelId === undefined ? {} : { primaryModelId }),
    modelsUsed,
  };
};

/** Direct data-only port of `GrokLocalSessionScanner.summarize`. */
export const summarizeGrokLocalSessions = (
  signals: readonly GrokLocalSessionSignal[],
  options: GrokLocalSessionSummaryOptions = {},
): GrokLocalSessionSummary => {
  let totalTokens = 0;
  let lastSessionAtMs: number | undefined;
  const modelCounts = new Map<string, number>();
  const daily = new Map<
    string,
    { totalTokens: number; sessionCount: number; modelCounts: Map<string, number> }
  >();
  const dayKey = options.dayKey ?? grokLocalSessionDayKey;
  for (const signal of signals) {
    const sessionTokens = addTokens(signal.totalTokensBeforeCompaction, signal.contextTokensUsed);
    totalTokens = addTokens(totalTokens, sessionTokens);
    if (lastSessionAtMs === undefined || signal.modifiedAtMs > lastSessionAtMs)
      lastSessionAtMs = signal.modifiedAtMs;
    if (signal.primaryModelId !== undefined)
      modelCounts.set(signal.primaryModelId, (modelCounts.get(signal.primaryModelId) ?? 0) + 1);
    for (const model of signal.modelsUsed)
      modelCounts.set(model, (modelCounts.get(model) ?? 0) + 1);
    if (options.includeDaily === true) {
      const date = dayKey(signal.modifiedAtMs);
      if (date !== undefined) {
        const bucket = daily.get(date) ?? {
          totalTokens: 0,
          sessionCount: 0,
          modelCounts: new Map<string, number>(),
        };
        bucket.totalTokens = addTokens(bucket.totalTokens, sessionTokens);
        bucket.sessionCount += 1;
        if (signal.primaryModelId !== undefined) {
          bucket.modelCounts.set(
            signal.primaryModelId,
            (bucket.modelCounts.get(signal.primaryModelId) ?? 0) + 1,
          );
        }
        for (const model of signal.modelsUsed)
          bucket.modelCounts.set(model, (bucket.modelCounts.get(model) ?? 0) + 1);
        daily.set(date, bucket);
      }
    }
  }
  const models = [...modelCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([model]) => model);
  const summaryToday =
    options.includeDaily === true && options.scannedAtMs !== undefined
      ? dayKey(options.scannedAtMs)
      : undefined;
  const dailyBuckets =
    options.includeDaily !== true
      ? undefined
      : [...daily.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([date, bucket]) => ({
            date,
            totalTokens: bucket.totalTokens,
            sessionCount: bucket.sessionCount,
            models: [...bucket.modelCounts.entries()]
              .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
              .map(([model]) => model),
          }));
  return {
    sessionCount: signals.length,
    totalTokens,
    ...(lastSessionAtMs === undefined ? {} : { lastSessionAtMs }),
    ...(models[0] === undefined ? {} : { primaryModel: models[0] }),
    models,
    ...(dailyBuckets === undefined ? {} : { daily: dailyBuckets }),
    ...(summaryToday === undefined ? {} : { today: summaryToday }),
    ...(options.includeDaily !== true || options.truncated === undefined
      ? {}
      : { truncated: options.truncated }),
  };
};

/**
 * Diagnostic-only local activity projection. It intentionally produces no
 * RateWindow: session tokens are not a subscription quota measurement.
 */
export const grokLocalSessionDetails = (summary: GrokLocalSessionSummary) =>
  summary.sessionCount === 0
    ? []
    : [
        {
          title: "Local Grok activity (not quota)",
          rows: [
            { label: "Sessions", value: String(summary.sessionCount) },
            { label: "Tokens", value: String(summary.totalTokens) },
            ...(summary.lastSessionAtMs === undefined
              ? []
              : [
                  {
                    label: "Latest session",
                    value: new Date(summary.lastSessionAtMs).toISOString(),
                  },
                ]),
          ],
        },
      ];
