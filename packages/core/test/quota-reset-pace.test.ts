import { describe, expect, it } from "vite-plus/test";

import type { RateWindow, UsageSnapshot } from "@codexbar/contracts";
import {
  activeQuotaWarningThresholds,
  advanceQuotaWarningState,
  backfillRateWindowReset,
  backfillSnapshotResetTimes,
  calculateUsagePace,
  createHistoricalUsagePace,
  didResetBoundaryAdvance,
  elapsedWindowPercent,
  isUsableQuotaWindow,
  nextResetBoundaryRefresh,
  paceElapsedBoundary,
  remainingQuotaPercent,
  resolveQuotaWarningThresholdPair,
  sanitizeQuotaWarningThresholds,
} from "../src/index.ts";

const epoch = new Date(0);
const minuteMs = 60_000;

function iso(date: Date): string {
  return date.toISOString();
}

function rateWindow(input: {
  readonly usedPercent: number;
  readonly windowMinutes?: number;
  readonly resetsAt?: Date;
  readonly resetDescription?: string;
  readonly nextRegenPercent?: number;
  readonly isSyntheticPlaceholder?: boolean;
}): RateWindow {
  return {
    usedPercent: input.usedPercent,
    ...(input.windowMinutes === undefined ? {} : { windowMinutes: input.windowMinutes }),
    ...(input.resetsAt === undefined ? {} : { resetsAt: iso(input.resetsAt) }),
    ...(input.resetDescription === undefined ? {} : { resetDescription: input.resetDescription }),
    ...(input.nextRegenPercent === undefined ? {} : { nextRegenPercent: input.nextRegenPercent }),
    ...(input.isSyntheticPlaceholder === undefined
      ? {}
      : { isSyntheticPlaceholder: input.isSyntheticPlaceholder }),
  };
}

function snapshot(input: {
  readonly updatedAt: Date;
  readonly primary?: RateWindow;
  readonly secondary?: RateWindow;
  readonly tertiary?: RateWindow;
  readonly extraRateWindows?: UsageSnapshot["extraRateWindows"];
  readonly identity?: UsageSnapshot["identity"];
}): UsageSnapshot {
  return {
    ...(input.primary === undefined ? {} : { primary: input.primary }),
    ...(input.secondary === undefined ? {} : { secondary: input.secondary }),
    ...(input.tertiary === undefined ? {} : { tertiary: input.tertiary }),
    ...(input.extraRateWindows === undefined ? {} : { extraRateWindows: input.extraRateWindows }),
    details: [],
    updatedAt: iso(input.updatedAt),
    ...(input.identity === undefined ? {} : { identity: input.identity }),
  };
}

describe("usage pace (Swift parity)", () => {
  it("computes weekly delta, eta, stage, and headroom", () => {
    const pace = calculateUsagePace(
      rateWindow({
        usedPercent: 50,
        windowMinutes: 10_080,
        resetsAt: new Date(4 * 24 * 60 * minuteMs),
      }),
      { now: epoch },
    );

    expect(pace).toMatchObject({
      stage: "ahead",
      willLastToReset: false,
      expectedUsedPercent: expect.closeTo(42.857, 2),
      deltaPercent: expect.closeTo(7.143, 2),
      etaSeconds: expect.closeTo(3 * 24 * 60 * 60, 4),
    });
  });

  it("does not fabricate pace outside a known active window", () => {
    expect(
      calculateUsagePace(rateWindow({ usedPercent: 10, windowMinutes: 10_080 }), { now: epoch }),
    ).toBeUndefined();
    expect(
      calculateUsagePace(
        rateWindow({
          usedPercent: 10,
          windowMinutes: 10_080,
          resetsAt: new Date(9 * 24 * 60 * minuteMs),
        }),
        { now: epoch },
      ),
    ).toBeUndefined();
    expect(
      calculateUsagePace(
        rateWindow({
          usedPercent: 12,
          windowMinutes: 10_080,
          resetsAt: new Date(7 * 24 * 60 * minuteMs),
        }),
        { now: epoch },
      ),
    ).toBeUndefined();
  });

  it("preserves the workday pace and weekend ETA semantics", () => {
    const resetsAt = new Date("2026-06-17T00:00:00.000Z");
    const now = new Date("2026-06-12T12:00:00.000Z");
    const pace = calculateUsagePace(
      rateWindow({ usedPercent: 60, windowMinutes: 10_080, resetsAt }),
      { now, workDays: 5, timeZone: "UTC" },
    );

    expect(pace).toMatchObject({
      willLastToReset: false,
      etaSeconds: expect.closeTo(88 * 60 * 60, 4),
    });
  });

  it("does not mark zero usage safe before the first work day", () => {
    const resetsAt = new Date("2026-06-14T00:00:00.000Z");
    const pace = calculateUsagePace(
      rateWindow({ usedPercent: 0, windowMinutes: 10_080, resetsAt }),
      { now: new Date("2026-06-07T12:00:00.000Z"), workDays: 5, timeZone: "UTC" },
    );

    expect(pace).toMatchObject({ expectedUsedPercent: 0, willLastToReset: false });
  });

  it("calculates historical pace using remaining projected usage for speed headroom", () => {
    const pace = createHistoricalUsagePace({
      expectedUsedPercent: 45,
      actualUsedPercent: 20,
      willLastToReset: true,
      runOutProbability: 0,
      projectedRemainingUsage: 20,
    });

    expect(pace).toMatchObject({ stage: "farBehind", speedMultiplierToReset: 4 });
  });

  it("preserves elapsed pace boundaries", () => {
    const window = rateWindow({
      usedPercent: 40,
      windowMinutes: 300,
      resetsAt: new Date(300 * minuteMs),
    });
    expect(paceElapsedBoundary({ window, minimumElapsedPercent: 3 })?.getTime()).toBe(9 * minuteMs);
    expect(elapsedWindowPercent(window, new Date(150 * minuteMs))).toBe(50);
  });
});

describe("quota warning policy (Swift parity)", () => {
  it("sanitizes, de-duplicates, and resolves threshold defaults", () => {
    expect(sanitizeQuotaWarningThresholds([120, 20, 20, -5, 50])).toEqual([99, 50, 20, 0]);
    expect(activeQuotaWarningThresholds([10, 0])).toEqual([10]);
    expect(resolveQuotaWarningThresholdPair(undefined, undefined)).toEqual([50, 20]);
    expect(resolveQuotaWarningThresholdPair(undefined, 10)).toEqual([50, 10]);
    expect(resolveQuotaWarningThresholdPair(10, undefined)).toEqual([10, 0]);
    expect(resolveQuotaWarningThresholdPair(120, -5)).toEqual([99, 0]);
  });

  it("crosses each warning threshold once and re-arms after recovery", () => {
    const first = advanceQuotaWarningState({
      window: rateWindow({ usedPercent: 85 }),
      thresholds: [50, 20],
    });
    expect(first.threshold).toBe(20);
    expect(first.state.firedThresholds).toEqual(new Set([50, 20]));

    const held = advanceQuotaWarningState({
      previous: first.state,
      window: rateWindow({ usedPercent: 90 }),
      thresholds: [50, 20],
    });
    expect(held.threshold).toBeUndefined();

    const recovered = advanceQuotaWarningState({
      previous: held.state,
      window: rateWindow({ usedPercent: 20 }),
      thresholds: [50, 20],
    });
    expect(recovered.state.firedThresholds).toEqual(new Set());

    const crossedAgain = advanceQuotaWarningState({
      previous: recovered.state,
      window: rateWindow({ usedPercent: 85 }),
      thresholds: [50, 20],
    });
    expect(crossedAgain.threshold).toBe(20);
  });

  it("never turns a synthetic placeholder into a quota warning", () => {
    const prior = advanceQuotaWarningState({
      window: rateWindow({ usedPercent: 10 }),
      thresholds: [50, 20],
    }).state;
    const result = advanceQuotaWarningState({
      previous: prior,
      window: rateWindow({ usedPercent: 100, isSyntheticPlaceholder: true }),
      thresholds: [50, 20],
    });

    expect(result).toMatchObject({ ignored: true, baselineChanged: false, state: prior });
    expect(remainingQuotaPercent(rateWindow({ usedPercent: 120 }))).toBe(0);
    expect(isUsableQuotaWindow(rateWindow({ usedPercent: 0, isSyntheticPlaceholder: true }))).toBe(
      false,
    );
    expect(isUsableQuotaWindow(rateWindow({ usedPercent: 0 }), false)).toBe(false);
  });

  it("establishes a new baseline when a provider changes quota source", () => {
    const previous = advanceQuotaWarningState({
      window: rateWindow({ usedPercent: 10 }),
      thresholds: [50, 20],
      source: "api",
    }).state;
    const result = advanceQuotaWarningState({
      previous,
      window: rateWindow({ usedPercent: 90 }),
      thresholds: [50, 20],
      source: "cli",
    });
    expect(result).toMatchObject({ baselineChanged: true, ignored: false });
    expect(result.threshold).toBeUndefined();
  });
});

describe("reset metadata and boundary refresh policy (Swift parity)", () => {
  it("backfills only a future cached reset while preserving fresh quota fields", () => {
    const now = new Date("2027-01-15T00:00:00.000Z");
    const reset = new Date(now.getTime() + 60 * minuteMs);
    const result = backfillRateWindowReset(
      rateWindow({ usedPercent: 62, nextRegenPercent: 4 }),
      rateWindow({
        usedPercent: 50,
        windowMinutes: 300,
        resetsAt: reset,
        resetDescription: "Resets in 1h",
        nextRegenPercent: 9,
      }),
      now,
    );

    expect(result).toMatchObject({
      usedPercent: 62,
      nextRegenPercent: 4,
      windowMinutes: 300,
      resetsAt: iso(reset),
      resetDescription: "Resets in 1h",
    });
    expect(
      backfillRateWindowReset(
        rateWindow({ usedPercent: 62 }),
        rateWindow({
          usedPercent: 50,
          windowMinutes: 300,
          resetsAt: new Date(now.getTime() - minuteMs),
        }),
        now,
      ),
    ).toEqual(rateWindow({ usedPercent: 62 }));
  });

  it("keeps the synthetic-placeholder marker through reset backfill", () => {
    const now = new Date("2027-01-15T00:00:00.000Z");
    const result = backfillRateWindowReset(
      rateWindow({ usedPercent: 0, windowMinutes: 300, isSyntheticPlaceholder: true }),
      rateWindow({
        usedPercent: 12,
        windowMinutes: 300,
        resetsAt: new Date(now.getTime() + minuteMs),
      }),
      now,
    );
    expect(result).toMatchObject({
      isSyntheticPlaceholder: true,
      resetsAt: "2027-01-15T00:01:00.000Z",
    });
  });

  it("does not backfill a reset from another stable account", () => {
    const now = new Date("2027-01-15T00:00:00.000Z");
    const fresh = snapshot({
      updatedAt: now,
      primary: rateWindow({ usedPercent: 66 }),
      identity: { accountEmail: "shared@example.com", accountId: "account-b" },
    });
    const cached = snapshot({
      updatedAt: new Date(now.getTime() - minuteMs),
      primary: rateWindow({
        usedPercent: 40,
        windowMinutes: 300,
        resetsAt: new Date(now.getTime() + minuteMs),
      }),
      identity: { accountEmail: "shared@example.com", accountId: "account-a" },
    });
    expect(backfillSnapshotResetTimes(fresh, cached, now)).toBe(fresh);
  });

  it("schedules the earliest unattempted reset boundary before normal polling", () => {
    const now = new Date(5_000_000);
    const primaryReset = new Date(now.getTime() + 20 * minuteMs);
    const extraReset = new Date(now.getTime() + 4 * minuteMs);
    const candidate = nextResetBoundaryRefresh({
      snapshots: [
        snapshot({
          updatedAt: now,
          primary: rateWindow({ usedPercent: 10, windowMinutes: 300, resetsAt: primaryReset }),
          extraRateWindows: [
            {
              id: "extra",
              title: "Extra",
              window: rateWindow({ usedPercent: 50, windowMinutes: 60, resetsAt: extraReset }),
            },
          ],
        }),
      ],
      normalRefreshIntervalMs: 30 * minuteMs,
      now,
    });
    expect(candidate?.refreshAt.getTime()).toBe(extraReset.getTime() + 30_000);
    expect(candidate?.boundaryRefreshAt.getTime()).toBe(extraReset.getTime() + 30_000);
  });

  it("honors low-power minimums and retries a past boundary promptly once", () => {
    const now = new Date(2_000_000);
    const reset = new Date(now.getTime() - 3 * minuteMs);
    const stale = snapshot({
      updatedAt: new Date(reset.getTime() - minuteMs),
      primary: rateWindow({ usedPercent: 100, windowMinutes: 300, resetsAt: reset }),
    });
    const retry = nextResetBoundaryRefresh({
      snapshots: [stale],
      normalRefreshIntervalMs: 30 * minuteMs,
      now,
    });
    expect(retry?.refreshAt.getTime()).toBe(now.getTime() + 5_000);
    expect(
      nextResetBoundaryRefresh({
        snapshots: [stale],
        normalRefreshIntervalMs: 30 * minuteMs,
        attemptedBoundaryRefreshes: new Set([reset.getTime() + 30_000]),
        now,
      }),
    ).toBeUndefined();

    const lowPower = nextResetBoundaryRefresh({
      snapshots: [
        snapshot({
          updatedAt: now,
          primary: rateWindow({
            usedPercent: 20,
            resetsAt: new Date(now.getTime() + 5 * minuteMs),
          }),
        }),
      ],
      normalRefreshIntervalMs: 60 * minuteMs,
      minimumAutomaticRefreshIntervalMs: 30 * minuteMs,
      now,
    });
    expect(lowPower?.refreshAt.getTime()).toBe(now.getTime() + 30 * minuteMs);
  });

  it("only treats a strictly newer, non-equivalent reset as advanced", () => {
    const earlier = new Date(1_000);
    const later = new Date(2_000);
    expect(didResetBoundaryAdvance({ current: later })).toBe(true);
    expect(didResetBoundaryAdvance({ current: later, requiresPreviousBoundary: true })).toBe(false);
    expect(didResetBoundaryAdvance({ previous: earlier, current: later })).toBe(true);
    expect(didResetBoundaryAdvance({ previous: later, current: earlier })).toBe(false);
    expect(
      didResetBoundaryAdvance({ previous: earlier, current: later, equivalent: () => true }),
    ).toBe(false);
  });
});
