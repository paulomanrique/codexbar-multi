import type { ProviderId } from "@codexbar/contracts";

import { didResetBoundaryAdvance } from "./reset.ts";

/** Port of `SessionQuotaTransition` from the Swift oracle. */
export type SessionQuotaTransition = "none" | "depleted" | "restored";

export type SessionQuotaTransitionOutcome =
  | SessionQuotaTransition
  | "baseline-changed"
  | "stale-codex-observation"
  | "suppressed-codex-restore"
  | "awaiting-codex-restore-confirmation";

export interface SessionQuotaTransitionState {
  readonly remaining: number;
  readonly source: string;
  readonly observedAt: Date;
  /** Opaque, host-produced account/credential ownership fingerprint. */
  readonly codexOwnerKey?: string;
  readonly trustedResetBoundary?: Date;
  readonly pendingCodexRestoreObservationAt?: Date;
}

export interface SessionQuotaTransitionObservation {
  readonly provider: ProviderId;
  readonly remaining: number;
  readonly source: string;
  readonly resetBoundary?: Date;
  readonly observedAt: Date;
  readonly evaluationTime: Date;
  readonly codexOwnerKey?: string;
}

export interface SessionQuotaTransitionEvaluation {
  readonly outcome: SessionQuotaTransitionOutcome;
  readonly state: SessionQuotaTransitionState;
}

export const sessionQuotaDepletedThreshold = 0.0001;

export function isSessionQuotaDepleted(remaining: number | undefined): boolean {
  return remaining !== undefined && remaining <= sessionQuotaDepletedThreshold;
}

export function sessionQuotaTransition(
  previousRemaining: number | undefined,
  currentRemaining: number | undefined,
): SessionQuotaTransition {
  if (previousRemaining === undefined || currentRemaining === undefined) return "none";
  const wasDepleted = isSessionQuotaDepleted(previousRemaining);
  const depleted = isSessionQuotaDepleted(currentRemaining);
  if (!wasDepleted && depleted) return "depleted";
  if (wasDepleted && !depleted) return "restored";
  return "none";
}

/**
 * Provider-independent transition reducer with the Codex ownership/reset
 * safeguards preserved from `SessionQuotaTransitionReducer`.
 *
 * The host owns persistence and notification delivery. Dates and the opaque
 * owner fingerprint never cross into the renderer through this API.
 */
export function evaluateSessionQuotaTransition(input: {
  readonly previous?: SessionQuotaTransitionState;
  readonly observation: SessionQuotaTransitionObservation;
  readonly notificationsEnabled: boolean;
  readonly forceBaseline?: boolean;
}): SessionQuotaTransitionEvaluation {
  const { observation } = input;
  if (input.forceBaseline === true) {
    return { outcome: "baseline-changed", state: baselineState(observation) };
  }

  const previous = input.previous;
  if (previous === undefined) {
    return {
      outcome:
        input.notificationsEnabled && isSessionQuotaDepleted(observation.remaining)
          ? "depleted"
          : "none",
      state: baselineState(observation),
    };
  }

  const codex = observation.provider === "codex";
  const ownerChanged = codex && previous.codexOwnerKey !== observation.codexOwnerKey;
  if (previous.source !== observation.source || ownerChanged) {
    return { outcome: "baseline-changed", state: baselineState(observation) };
  }

  if (codex && observation.observedAt.getTime() <= previous.observedAt.getTime()) {
    return { outcome: "stale-codex-observation", state: previous };
  }

  if (!input.notificationsEnabled) {
    return { outcome: "none", state: updatedState(previous, observation) };
  }

  const transition = sessionQuotaTransition(previous.remaining, observation.remaining);
  if (transition !== "restored" || !codex) {
    const preserveDepletedBoundary =
      codex &&
      previous.trustedResetBoundary !== undefined &&
      isSessionQuotaDepleted(previous.remaining) &&
      isSessionQuotaDepleted(observation.remaining);
    const boundary = previous.trustedResetBoundary;
    const preserveCodexBoundary =
      preserveDepletedBoundary ||
      (codex &&
        boundary !== undefined &&
        (observation.evaluationTime.getTime() < boundary.getTime() ||
          observation.observedAt.getTime() < boundary.getTime()));
    return {
      outcome: transition,
      state: updatedState(previous, observation, preserveCodexBoundary),
    };
  }

  const trustedBoundary = previous.trustedResetBoundary;
  if (trustedBoundary !== undefined) {
    if (
      observation.evaluationTime.getTime() < trustedBoundary.getTime() ||
      observation.observedAt.getTime() < trustedBoundary.getTime()
    ) {
      return {
        outcome: "suppressed-codex-restore",
        state: preservedDepletedState(previous, observation),
      };
    }

    const resetBoundary = validResetBoundary(observation);
    if (
      resetBoundary !== undefined &&
      !equivalentResetBoundaries(trustedBoundary, resetBoundary) &&
      resetBoundary.getTime() > trustedBoundary.getTime()
    ) {
      return { outcome: "restored", state: updatedState(previous, observation) };
    }
  }

  const pending = previous.pendingCodexRestoreObservationAt;
  if (pending !== undefined && observation.observedAt.getTime() > pending.getTime()) {
    return { outcome: "restored", state: updatedState(previous, observation) };
  }
  return {
    outcome: "awaiting-codex-restore-confirmation",
    state: preservedDepletedState(previous, observation, observation.observedAt),
  };
}

export function transitionForSessionQuotaOutcome(
  outcome: SessionQuotaTransitionOutcome,
): SessionQuotaTransition {
  return outcome === "depleted" || outcome === "restored" ? outcome : "none";
}

function baselineState(
  observation: SessionQuotaTransitionObservation,
): SessionQuotaTransitionState {
  const codex = observation.provider === "codex";
  const boundary = codex ? validResetBoundary(observation) : undefined;
  return state({
    remaining: observation.remaining,
    source: observation.source,
    observedAt: observation.observedAt,
    ...(codex && observation.codexOwnerKey !== undefined
      ? { codexOwnerKey: observation.codexOwnerKey }
      : {}),
    ...(boundary === undefined ? {} : { trustedResetBoundary: boundary }),
  });
}

function updatedState(
  previous: SessionQuotaTransitionState,
  observation: SessionQuotaTransitionObservation,
  preserveCodexResetBoundary = false,
): SessionQuotaTransitionState {
  const codex = observation.provider === "codex";
  let boundary: Date | undefined;
  if (codex) {
    boundary = preserveCodexResetBoundary
      ? previous.trustedResetBoundary
      : monotonicResetBoundary(previous.trustedResetBoundary, validResetBoundary(observation));
  }
  return state({
    remaining: observation.remaining,
    source: observation.source,
    observedAt: observation.observedAt,
    ...(codex && observation.codexOwnerKey !== undefined
      ? { codexOwnerKey: observation.codexOwnerKey }
      : {}),
    ...(boundary === undefined ? {} : { trustedResetBoundary: boundary }),
  });
}

function preservedDepletedState(
  previous: SessionQuotaTransitionState,
  observation: SessionQuotaTransitionObservation,
  pendingCodexRestoreObservationAt?: Date,
): SessionQuotaTransitionState {
  return state({
    remaining: previous.remaining,
    source: observation.source,
    observedAt: observation.observedAt,
    ...(observation.codexOwnerKey === undefined
      ? {}
      : { codexOwnerKey: observation.codexOwnerKey }),
    ...(previous.trustedResetBoundary === undefined
      ? {}
      : { trustedResetBoundary: previous.trustedResetBoundary }),
    ...(pendingCodexRestoreObservationAt === undefined ? {} : { pendingCodexRestoreObservationAt }),
  });
}

function monotonicResetBoundary(previous: Date | undefined, current: Date | undefined) {
  if (previous === undefined) return current;
  return didResetBoundaryAdvance({
    previous,
    ...(current === undefined ? {} : { current }),
    equivalent: equivalentResetBoundaries,
  })
    ? current
    : previous;
}

function validResetBoundary(observation: SessionQuotaTransitionObservation): Date | undefined {
  const candidate = observation.resetBoundary;
  if (
    candidate === undefined ||
    candidate.getTime() <= observation.observedAt.getTime() ||
    candidate.getTime() <= observation.evaluationTime.getTime()
  ) {
    return undefined;
  }
  return candidate;
}

/** Swift treats reset instants within two minutes as the same boundary. */
function equivalentResetBoundaries(left: Date, right: Date): boolean {
  return Math.abs(left.getTime() - right.getTime()) < 120_000;
}

function state(input: {
  readonly remaining: number;
  readonly source: string;
  readonly observedAt: Date;
  readonly codexOwnerKey?: string;
  readonly trustedResetBoundary?: Date;
  readonly pendingCodexRestoreObservationAt?: Date;
}): SessionQuotaTransitionState {
  return {
    remaining: input.remaining,
    source: input.source,
    observedAt: input.observedAt,
    ...(input.codexOwnerKey === undefined ? {} : { codexOwnerKey: input.codexOwnerKey }),
    ...(input.trustedResetBoundary === undefined
      ? {}
      : { trustedResetBoundary: input.trustedResetBoundary }),
    ...(input.pendingCodexRestoreObservationAt === undefined
      ? {}
      : { pendingCodexRestoreObservationAt: input.pendingCodexRestoreObservationAt }),
  };
}
