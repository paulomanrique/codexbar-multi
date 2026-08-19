/**
 * Canonical adaptive-refresh decision table ported from
 * Sources/AdaptiveRefreshCore/AdaptiveRefreshPolicyCore.swift.
 *
 * Platform adapters normalize power and thermal signals before calling this
 * function. The policy itself remains platform-independent and deterministic.
 */
export type ThermalPressure = "nominal" | "constrained";

export type AdaptiveRefreshReason =
  | "recentInteraction"
  | "codingActivity"
  | "warm"
  | "idle"
  | "longIdle"
  | "constrained";

export interface AdaptiveRefreshInput {
  readonly now: Date;
  readonly lastMenuOpenAt: Date | null;
  readonly lastCodingActivityAt?: Date | null;
  readonly lowPowerModeEnabled: boolean;
  readonly thermalPressure: ThermalPressure;
}

export interface AdaptiveRefreshDecision {
  readonly delayMs: number;
  readonly reason: AdaptiveRefreshReason;
}

const MINUTE_MS = 60_000;
const RECENT_INTERACTION_THRESHOLD_MS = 5 * MINUTE_MS;
const WARM_THRESHOLD_MS = 60 * MINUTE_MS;
const IDLE_THRESHOLD_MS = 4 * 60 * MINUTE_MS;
const CODING_ACTIVITY_THRESHOLD_MS = 5 * MINUTE_MS;

const RECENT_INTERACTION_DELAY_MS = 2 * MINUTE_MS;
const WARM_DELAY_MS = 5 * MINUTE_MS;
const IDLE_DELAY_MS = 15 * MINUTE_MS;
const LONG_IDLE_DELAY_MS = 30 * MINUTE_MS;
const CONSTRAINED_DELAY_MS = 30 * MINUTE_MS;
const CODING_ACTIVITY_DELAY_CAP_MS = 5 * MINUTE_MS;

/** Representative cadence for consumers that cannot access live state. */
export const nominalAdaptiveRefreshIntervalMs = 5 * MINUTE_MS;

export function nextAdaptiveRefreshDelay(input: AdaptiveRefreshInput): AdaptiveRefreshDecision {
  if (input.lowPowerModeEnabled || input.thermalPressure === "constrained") {
    return { delayMs: CONSTRAINED_DELAY_MS, reason: "constrained" };
  }

  const baseDecision = menuActivityDecision(input);
  const lastCodingActivityAt = input.lastCodingActivityAt;
  if (lastCodingActivityAt == null) return baseDecision;

  const codingActivityAgeMs = input.now.getTime() - lastCodingActivityAt.getTime();
  if (
    codingActivityAgeMs >= CODING_ACTIVITY_THRESHOLD_MS ||
    baseDecision.delayMs <= CODING_ACTIVITY_DELAY_CAP_MS
  ) {
    return baseDecision;
  }

  return {
    delayMs: CODING_ACTIVITY_DELAY_CAP_MS,
    reason: "codingActivity",
  };
}

function menuActivityDecision(input: AdaptiveRefreshInput): AdaptiveRefreshDecision {
  if (input.lastMenuOpenAt == null) {
    return { delayMs: LONG_IDLE_DELAY_MS, reason: "longIdle" };
  }

  // A future or clock-adjusted timestamp has negative age and is recent,
  // matching Date.timeIntervalSince in the Swift implementation.
  const ageMs = input.now.getTime() - input.lastMenuOpenAt.getTime();

  if (ageMs <= RECENT_INTERACTION_THRESHOLD_MS) {
    return {
      delayMs: RECENT_INTERACTION_DELAY_MS,
      reason: "recentInteraction",
    };
  }
  if (ageMs <= WARM_THRESHOLD_MS) {
    return { delayMs: WARM_DELAY_MS, reason: "warm" };
  }
  if (ageMs < IDLE_THRESHOLD_MS) {
    return { delayMs: IDLE_DELAY_MS, reason: "idle" };
  }
  return { delayMs: LONG_IDLE_DELAY_MS, reason: "longIdle" };
}
