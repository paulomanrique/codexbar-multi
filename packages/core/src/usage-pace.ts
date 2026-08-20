import type { Pace, RateWindow } from "@codexbar/contracts";

/** Shared usage pace model ported from `Sources/CodexBarCore/UsagePace.swift`. */
export type UsagePaceStage = Pace["stage"];
export type UsagePace = Pace;

export interface UsagePaceOptions {
  readonly now: Date;
  readonly defaultWindowMinutes?: number;
  /** `2...6` enables the Swift weekly work-day calculation; other values use linear pace. */
  readonly workDays?: number;
  /**
   * Explicit IANA time zone for work-day calculations. The desktop composition
   * root supplies the user's time zone; accepting it here keeps the domain
   * layer independent of a particular operating system.
   */
  readonly timeZone?: string;
}

interface WorkdayProgress {
  readonly workDays: number;
  readonly totalSeconds: number;
  readonly elapsedSeconds: number;
  readonly remainingSeconds: number;
}

const weekMinutes = 10_080;
const secondMs = 1_000;

/** Port of `UsagePace.weekly(window:now:defaultWindowMinutes:workDays:calendar:)`. */
export function calculateUsagePace(
  window: RateWindow,
  options: UsagePaceOptions,
): UsagePace | undefined {
  const resetsAt = parseDate(window.resetsAt);
  if (resetsAt === undefined) return undefined;

  const minutes = window.windowMinutes ?? options.defaultWindowMinutes ?? weekMinutes;
  if (!Number.isFinite(minutes) || minutes <= 0) return undefined;

  const durationSeconds = minutes * 60;
  const timeUntilReset = (resetsAt.getTime() - options.now.getTime()) / secondMs;
  if (timeUntilReset <= 0 || timeUntilReset > durationSeconds) return undefined;

  const elapsedSeconds = clamp(durationSeconds - timeUntilReset, 0, durationSeconds);
  const workdayProgress =
    options.workDays !== undefined &&
    options.workDays >= 2 &&
    options.workDays < 7 &&
    minutes === weekMinutes
      ? calculateWorkdayProgress({
          now: options.now,
          resetsAt,
          durationSeconds,
          workDays: options.workDays,
          ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
        })
      : undefined;
  const expectedUsedPercent =
    workdayProgress === undefined
      ? clamp((elapsedSeconds / durationSeconds) * 100, 0, 100)
      : clamp((workdayProgress.elapsedSeconds / workdayProgress.totalSeconds) * 100, 0, 100);
  const actualUsedPercent = clamp(window.usedPercent, 0, 100);
  if (elapsedSeconds === 0 && actualUsedPercent > 0) return undefined;

  const deltaPercent = actualUsedPercent - expectedUsedPercent;
  const paceElapsedSeconds = workdayProgress?.elapsedSeconds ?? elapsedSeconds;
  const effectiveTimeUntilReset = workdayProgress?.remainingSeconds ?? timeUntilReset;
  const projectedRemainingUsage =
    paceElapsedSeconds > 0 ? (actualUsedPercent * effectiveTimeUntilReset) / paceElapsedSeconds : 0;
  const speedMultiplierToReset = safeSpeedMultiplier(
    100 - actualUsedPercent,
    projectedRemainingUsage,
  );

  let etaSeconds: number | undefined;
  let willLastToReset = false;
  if (actualUsedPercent >= 100) {
    etaSeconds = 0;
  } else if (paceElapsedSeconds > 0 && actualUsedPercent > 0) {
    const rate = actualUsedPercent / paceElapsedSeconds;
    if (rate > 0) {
      const candidateSeconds = (100 - actualUsedPercent) / rate;
      if (candidateSeconds >= effectiveTimeUntilReset) {
        willLastToReset = true;
      } else if (workdayProgress !== undefined) {
        etaSeconds = wallClockIntervalForWorkSeconds({
          now: options.now,
          resetsAt,
          requiredWorkSeconds: candidateSeconds,
          workDays: workdayProgress.workDays,
          ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
        });
      } else {
        etaSeconds = candidateSeconds;
      }
    }
  } else if (paceElapsedSeconds > 0 && actualUsedPercent === 0) {
    willLastToReset = true;
  }

  return usagePace({
    stage: stageForUsagePaceDelta(deltaPercent),
    deltaPercent,
    expectedUsedPercent,
    actualUsedPercent,
    ...(etaSeconds === undefined ? {} : { etaSeconds }),
    willLastToReset,
    ...(speedMultiplierToReset === undefined ? {} : { speedMultiplierToReset }),
  });
}

/** Port of `UsagePace.historical`, used by learned provider-specific pace curves. */
export function createHistoricalUsagePace(input: {
  readonly expectedUsedPercent: number;
  readonly actualUsedPercent: number;
  readonly etaSeconds?: number;
  readonly willLastToReset: boolean;
  readonly runOutProbability?: number;
  readonly projectedRemainingUsage?: number;
}): UsagePace {
  const expectedUsedPercent = clamp(input.expectedUsedPercent, 0, 100);
  const actualUsedPercent = clamp(input.actualUsedPercent, 0, 100);
  const deltaPercent = actualUsedPercent - expectedUsedPercent;
  const speedMultiplierToReset =
    input.projectedRemainingUsage === undefined
      ? undefined
      : safeSpeedMultiplier(100 - actualUsedPercent, input.projectedRemainingUsage);

  return usagePace({
    stage: stageForUsagePaceDelta(deltaPercent),
    deltaPercent,
    expectedUsedPercent,
    actualUsedPercent,
    ...(input.etaSeconds === undefined ? {} : { etaSeconds: input.etaSeconds }),
    willLastToReset: input.willLastToReset,
    ...(input.runOutProbability === undefined
      ? {}
      : { runOutProbability: input.runOutProbability }),
    ...(speedMultiplierToReset === undefined ? {} : { speedMultiplierToReset }),
  });
}

export function stageForUsagePaceDelta(deltaPercent: number): UsagePaceStage {
  const absoluteDelta = Math.abs(deltaPercent);
  if (absoluteDelta <= 2) return "onTrack";
  if (absoluteDelta <= 6) return deltaPercent >= 0 ? "slightlyAhead" : "slightlyBehind";
  if (absoluteDelta <= 12) return deltaPercent >= 0 ? "ahead" : "behind";
  return deltaPercent >= 0 ? "farAhead" : "farBehind";
}

/** Port of `UsageStore.paceElapsedBoundary`. */
export function paceElapsedBoundary(input: {
  readonly window: RateWindow;
  readonly minimumElapsedPercent: number;
}): Date | undefined {
  const resetsAt = parseDate(input.window.resetsAt);
  const minutes = input.window.windowMinutes;
  if (
    input.minimumElapsedPercent <= 0 ||
    resetsAt === undefined ||
    minutes === undefined ||
    !Number.isFinite(minutes) ||
    minutes <= 0
  ) {
    return undefined;
  }

  const durationMs = minutes * 60 * secondMs;
  const start = resetsAt.getTime() - durationMs;
  return new Date(start + (durationMs * input.minimumElapsedPercent) / 100);
}

/** Port of the private `UsageStore.windowElapsedPercent` helper. */
export function elapsedWindowPercent(window: RateWindow, now: Date): number | undefined {
  const resetsAt = parseDate(window.resetsAt);
  const minutes = window.windowMinutes;
  if (
    resetsAt === undefined ||
    minutes === undefined ||
    !Number.isFinite(minutes) ||
    minutes <= 0
  ) {
    return undefined;
  }
  const durationMs = minutes * 60 * secondMs;
  const start = resetsAt.getTime() - durationMs;
  return clamp(((now.getTime() - start) / durationMs) * 100, 0, 100);
}

function usagePace(value: UsagePace): UsagePace {
  return value;
}

function safeSpeedMultiplier(
  remainingCapacity: number,
  projectedRemainingUsage: number,
): number | undefined {
  if (!(remainingCapacity > 0) || !(projectedRemainingUsage > 0)) return undefined;
  const multiplier = remainingCapacity / projectedRemainingUsage;
  return Number.isFinite(multiplier) ? multiplier : undefined;
}

function calculateWorkdayProgress(input: {
  readonly now: Date;
  readonly resetsAt: Date;
  readonly durationSeconds: number;
  readonly workDays: number;
  readonly timeZone?: string;
}): WorkdayProgress | undefined {
  const windowStart = new Date(input.resetsAt.getTime() - input.durationSeconds * secondMs);
  const timeZone = resolveTimeZone(input.timeZone);
  let totalSeconds = 0;
  let elapsedSeconds = 0;
  let remainingSeconds = 0;
  let cursor = windowStart;

  while (cursor.getTime() < input.resetsAt.getTime()) {
    const nextDay = nextDayBoundary(cursor, timeZone);
    if (nextDay === undefined || nextDay.getTime() <= cursor.getTime()) return undefined;
    const sliceEnd = new Date(Math.min(nextDay.getTime(), input.resetsAt.getTime()));

    if (isWorkday(cursor, timeZone, input.workDays)) {
      const sliceSeconds = (sliceEnd.getTime() - cursor.getTime()) / secondMs;
      totalSeconds += sliceSeconds;
      if (input.now.getTime() > cursor.getTime()) {
        elapsedSeconds +=
          (Math.min(input.now.getTime(), sliceEnd.getTime()) - cursor.getTime()) / secondMs;
      }
      if (input.now.getTime() < sliceEnd.getTime()) {
        remainingSeconds +=
          (sliceEnd.getTime() - Math.max(input.now.getTime(), cursor.getTime())) / secondMs;
      }
    }
    cursor = sliceEnd;
  }

  if (totalSeconds <= 0) return undefined;
  return { workDays: input.workDays, totalSeconds, elapsedSeconds, remainingSeconds };
}

function wallClockIntervalForWorkSeconds(input: {
  readonly now: Date;
  readonly resetsAt: Date;
  readonly requiredWorkSeconds: number;
  readonly workDays: number;
  readonly timeZone?: string;
}): number | undefined {
  if (input.requiredWorkSeconds <= 0) return 0;

  const timeZone = resolveTimeZone(input.timeZone);
  let remainingSeconds = input.requiredWorkSeconds;
  let cursor = input.now;
  while (cursor.getTime() < input.resetsAt.getTime()) {
    const nextDay = nextDayBoundary(cursor, timeZone);
    if (nextDay === undefined || nextDay.getTime() <= cursor.getTime()) return undefined;
    const sliceEnd = new Date(Math.min(nextDay.getTime(), input.resetsAt.getTime()));
    if (isWorkday(cursor, timeZone, input.workDays)) {
      const availableSeconds = (sliceEnd.getTime() - cursor.getTime()) / secondMs;
      if (remainingSeconds <= availableSeconds) {
        return (cursor.getTime() + remainingSeconds * secondMs - input.now.getTime()) / secondMs;
      }
      remainingSeconds -= availableSeconds;
    }
    cursor = sliceEnd;
  }
  return undefined;
}

function nextDayBoundary(date: Date, timeZone: string): Date | undefined {
  const parts = dateParts(date, timeZone);
  if (parts === undefined) return undefined;
  const nextLocalDay = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
  return zonedMidnight(
    nextLocalDay.getUTCFullYear(),
    nextLocalDay.getUTCMonth() + 1,
    nextLocalDay.getUTCDate(),
    timeZone,
  );
}

function isWorkday(date: Date, timeZone: string, workDays: number): boolean {
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(date);
  const isoWeekday =
    weekday === "Mon"
      ? 1
      : weekday === "Tue"
        ? 2
        : weekday === "Wed"
          ? 3
          : weekday === "Thu"
            ? 4
            : weekday === "Fri"
              ? 5
              : weekday === "Sat"
                ? 6
                : 7;
  return isoWeekday <= workDays;
}

function resolveTimeZone(timeZone: string | undefined): string {
  return timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function dateParts(
  date: Date,
  timeZone: string,
): { readonly year: number; readonly month: number; readonly day: number } | undefined {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const values = Object.fromEntries(
    parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
  );
  const year = Number(values.year);
  const month = Number(values.month);
  const day = Number(values.day);
  return Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(day)
    ? { year, month, day }
    : undefined;
}

/** Converts a local midnight to an instant using offset convergence (including DST transitions). */
function zonedMidnight(
  year: number,
  month: number,
  day: number,
  timeZone: string,
): Date | undefined {
  const intendedLocalMs = Date.UTC(year, month - 1, day);
  let candidateMs = intendedLocalMs;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const offsetMs = timeZoneOffsetMs(new Date(candidateMs), timeZone);
    if (offsetMs === undefined) return undefined;
    const nextCandidateMs = intendedLocalMs - offsetMs;
    if (nextCandidateMs === candidateMs) return new Date(candidateMs);
    candidateMs = nextCandidateMs;
  }
  return new Date(candidateMs);
}

function timeZoneOffsetMs(date: Date, timeZone: string): number | undefined {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(date);
  const values = Object.fromEntries(
    parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
  );
  const year = Number(values.year);
  const month = Number(values.month);
  const day = Number(values.day);
  const hour = Number(values.hour);
  const minute = Number(values.minute);
  const second = Number(values.second);
  if (![year, month, day, hour, minute, second].every(Number.isFinite)) return undefined;
  return Date.UTC(year, month - 1, day, hour, minute, second) - date.getTime();
}

function parseDate(value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function clamp(value: number, lower: number, upper: number): number {
  return Math.min(Math.max(value, lower), upper);
}
