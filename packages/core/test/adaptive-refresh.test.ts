import { describe, expect, it } from "vite-plus/test";

import {
  nextAdaptiveRefreshDelay,
  nominalAdaptiveRefreshIntervalMs,
  type AdaptiveRefreshInput,
  type AdaptiveRefreshReason,
  type ThermalPressure,
} from "../src/adaptive-refresh.ts";

const referenceNow = new Date(800_000_000_000);

function input(options: {
  ageSeconds: number | null;
  codingActivityAgeSeconds?: number | null;
  lowPowerModeEnabled?: boolean;
  thermalPressure?: ThermalPressure;
}): AdaptiveRefreshInput {
  const atAge = (ageSeconds: number): Date => new Date(referenceNow.getTime() - ageSeconds * 1_000);

  return {
    now: referenceNow,
    lastMenuOpenAt: options.ageSeconds == null ? null : atAge(options.ageSeconds),
    lastCodingActivityAt:
      options.codingActivityAgeSeconds == null ? null : atAge(options.codingActivityAgeSeconds),
    lowPowerModeEnabled: options.lowPowerModeEnabled ?? false,
    thermalPressure: options.thermalPressure ?? "nominal",
  };
}

describe("adaptive refresh policy (Swift parity)", () => {
  it.each<[number, AdaptiveRefreshReason, number]>([
    [-600, "recentInteraction", 120],
    [0, "recentInteraction", 120],
    [299, "recentInteraction", 120],
    [300, "recentInteraction", 120],
    [301, "warm", 300],
    [3_599, "warm", 300],
    [3_600, "warm", 300],
    [3_601, "idle", 900],
    [14_399, "idle", 900],
    [14_400, "longIdle", 1_800],
    [100_000, "longIdle", 1_800],
  ])("maps menu age %s to %s", (ageSeconds, expectedReason, expectedDelaySeconds) => {
    expect(nextAdaptiveRefreshDelay(input({ ageSeconds }))).toEqual({
      delayMs: expectedDelaySeconds * 1_000,
      reason: expectedReason,
    });
  });

  it("treats a missing menu timestamp as long idle", () => {
    expect(nextAdaptiveRefreshDelay(input({ ageSeconds: null }))).toEqual({
      delayMs: 30 * 60_000,
      reason: "longIdle",
    });
  });

  it("lets low power and thermal constraints win", () => {
    expect(nextAdaptiveRefreshDelay(input({ ageSeconds: 0, lowPowerModeEnabled: true }))).toEqual({
      delayMs: 30 * 60_000,
      reason: "constrained",
    });
    expect(
      nextAdaptiveRefreshDelay(input({ ageSeconds: null, thermalPressure: "constrained" })),
    ).toEqual({ delayMs: 30 * 60_000, reason: "constrained" });
  });

  it.each([3_601, 14_400, 100_000])(
    "caps slow decisions when coding activity is recent",
    (ageSeconds) => {
      expect(nextAdaptiveRefreshDelay(input({ ageSeconds, codingActivityAgeSeconds: 0 }))).toEqual({
        delayMs: 5 * 60_000,
        reason: "codingActivity",
      });
    },
  );

  it("does not lengthen recent or warm decisions", () => {
    expect(nextAdaptiveRefreshDelay(input({ ageSeconds: 0, codingActivityAgeSeconds: 0 }))).toEqual(
      { delayMs: 2 * 60_000, reason: "recentInteraction" },
    );
    expect(
      nextAdaptiveRefreshDelay(input({ ageSeconds: 301, codingActivityAgeSeconds: 0 })),
    ).toEqual({ delayMs: 5 * 60_000, reason: "warm" });
  });

  it("keeps the coding activity boundary exclusive", () => {
    expect(
      nextAdaptiveRefreshDelay(input({ ageSeconds: null, codingActivityAgeSeconds: 299 })),
    ).toEqual({ delayMs: 5 * 60_000, reason: "codingActivity" });
    expect(
      nextAdaptiveRefreshDelay(input({ ageSeconds: null, codingActivityAgeSeconds: 300 })),
    ).toEqual({ delayMs: 30 * 60_000, reason: "longIdle" });
  });

  it("treats future timestamps as recent", () => {
    expect(nextAdaptiveRefreshDelay(input({ ageSeconds: -1_000_000 }))).toEqual({
      delayMs: 2 * 60_000,
      reason: "recentInteraction",
    });
  });

  it("keeps every decision inside the canonical bounds", () => {
    const ages = [null, -1_000_000, 0, 300, 301, 3_600, 3_601, 14_399, 14_400];
    for (const ageSeconds of ages) {
      for (const lowPowerModeEnabled of [false, true]) {
        for (const thermalPressure of ["nominal", "constrained"] as const) {
          const { delayMs } = nextAdaptiveRefreshDelay(
            input({ ageSeconds, lowPowerModeEnabled, thermalPressure }),
          );
          expect(delayMs).toBeGreaterThanOrEqual(2 * 60_000);
          expect(delayMs).toBeLessThanOrEqual(30 * 60_000);
        }
      }
    }
  });

  it("keeps the nominal heuristic interval at five minutes", () => {
    expect(nominalAdaptiveRefreshIntervalMs).toBe(5 * 60_000);
  });
});
