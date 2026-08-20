import type { RateWindow, UsageSnapshot } from "@codexbar/contracts";

/** Shared reset metadata and boundary-refresh policy, with no host scheduler. */
export const resetBoundaryRefreshGraceMs = 30_000;
export const resetBoundaryRefreshMinimumDelayMs = 5_000;

export interface ResetBoundaryRefreshCandidate {
  readonly refreshAt: Date;
  readonly boundaryRefreshAt: Date;
}

/** Port of `RateWindow.backfillingResetTime(from:now:)`. */
export function backfillRateWindowReset(
  window: RateWindow,
  cached: RateWindow | undefined,
  now: Date,
): RateWindow {
  if (window.resetsAt !== undefined) return window;

  const cachedReset = cached?.resetsAt === undefined ? undefined : dateFromWire(cached.resetsAt);
  if (cachedReset === undefined || cachedReset.getTime() <= now.getTime()) return window;

  const windowMinutes =
    window.windowMinutes !== undefined && window.windowMinutes > 0
      ? window.windowMinutes
      : cached?.windowMinutes;
  const resetDescription = window.resetDescription ?? cached?.resetDescription;
  return {
    ...window,
    ...(windowMinutes === undefined ? {} : { windowMinutes }),
    resetsAt: cached?.resetsAt,
    ...(resetDescription === undefined ? {} : { resetDescription }),
  };
}

/** Port of `UsageSnapshot.backfillingResetTimes(from:now:)`, including account safety. */
export function backfillSnapshotResetTimes(
  snapshot: UsageSnapshot,
  cached: UsageSnapshot | undefined,
  now: Date,
): UsageSnapshot {
  if (cached === undefined || !snapshotIdentitiesMatch(snapshot, cached)) return snapshot;

  // Swift has a deliberately provider-specific Amp exception: its daily quota
  // must not inherit the legacy rolling reset timestamp.
  const cachedPrimary =
    snapshot.identity?.providerId === "amp" && snapshot.primary?.resetDescription === "resets daily"
      ? undefined
      : cached.primary;
  const primary =
    snapshot.primary === undefined
      ? undefined
      : backfillRateWindowReset(snapshot.primary, cachedPrimary, now);
  const secondary =
    snapshot.secondary === undefined
      ? undefined
      : backfillRateWindowReset(snapshot.secondary, cached.secondary, now);
  const tertiary =
    snapshot.tertiary === undefined
      ? undefined
      : backfillRateWindowReset(snapshot.tertiary, cached.tertiary, now);

  if (
    rateWindowsEqual(primary, snapshot.primary) &&
    rateWindowsEqual(secondary, snapshot.secondary) &&
    rateWindowsEqual(tertiary, snapshot.tertiary)
  ) {
    return snapshot;
  }
  return {
    ...snapshot,
    ...(primary === undefined ? {} : { primary }),
    ...(secondary === undefined ? {} : { secondary }),
    ...(tertiary === undefined ? {} : { tertiary }),
  };
}

/** Port of `UsageStore.limitResetBoundaryAdvanced`. */
export function didResetBoundaryAdvance(input: {
  readonly previous?: Date;
  readonly current?: Date;
  readonly requiresPreviousBoundary?: boolean;
  readonly equivalent?: (left: Date, right: Date) => boolean;
}): boolean {
  const equivalent = input.equivalent ?? ((left, right) => left.getTime() === right.getTime());
  if (input.previous === undefined) return input.requiresPreviousBoundary !== true;
  if (input.current === undefined) return false;
  return (
    !equivalent(input.previous, input.current) && input.current.getTime() > input.previous.getTime()
  );
}

/**
 * Determines the earliest refresh that should run immediately after a quota
 * reset, before the ordinary polling interval. Scheduling/cancellation remains
 * a host concern; this is the deterministic Swift parity calculation.
 */
export function nextResetBoundaryRefresh(input: {
  readonly snapshots: ReadonlyArray<UsageSnapshot>;
  readonly normalRefreshIntervalMs?: number;
  readonly minimumAutomaticRefreshIntervalMs?: number;
  readonly attemptedBoundaryRefreshes?: ReadonlySet<number>;
  readonly now: Date;
}): ResetBoundaryRefreshCandidate | undefined {
  if (input.normalRefreshIntervalMs === undefined) return undefined;

  const normalRefreshAt = new Date(input.now.getTime() + input.normalRefreshIntervalMs);
  const earliestAutomaticRefreshAt =
    input.minimumAutomaticRefreshIntervalMs === undefined
      ? undefined
      : new Date(input.now.getTime() + input.minimumAutomaticRefreshIntervalMs);
  const attempted = input.attemptedBoundaryRefreshes ?? new Set<number>();
  const candidates: ResetBoundaryRefreshCandidate[] = [];

  for (const snapshot of input.snapshots) {
    const updatedAt = dateFromWire(snapshot.updatedAt);
    if (updatedAt === undefined) continue;

    for (const window of allRateWindows(snapshot)) {
      const resetsAt = window.resetsAt === undefined ? undefined : dateFromWire(window.resetsAt);
      if (resetsAt === undefined) continue;
      const boundaryRefreshAt = new Date(resetsAt.getTime() + resetBoundaryRefreshGraceMs);
      if (attempted.has(boundaryRefreshAt.getTime())) continue;
      if (boundaryRefreshAt.getTime() > normalRefreshAt.getTime()) continue;
      if (updatedAt.getTime() >= boundaryRefreshAt.getTime()) continue;

      const minimumDelayAt = new Date(input.now.getTime() + resetBoundaryRefreshMinimumDelayMs);
      const earliestAllowedAt = laterDate(minimumDelayAt, earliestAutomaticRefreshAt);
      const refreshAt = laterDate(boundaryRefreshAt, earliestAllowedAt);
      if (refreshAt.getTime() > normalRefreshAt.getTime()) continue;
      candidates.push({ refreshAt, boundaryRefreshAt });
    }
  }

  return candidates.sort((left, right) => left.refreshAt.getTime() - right.refreshAt.getTime())[0];
}

/** An in-flight refresh must not consume its boundary retry opportunity. */
export function shouldRecordResetBoundaryAttempt(isRefreshing: boolean): boolean {
  return !isRefreshing;
}

function snapshotIdentitiesMatch(left: UsageSnapshot, right: UsageSnapshot): boolean {
  const leftIdentity = left.identity;
  const rightIdentity = right.identity;
  if (leftIdentity === undefined && rightIdentity === undefined) return true;
  if (leftIdentity === undefined || rightIdentity === undefined) return false;

  const leftAccountId = nonEmptyTrimmed(leftIdentity.accountId);
  const rightAccountId = nonEmptyTrimmed(rightIdentity.accountId);
  if (leftAccountId !== undefined && rightAccountId !== undefined)
    return leftAccountId === rightAccountId;

  const leftEmail = nonEmptyTrimmed(leftIdentity.accountEmail);
  const rightEmail = nonEmptyTrimmed(rightIdentity.accountEmail);
  if (leftEmail !== undefined && rightEmail !== undefined) return leftEmail === rightEmail;
  return true;
}

function nonEmptyTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function allRateWindows(snapshot: UsageSnapshot): ReadonlyArray<RateWindow> {
  return [
    ...(snapshot.primary === undefined ? [] : [snapshot.primary]),
    ...(snapshot.secondary === undefined ? [] : [snapshot.secondary]),
    ...(snapshot.tertiary === undefined ? [] : [snapshot.tertiary]),
    ...(snapshot.extraRateWindows?.map((named) => named.window) ?? []),
  ];
}

function laterDate(left: Date, right: Date | undefined): Date {
  return right === undefined || left.getTime() >= right.getTime() ? left : right;
}

function dateFromWire(value: string): Date | undefined {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function rateWindowsEqual(left: RateWindow | undefined, right: RateWindow | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
