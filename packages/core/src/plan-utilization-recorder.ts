import {
  PlanUtilizationHistoryEntry,
  PlanUtilizationSeriesHistory,
  PlanUtilizationSeriesName,
} from "./plan-utilization-history.ts";

export const PLAN_UTILIZATION_MIN_SAMPLE_INTERVAL_MILLISECONDS = 60 * 60 * 1_000;
export const PLAN_UTILIZATION_RESET_EQUIVALENCE_TOLERANCE_MILLISECONDS = 2 * 60 * 1_000;
export const PLAN_UTILIZATION_MAX_SAMPLES = 24 * 730;

export interface PlanUtilizationSeriesSample {
  readonly name: PlanUtilizationSeriesName | string;
  readonly windowMinutes: number;
  readonly entry: PlanUtilizationHistoryEntry;
}

/**
 * Port of `UsageStore.updatedPlanUtilizationHistories`.
 *
 * Existing near-canonical session/weekly windows are folded before applying
 * samples. `undefined` means the canonical persisted value did not change.
 */
export function updatePlanUtilizationHistories(
  existingHistories: readonly PlanUtilizationSeriesHistory[],
  samples: readonly PlanUtilizationSeriesSample[],
): readonly PlanUtilizationSeriesHistory[] | undefined {
  if (samples.length === 0) return undefined;

  const historiesByKey = new Map<string, PlanUtilizationSeriesHistory>();
  let didChange = false;
  for (const history of existingHistories) {
    const canonicalWindowMinutes = history.name.canonicalWindowMinutes(history.windowMinutes);
    const key = seriesKey(history.name, canonicalWindowMinutes);
    const canonicalHistory = new PlanUtilizationSeriesHistory({
      name: history.name,
      windowMinutes: canonicalWindowMinutes,
      entries: history.entries,
    });
    const existing = historiesByKey.get(key);
    if (existing !== undefined) {
      historiesByKey.set(
        key,
        new PlanUtilizationSeriesHistory({
          name: history.name,
          windowMinutes: canonicalWindowMinutes,
          entries: mergeUniqueEntries([...existing.entries, ...canonicalHistory.entries]),
        }),
      );
      didChange = true;
    } else {
      historiesByKey.set(key, canonicalHistory);
      didChange ||= canonicalWindowMinutes !== history.windowMinutes;
    }
  }

  for (const sample of samples) {
    const name =
      sample.name instanceof PlanUtilizationSeriesName
        ? sample.name
        : new PlanUtilizationSeriesName(sample.name);
    const canonicalWindowMinutes = name.canonicalWindowMinutes(sample.windowMinutes);
    const key = seriesKey(name, canonicalWindowMinutes);
    const existing = historiesByKey.get(key);
    if (existing !== undefined) {
      const updatedEntries = updatePlanUtilizationEntries(existing.entries, sample.entry);
      if (updatedEntries === undefined) continue;
      historiesByKey.set(
        key,
        new PlanUtilizationSeriesHistory({
          name,
          windowMinutes: canonicalWindowMinutes,
          entries: updatedEntries,
        }),
      );
    } else {
      historiesByKey.set(
        key,
        new PlanUtilizationSeriesHistory({
          name,
          windowMinutes: canonicalWindowMinutes,
          entries: [sample.entry],
        }),
      );
    }
    didChange = true;
  }

  if (!didChange) return undefined;
  return [...historiesByKey.values()].sort(compareHistories);
}

/**
 * Stores at most two observations per UTC hour: the peak before a detected
 * reset and the peak in the latest reset segment. This is deliberately based
 * on Unix-hour buckets, matching Swift's `floor(timeIntervalSince1970 / 3600)`.
 */
export function updatePlanUtilizationEntries(
  existingEntries: readonly PlanUtilizationHistoryEntry[],
  entry: PlanUtilizationHistoryEntry,
): readonly PlanUtilizationHistoryEntry[] | undefined {
  const entries = [...existingEntries];
  const insertionIndex = entries.findIndex(
    (candidate) => candidate.capturedAt.getTime() > entry.capturedAt.getTime(),
  );
  const resolvedInsertionIndex = insertionIndex === -1 ? entries.length : insertionIndex;
  const hourBucket = planUtilizationHourBucket(entry.capturedAt);
  const range = planUtilizationHourRange(entries, resolvedInsertionIndex, hourBucket);
  const existingHourEntries = entries.slice(range.start, range.end);
  const canonicalHourEntries = canonicalPlanUtilizationHourEntries(existingHourEntries, entry);

  if (entryArraysEqual(canonicalHourEntries, existingHourEntries)) return undefined;
  entries.splice(range.start, range.end - range.start, ...canonicalHourEntries);
  if (entries.length > PLAN_UTILIZATION_MAX_SAMPLES) {
    entries.splice(0, entries.length - PLAN_UTILIZATION_MAX_SAMPLES);
  }
  return entries;
}

const planUtilizationHourBucket = (date: Date): number =>
  Math.floor(date.getTime() / PLAN_UTILIZATION_MIN_SAMPLE_INTERVAL_MILLISECONDS);

const planUtilizationHourRange = (
  entries: readonly PlanUtilizationHistoryEntry[],
  insertionIndex: number,
  hourBucket: number,
): { readonly start: number; readonly end: number } => {
  let start = insertionIndex;
  while (start > 0 && planUtilizationHourBucket(entries[start - 1]!.capturedAt) === hourBucket) {
    start -= 1;
  }

  let end = insertionIndex;
  while (
    end < entries.length &&
    planUtilizationHourBucket(entries[end]!.capturedAt) === hourBucket
  ) {
    end += 1;
  }
  return { start, end };
};

const canonicalPlanUtilizationHourEntries = (
  existingHourEntries: readonly PlanUtilizationHistoryEntry[],
  incomingEntry: PlanUtilizationHistoryEntry,
): readonly PlanUtilizationHistoryEntry[] => {
  const observations = [...existingHourEntries, incomingEntry].sort(compareEntries);
  let activeSegmentPeak = observations[0]!;
  let peakBeforeLatestReset: PlanUtilizationHistoryEntry | undefined;

  for (const observation of observations.slice(1)) {
    if (startsNewResetSegment(activeSegmentPeak, observation)) {
      peakBeforeLatestReset ??= activeSegmentPeak;
      activeSegmentPeak = observation;
      continue;
    }
    activeSegmentPeak = segmentPeakEntry(activeSegmentPeak, observation);
  }

  return peakBeforeLatestReset === undefined
    ? [activeSegmentPeak]
    : [peakBeforeLatestReset, activeSegmentPeak];
};

const startsNewResetSegment = (
  activeSegmentPeak: PlanUtilizationHistoryEntry,
  observation: PlanUtilizationHistoryEntry,
): boolean => {
  if (activeSegmentPeak.resetsAt === undefined || observation.resetsAt === undefined) return false;
  return (
    Math.abs(activeSegmentPeak.resetsAt.getTime() - observation.resetsAt.getTime()) >=
    PLAN_UTILIZATION_RESET_EQUIVALENCE_TOLERANCE_MILLISECONDS
  );
};

const segmentPeakEntry = (
  existingPeak: PlanUtilizationHistoryEntry,
  observation: PlanUtilizationHistoryEntry,
): PlanUtilizationHistoryEntry => {
  if (existingPeak.resetsAt === undefined && observation.resetsAt !== undefined) return observation;

  const observationShouldReplacePeak =
    observation.usedPercent > existingPeak.usedPercent ||
    (observation.usedPercent === existingPeak.usedPercent &&
      observation.capturedAt.getTime() >= existingPeak.capturedAt.getTime());
  const peakSource = observationShouldReplacePeak ? observation : existingPeak;
  const preferObservationMetadata =
    observation.capturedAt.getTime() >= existingPeak.capturedAt.getTime();
  const resetsAt = preferObservationMetadata
    ? (observation.resetsAt ?? existingPeak.resetsAt)
    : (existingPeak.resetsAt ?? observation.resetsAt);

  return new PlanUtilizationHistoryEntry({
    capturedAt: peakSource.capturedAt,
    usedPercent: peakSource.usedPercent,
    ...(resetsAt === undefined ? {} : { resetsAt }),
  });
};

const mergeUniqueEntries = (
  entries: readonly PlanUtilizationHistoryEntry[],
): readonly PlanUtilizationHistoryEntry[] => {
  const output: PlanUtilizationHistoryEntry[] = [];
  for (const entry of entries) {
    if (!output.some((candidate) => entriesEqual(candidate, entry))) output.push(entry);
  }
  return output;
};

const entryArraysEqual = (
  left: readonly PlanUtilizationHistoryEntry[],
  right: readonly PlanUtilizationHistoryEntry[],
): boolean =>
  left.length === right.length && left.every((entry, index) => entriesEqual(entry, right[index]!));

const entriesEqual = (
  left: PlanUtilizationHistoryEntry,
  right: PlanUtilizationHistoryEntry,
): boolean =>
  left.capturedAt.getTime() === right.capturedAt.getTime() &&
  left.usedPercent === right.usedPercent &&
  left.resetsAt?.getTime() === right.resetsAt?.getTime();

const seriesKey = (name: PlanUtilizationSeriesName, windowMinutes: number): string =>
  JSON.stringify([name.rawValue, windowMinutes]);

const compareHistories = (
  left: PlanUtilizationSeriesHistory,
  right: PlanUtilizationSeriesHistory,
): number =>
  left.windowMinutes - right.windowMinutes ||
  compareUnicodeScalars(left.name.rawValue, right.name.rawValue);

const compareEntries = (
  left: PlanUtilizationHistoryEntry,
  right: PlanUtilizationHistoryEntry,
): number =>
  left.capturedAt.getTime() - right.capturedAt.getTime() ||
  left.usedPercent - right.usedPercent ||
  (left.resetsAt?.getTime() ?? Number.NEGATIVE_INFINITY) -
    (right.resetsAt?.getTime() ?? Number.NEGATIVE_INFINITY);

const compareUnicodeScalars = (left: string, right: string): number => {
  const leftScalars = Array.from(left, (scalar) => scalar.codePointAt(0)!);
  const rightScalars = Array.from(right, (scalar) => scalar.codePointAt(0)!);
  const count = Math.min(leftScalars.length, rightScalars.length);
  for (let index = 0; index < count; index += 1) {
    const difference = leftScalars[index]! - rightScalars[index]!;
    if (difference !== 0) return difference;
  }
  return leftScalars.length - rightScalars.length;
};
