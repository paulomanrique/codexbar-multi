import type { ProviderId, RateWindow, UsageSnapshot } from "@codexbar/contracts";

import { remainingQuotaPercent } from "./quota.ts";
import {
  evaluateSessionQuotaTransition,
  isSessionQuotaDepleted,
  transitionForSessionQuotaOutcome,
  type SessionQuotaTransition,
  type SessionQuotaTransitionEvaluation,
  type SessionQuotaTransitionState,
} from "./session-quota.ts";

/** Semantic origin of the selected session lane, not a provider fetch strategy. */
export type SessionQuotaWindowSource =
  | "primary"
  | "copilot-secondary-fallback"
  | "antigravity-quota-summary"
  | "antigravity-legacy";

export interface SessionQuotaWindow {
  readonly window: RateWindow;
  readonly source: SessionQuotaWindowSource;
}

/** Deliberately contains no account, credential, or raw snapshot data. */
export interface SessionQuotaNotification {
  readonly id: string;
  readonly provider: ProviderId;
  readonly transition: Exclude<SessionQuotaTransition, "none">;
}

/**
 * A narrow host boundary for native notification delivery. Core never imports
 * Electron (or any OS API); hosts choose their own permission and presentation
 * policy from this non-sensitive event.
 */
export interface NotificationAdapter {
  readonly notify: (notification: SessionQuotaNotification) => void | Promise<void>;
}

export type SessionQuotaObservationDisposition =
  | "evaluated"
  | "missing-session-window"
  | "synthetic-placeholder"
  | "excluded-provider"
  | "notifications-disabled"
  | "codex-owner-unavailable"
  | "stale-codex-baseline"
  | "invalid-observation";

export interface SessionQuotaObservationResult {
  readonly disposition: SessionQuotaObservationDisposition;
  readonly evaluation?: SessionQuotaTransitionEvaluation;
  readonly notification?: SessionQuotaNotification;
}

export interface SessionQuotaCoordinatorInput {
  readonly provider: ProviderId;
  readonly snapshot: UsageSnapshot;
  /** Swift defaults this setting to true. The UI toggle is ported separately. */
  readonly notificationsEnabled?: boolean;
  readonly now: Date;
  /**
   * Opaque host-derived ownership fingerprint. It is intentionally not derived
   * from `UsageSnapshot.identity`, which may be stale or spoofable.
   */
  readonly codexOwnerKey?: string;
}

/**
 * In-memory port of `UsageStore.handleSessionQuotaTransition`. Persistence is
 * intentionally deferred: transition state contains account-bound safety data
 * and must not cross the renderer/IPC boundary.
 *
 * Codex is fail-closed until a secure ownership derivation is ported. Supplying
 * no owner key clears the Codex baseline and can never produce a notification.
 */
export class SessionQuotaCoordinator {
  readonly #states = new Map<ProviderId, SessionQuotaTransitionState>();
  #codexBaselineWatermark: Date | undefined;

  observe(input: SessionQuotaCoordinatorInput): SessionQuotaObservationResult {
    const observedAt = asDate(input.snapshot.updatedAt);
    if (observedAt === undefined || !Number.isFinite(input.now.getTime())) {
      return { disposition: "invalid-observation" };
    }

    const notificationsEnabled = input.notificationsEnabled ?? true;
    if (input.provider === "codex" && !notificationsEnabled) {
      this.requireFreshCodexBaseline(observedAt);
      return { disposition: "notifications-disabled" };
    }
    if (input.provider === "codex" && input.codexOwnerKey === undefined) {
      this.requireFreshCodexBaseline(observedAt);
      return { disposition: "codex-owner-unavailable" };
    }

    const lane = sessionQuotaWindow(input.provider, input.snapshot);
    if (lane === undefined) {
      this.handleMissingWindow(input.provider, input.codexOwnerKey, observedAt);
      return {
        disposition: isSessionQuotaExcludedProvider(input.provider)
          ? "excluded-provider"
          : "missing-session-window",
      };
    }
    if (lane.window.isSyntheticPlaceholder === true) {
      // A placeholder must neither erase a prior real baseline nor look like a
      // newly available session after a provider omitted that lane.
      return { disposition: "synthetic-placeholder" };
    }

    if (
      input.provider === "codex" &&
      this.#codexBaselineWatermark !== undefined &&
      observedAt.getTime() <= this.#codexBaselineWatermark.getTime()
    ) {
      return { disposition: "stale-codex-baseline" };
    }

    const previous = this.#states.get(input.provider);
    const forceBaseline = input.provider === "codex" && this.#codexBaselineWatermark !== undefined;
    const resetBoundary = asDate(lane.window.resetsAt);
    const evaluation = evaluateSessionQuotaTransition({
      ...(previous === undefined ? {} : { previous }),
      observation: {
        provider: input.provider,
        remaining: remainingQuotaPercent(lane.window),
        source: lane.source,
        ...(resetBoundary === undefined ? {} : { resetBoundary }),
        observedAt,
        evaluationTime: input.now,
        ...(input.codexOwnerKey === undefined ? {} : { codexOwnerKey: input.codexOwnerKey }),
      },
      notificationsEnabled,
      ...(forceBaseline ? { forceBaseline: true } : {}),
    });
    this.#states.set(input.provider, evaluation.state);
    if (input.provider === "codex") this.#codexBaselineWatermark = undefined;

    const transition = transitionForSessionQuotaOutcome(evaluation.outcome);
    return {
      disposition: "evaluated",
      evaluation,
      ...(transition === "none"
        ? {}
        : {
            notification: {
              id: `session-${input.provider}-${transition}`,
              provider: input.provider,
              transition,
            },
          }),
    };
  }

  /** Mirrors generic background-refresh cleanup without exposing state. */
  clear(provider: ProviderId): void {
    const previous = this.#states.get(provider);
    this.#states.delete(provider);
    if (
      provider === "codex" &&
      previous !== undefined &&
      isSessionQuotaDepleted(previous.remaining)
    ) {
      this.requireFreshCodexBaseline(previous.observedAt);
    }
  }

  private handleMissingWindow(
    provider: ProviderId,
    codexOwnerKey: string | undefined,
    observedAt: Date,
  ): void {
    if (provider !== "codex") {
      this.clear(provider);
      return;
    }

    const previous = this.#states.get("codex");
    if (previous === undefined) {
      if (this.#codexBaselineWatermark !== undefined) this.requireFreshCodexBaseline(observedAt);
      return;
    }
    if (previous.codexOwnerKey !== codexOwnerKey) {
      this.requireFreshCodexBaseline(observedAt);
      return;
    }
    if (observedAt.getTime() > previous.observedAt.getTime()) {
      this.#states.set("codex", { ...previous, observedAt });
    }
  }

  private requireFreshCodexBaseline(observedAt: Date): void {
    const previous = this.#states.get("codex");
    this.#states.delete("codex");
    const previousAt = previous?.observedAt;
    const watermark = this.#codexBaselineWatermark;
    const timestamp = Math.max(
      observedAt.getTime(),
      previousAt?.getTime() ?? Number.NEGATIVE_INFINITY,
      watermark?.getTime() ?? Number.NEGATIVE_INFINITY,
    );
    this.#codexBaselineWatermark = new Date(timestamp);
  }
}

/** Port of `UsageStore.sessionQuotaWindow(provider:snapshot:)`. */
export function sessionQuotaWindow(
  provider: ProviderId,
  snapshot: UsageSnapshot,
): SessionQuotaWindow | undefined {
  if (isSessionQuotaExcludedProvider(provider)) return undefined;

  if (provider === "antigravity") {
    const quotaSummary = hasAntigravityQuotaSummaryWindows(snapshot);
    const candidates = quotaSummary
      ? (snapshot.extraRateWindows ?? [])
          .filter(
            (named) =>
              named.usageKnown !== false &&
              named.id.startsWith("antigravity-quota-summary-") &&
              named.window.windowMinutes === 5 * 60,
          )
          .map((named) => named.window)
      : [snapshot.primary, snapshot.secondary, snapshot.tertiary].filter(
          (window): window is RateWindow =>
            window !== undefined &&
            (window.windowMinutes === 5 * 60 || window.windowMinutes === undefined),
        );
    const window = mostUsedWindow(candidates);
    return window === undefined
      ? undefined
      : {
          window,
          source: quotaSummary ? "antigravity-quota-summary" : "antigravity-legacy",
        };
  }

  if (snapshot.primary !== undefined && isSessionWindow(snapshot.primary)) {
    // A Crof primary with no secondary is a PAYG balance, not request quota.
    if (provider !== "crof" || snapshot.secondary !== undefined) {
      return { window: snapshot.primary, source: "primary" };
    }
  }
  if (provider === "copilot" && snapshot.secondary !== undefined) {
    return { window: snapshot.secondary, source: "copilot-secondary-fallback" };
  }
  return undefined;
}

export function isSessionQuotaExcludedProvider(provider: ProviderId): boolean {
  return provider === "mimo" || provider === "qoder";
}

function isSessionWindow(window: RateWindow): boolean {
  return window.windowMinutes === undefined || window.windowMinutes <= 6 * 60;
}

function hasAntigravityQuotaSummaryWindows(snapshot: UsageSnapshot): boolean {
  return (snapshot.extraRateWindows ?? []).some((named) =>
    named.id.startsWith("antigravity-quota-summary-"),
  );
}

function mostUsedWindow(windows: readonly RateWindow[]): RateWindow | undefined {
  return windows.reduce<RateWindow | undefined>(
    (current, candidate) =>
      current === undefined || candidate.usedPercent > current.usedPercent ? candidate : current,
    undefined,
  );
}

function asDate(value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp) : undefined;
}
