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
};

export const GROK_LOCAL_SESSION_MAX_TOTAL_TOKENS = Number.MAX_SAFE_INTEGER;

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
): GrokLocalSessionSummary => {
  let totalTokens = 0;
  let lastSessionAtMs: number | undefined;
  const modelCounts = new Map<string, number>();
  for (const signal of signals) {
    totalTokens = addTokens(totalTokens, signal.totalTokensBeforeCompaction);
    totalTokens = addTokens(totalTokens, signal.contextTokensUsed);
    if (lastSessionAtMs === undefined || signal.modifiedAtMs > lastSessionAtMs)
      lastSessionAtMs = signal.modifiedAtMs;
    if (signal.primaryModelId !== undefined)
      modelCounts.set(signal.primaryModelId, (modelCounts.get(signal.primaryModelId) ?? 0) + 1);
    for (const model of signal.modelsUsed)
      modelCounts.set(model, (modelCounts.get(model) ?? 0) + 1);
  }
  const models = [...modelCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([model]) => model);
  return {
    sessionCount: signals.length,
    totalTokens,
    ...(lastSessionAtMs === undefined ? {} : { lastSessionAtMs }),
    ...(models[0] === undefined ? {} : { primaryModel: models[0] }),
    models,
  };
};
