import { describe, expect, it } from "vite-plus/test";

import {
  evaluateSessionQuotaTransition,
  isSessionQuotaDepleted,
  sessionQuotaTransition,
  transitionForSessionQuotaOutcome,
  type SessionQuotaTransitionObservation,
  type SessionQuotaTransitionState,
} from "../src/index.ts";

const start = new Date("2026-08-21T00:00:00.000Z");
const at = (seconds: number) => new Date(start.getTime() + seconds * 1_000);

function observation(
  input: Partial<SessionQuotaTransitionObservation> &
    Pick<SessionQuotaTransitionObservation, "remaining">,
): SessionQuotaTransitionObservation {
  return {
    provider: "codex",
    source: "primary",
    observedAt: at(60),
    evaluationTime: at(60),
    codexOwnerKey: "owner-a",
    ...input,
  };
}

function depletedState(
  input: Partial<SessionQuotaTransitionState> = {},
): SessionQuotaTransitionState {
  return {
    remaining: 0,
    source: "primary",
    observedAt: start,
    codexOwnerKey: "owner-a",
    ...input,
  };
}

describe("session quota transition policy (Swift parity)", () => {
  it("uses the Swift depletion epsilon and detects only real crossings", () => {
    expect(isSessionQuotaDepleted(undefined)).toBe(false);
    expect(isSessionQuotaDepleted(0.00001)).toBe(true);
    expect(sessionQuotaTransition(undefined, 0)).toBe("none");
    expect(sessionQuotaTransition(12, 0)).toBe("depleted");
    expect(sessionQuotaTransition(0, 5)).toBe("restored");
    expect(sessionQuotaTransition(0, 0.00001)).toBe("none");
  });

  it("notifies for an initially depleted lane only when detection is enabled", () => {
    expect(
      evaluateSessionQuotaTransition({
        observation: observation({ remaining: 0 }),
        notificationsEnabled: true,
      }).outcome,
    ).toBe("depleted");
    expect(
      evaluateSessionQuotaTransition({
        observation: observation({ remaining: 0 }),
        notificationsEnabled: false,
      }).outcome,
    ).toBe("none");
  });

  it("establishes a new baseline after source, owner, or forced-baseline changes", () => {
    const previous = depletedState();
    for (const current of [
      observation({ remaining: 100, source: "cli" }),
      observation({ remaining: 100, codexOwnerKey: "owner-b" }),
    ]) {
      expect(
        evaluateSessionQuotaTransition({
          previous,
          observation: current,
          notificationsEnabled: true,
        }),
      ).toMatchObject({ outcome: "baseline-changed", state: { remaining: 100 } });
    }
    expect(
      evaluateSessionQuotaTransition({
        previous,
        observation: observation({ remaining: 100 }),
        notificationsEnabled: true,
        forceBaseline: true,
      }).outcome,
    ).toBe("baseline-changed");
  });

  it("rejects equal and older Codex observations without mutating state", () => {
    const previous = depletedState({ observedAt: at(120) });
    for (const observedAt of [at(60), at(120)]) {
      const result = evaluateSessionQuotaTransition({
        previous,
        observation: observation({ remaining: 100, observedAt, evaluationTime: at(130) }),
        notificationsEnabled: true,
      });
      expect(result).toEqual({ outcome: "stale-codex-observation", state: previous });
    }
  });

  it("suppresses a transient Codex restore before its trusted reset", () => {
    const boundary = at(300);
    const result = evaluateSessionQuotaTransition({
      previous: depletedState({ trustedResetBoundary: boundary }),
      observation: observation({
        remaining: 80,
        resetBoundary: at(600),
        observedAt: at(120),
        evaluationTime: at(120),
      }),
      notificationsEnabled: true,
    });
    expect(result).toMatchObject({
      outcome: "suppressed-codex-restore",
      state: { remaining: 0, trustedResetBoundary: boundary },
    });
  });

  it("accepts an advanced, still-valid boundary after the trusted reset", () => {
    const previousBoundary = at(300);
    const advancedBoundary = at(700);
    const result = evaluateSessionQuotaTransition({
      previous: depletedState({ trustedResetBoundary: previousBoundary }),
      observation: observation({
        remaining: 80,
        resetBoundary: advancedBoundary,
        observedAt: at(360),
        evaluationTime: at(360),
      }),
      notificationsEnabled: true,
    });
    expect(result).toMatchObject({
      outcome: "restored",
      state: { remaining: 80, trustedResetBoundary: advancedBoundary },
    });
  });

  it("requires two fresh positive samples for ambiguous post-reset restoration", () => {
    const first = evaluateSessionQuotaTransition({
      previous: depletedState({ trustedResetBoundary: at(300) }),
      observation: observation({ remaining: 80, observedAt: at(360), evaluationTime: at(360) }),
      notificationsEnabled: true,
    });
    expect(first).toMatchObject({
      outcome: "awaiting-codex-restore-confirmation",
      state: { remaining: 0, pendingCodexRestoreObservationAt: at(360) },
    });

    const second = evaluateSessionQuotaTransition({
      previous: first.state,
      observation: observation({ remaining: 90, observedAt: at(420), evaluationTime: at(420) }),
      notificationsEnabled: true,
    });
    expect(second).toMatchObject({ outcome: "restored", state: { remaining: 90 } });
    expect(second.state.pendingCodexRestoreObservationAt).toBeUndefined();
  });

  it("does not trust an advanced boundary that was already expired when observed", () => {
    const result = evaluateSessionQuotaTransition({
      previous: depletedState({ trustedResetBoundary: at(100) }),
      observation: observation({
        remaining: 80,
        resetBoundary: at(250),
        observedAt: at(300),
        evaluationTime: at(200),
      }),
      notificationsEnabled: true,
    });
    expect(result).toMatchObject({
      outcome: "awaiting-codex-restore-confirmation",
      state: { trustedResetBoundary: at(100) },
    });
  });

  it("keeps ordinary providers on the simple transition path", () => {
    const result = evaluateSessionQuotaTransition({
      previous: {
        remaining: 0,
        source: "primary",
        observedAt: start,
      },
      observation: {
        provider: "claude",
        source: "primary",
        remaining: 75,
        observedAt: at(60),
        evaluationTime: at(60),
      },
      notificationsEnabled: true,
    });
    expect(result.outcome).toBe("restored");
    expect(transitionForSessionQuotaOutcome("baseline-changed")).toBe("none");
    expect(transitionForSessionQuotaOutcome(result.outcome)).toBe("restored");
  });
});
