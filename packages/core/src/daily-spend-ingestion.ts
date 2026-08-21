import type { ProviderId, UsageSnapshot } from "@codexbar/contracts";
import type { CostUsageRecord, DailyCostUsageReplacement } from "./services.ts";

export const XAI_DAILY_SPEND_SOURCE = "vendor-daily-spend";
const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type DailySpendSnapshotMapping =
  | {
      readonly availability: "unavailable";
      readonly coverage: "exact" | "estimated";
      readonly since: number;
      readonly until: number;
      readonly records: readonly CostUsageRecord[];
    }
  | {
      readonly availability: "available";
      readonly coverage: "exact" | "estimated";
      readonly since: number;
      readonly until: number;
      readonly records: readonly CostUsageRecord[];
    };

/**
 * Converts a vendor's USD daily-spend chart into one replaceable daily ledger.
 * It intentionally never reads providerCost: balances and credits are quotas,
 * not metered spend. The chart convention is generic; xAI chooses to publish
 * it through the source key below.
 */
export const mapDailySpendSnapshot = (
  providerId: ProviderId,
  snapshot: UsageSnapshot,
  sourceKey: string,
  historyDays = 30,
): DailyCostUsageReplacement => {
  if (!Number.isSafeInteger(historyDays) || historyDays < 1 || historyDays > 365) {
    throw new TypeError("Daily spend history must be between 1 and 365 days.");
  }
  const updatedAt = Date.parse(snapshot.updatedAt);
  if (!Number.isFinite(updatedAt))
    throw new TypeError("Daily spend snapshot updatedAt is invalid.");
  const until = utcDay(updatedAt);
  const since = until - (historyDays - 1) * DAY_MILLISECONDS;
  const coverage =
    snapshot.dataConfidence === undefined || snapshot.dataConfidence === "exact"
      ? "exact"
      : "estimated";
  const chart = snapshot.details.find(
    (section) => section.chart?.title === "Daily spend" && section.chart.unit === "USD",
  )?.chart;
  if (chart === undefined) {
    return {
      providerId,
      sourceKey,
      since,
      until,
      availability: "unavailable",
      coverage,
      records: [],
    };
  }

  const totals = new Map<number, number>();
  for (const point of chart.points) {
    const recordedAt = utcDayFromKey(point.label);
    if (recordedAt === undefined || !Number.isFinite(point.value) || point.value < 0) continue;
    if (recordedAt < since || recordedAt > until) continue;
    const total = (totals.get(recordedAt) ?? 0) + point.value;
    if (!Number.isFinite(total) || total < 0) throw new RangeError("Daily spend total is invalid.");
    totals.set(recordedAt, total);
  }
  const records = [...totals.entries()]
    .sort(([left], [right]) => left - right)
    .map(([recordedAt, costUsd]) => ({
      providerId,
      recordedAt,
      inputTokens: 0,
      outputTokens: 0,
      costUsd,
    }));
  return { providerId, sourceKey, since, until, availability: "available", coverage, records };
};

/** xAI's Management API has a 30-day USD chart; its prepaid balance is excluded above. */
export const mapXaiDailySpendSnapshot = (snapshot: UsageSnapshot): DailyCostUsageReplacement =>
  mapDailySpendSnapshot("xai", snapshot, XAI_DAILY_SPEND_SOURCE, 30);

const utcDay = (timestamp: number): number => {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
};

const utcDayFromKey = (value: string): number | undefined => {
  if (!DAY_PATTERN.test(value)) return undefined;
  const [year, month, day] = value.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) return undefined;
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? timestamp
    : undefined;
};
