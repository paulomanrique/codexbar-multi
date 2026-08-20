import type { RateWindow } from "@codexbar/contracts";

/**
 * Shared quota-warning policy ported from:
 * - Sources/CodexBarCore/Config/CodexBarConfig.swift
 * - Sources/CodexBar/SessionQuotaNotifications.swift
 * - Sources/CodexBar/UsageStore+QuotaWarnings.swift
 *
 * This module deliberately has no notification, settings, or provider
 * dependencies. Hosts persist the returned state and decide whether to emit a
 * notification or hook.
 */
export const defaultQuotaWarningThresholds = [50, 20] as const;

export interface QuotaWarningState {
  readonly lastRemaining?: number;
  readonly firedThresholds: ReadonlySet<number>;
  readonly source?: string;
}

export interface QuotaWarningTransition {
  readonly state: QuotaWarningState;
  readonly threshold?: number;
  /** A synthetic placeholder never changes warning state or produces an event. */
  readonly ignored: boolean;
  /** A source change establishes a new baseline instead of crossing a threshold. */
  readonly baselineChanged: boolean;
}

export function clampQuotaWarningThreshold(value: number): number {
  return Math.min(Math.max(Math.trunc(value), 0), 99);
}

/** Matches `QuotaWarningThresholds.sanitized`: clamp, de-duplicate, descending. */
export function sanitizeQuotaWarningThresholds(raw: ReadonlyArray<number>): ReadonlyArray<number> {
  if (raw.length === 0) return defaultQuotaWarningThresholds;

  const unique = new Set(raw.filter(Number.isFinite).map(clampQuotaWarningThreshold));
  const sorted = [...unique].sort((left, right) => right - left);
  return sorted.length === 0 ? defaultQuotaWarningThresholds : sorted;
}

/** Threshold zero is retained for persistence but never creates a warning marker/event. */
export function activeQuotaWarningThresholds(raw: ReadonlyArray<number>): ReadonlyArray<number> {
  return sanitizeQuotaWarningThresholds(raw).filter((threshold) => threshold > 0);
}

/** Port of the two-field threshold editor's fallback and clamping behavior. */
export function resolveQuotaWarningThresholdPair(
  upper: number | undefined,
  lower: number | undefined,
): ReadonlyArray<number> {
  if (upper === undefined && lower === undefined) return defaultQuotaWarningThresholds;

  const resolvedUpper = clampQuotaWarningThreshold(upper ?? defaultQuotaWarningThresholds[0]);
  const lowerDefault =
    resolvedUpper < defaultQuotaWarningThresholds[1] ? 0 : defaultQuotaWarningThresholds[1];
  return sanitizeQuotaWarningThresholds([resolvedUpper, lower ?? lowerDefault]);
}

/** Swift's `RateWindow.remainingPercent`: only the lower bound is clamped. */
export function remainingQuotaPercent(window: Pick<RateWindow, "usedPercent">): number {
  return Math.max(0, 100 - window.usedPercent);
}

/**
 * Synthetic windows stand in for a lane a provider did not report. They must
 * not look like a fresh, empty quota lane to warning transitions.
 */
export function isUsableQuotaWindow(
  window: RateWindow | undefined,
  usageKnown = true,
): window is RateWindow {
  return window !== undefined && usageKnown && window.isSyntheticPlaceholder !== true;
}

export function crossedQuotaWarningThreshold(
  previousRemaining: number | undefined,
  currentRemaining: number,
  thresholds: ReadonlyArray<number>,
  alreadyFired: ReadonlySet<number>,
): number | undefined {
  const eligible = activeQuotaWarningThresholds(thresholds).filter(
    (threshold) => currentRemaining <= threshold && !alreadyFired.has(threshold),
  );
  if (eligible.length === 0) return undefined;

  if (previousRemaining !== undefined) {
    return eligible
      .filter((threshold) => previousRemaining > threshold)
      .sort((left, right) => left - right)[0];
  }
  return eligible.sort((left, right) => left - right)[0];
}

export function firedQuotaWarningThresholdsAfterWarning(
  threshold: number,
  thresholds: ReadonlyArray<number>,
): ReadonlySet<number> {
  return new Set(activeQuotaWarningThresholds(thresholds).filter((value) => value >= threshold));
}

export function quotaWarningThresholdsToClear(
  currentRemaining: number,
  alreadyFired: ReadonlySet<number>,
): ReadonlySet<number> {
  return new Set([...alreadyFired].filter((threshold) => currentRemaining > threshold));
}

/**
 * Advance the provider-agnostic portion of `handleQuotaWarningTransition`.
 * Source changes intentionally create a fresh baseline, while a synthetic
 * placeholder leaves the last real observation untouched.
 */
export function advanceQuotaWarningState(input: {
  readonly previous?: QuotaWarningState;
  readonly window: RateWindow;
  readonly thresholds: ReadonlyArray<number>;
  readonly source?: string;
}): QuotaWarningTransition {
  const previous = input.previous;
  if (input.window.isSyntheticPlaceholder === true) {
    return {
      state: previous ?? { firedThresholds: new Set<number>() },
      ignored: true,
      baselineChanged: false,
    };
  }

  const currentRemaining = remainingQuotaPercent(input.window);
  if (previous?.source !== input.source && previous !== undefined) {
    return {
      state: quotaWarningState(currentRemaining, new Set<number>(), input.source),
      ignored: false,
      baselineChanged: true,
    };
  }

  const previouslyFired = previous?.firedThresholds ?? new Set<number>();
  const cleared = quotaWarningThresholdsToClear(currentRemaining, previouslyFired);
  const fired = new Set([...previouslyFired].filter((threshold) => !cleared.has(threshold)));
  const threshold = crossedQuotaWarningThreshold(
    previous?.lastRemaining,
    currentRemaining,
    input.thresholds,
    fired,
  );
  if (threshold !== undefined) {
    for (const value of firedQuotaWarningThresholdsAfterWarning(threshold, input.thresholds)) {
      fired.add(value);
    }
  }

  return {
    state: quotaWarningState(currentRemaining, fired, input.source),
    ...(threshold === undefined ? {} : { threshold }),
    ignored: false,
    baselineChanged: false,
  };
}

function quotaWarningState(
  lastRemaining: number,
  firedThresholds: ReadonlySet<number>,
  source: string | undefined,
): QuotaWarningState {
  return {
    lastRemaining,
    firedThresholds,
    ...(source === undefined ? {} : { source }),
  };
}
