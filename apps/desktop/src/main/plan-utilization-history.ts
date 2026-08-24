import type { ProviderId, UsageSnapshot } from "@codexbar/contracts";
import {
  recordFirstPartyPlanUtilization,
  type PlanUtilizationHistoryCoordinator,
} from "@codexbar/core";
import { Effect } from "effect";

export interface RecordDesktopPlanUtilizationInput {
  readonly coordinator: Pick<
    PlanUtilizationHistoryCoordinator,
    "recordAntigravity" | "recordClaudeIdentity" | "recordCodex" | "recordGenericSessionEquivalent"
  > &
    Partial<
      Pick<
        PlanUtilizationHistoryCoordinator,
        "recordClaudeOAuth" | "recordClaudeSelectedTokenAccount"
      >
    >;
  readonly providerId: ProviderId;
  readonly snapshot: UsageSnapshot;
  readonly capturedAt: Date;
  readonly signal?: AbortSignal;
  readonly strategyId?: string;
  readonly claudeOAuthHistoryOwnerIdentifier?: string | null;
  readonly claudeSelectedTokenAccountKey?: string | null;
}

/**
 * Providers that are opt-in upstream stay disabled until the corresponding
 * setting is ported. Storage failures remain invisible to renderer IPC after
 * the provider refresh itself has already succeeded.
 */
export const recordDesktopPlanUtilization = async (
  input: RecordDesktopPlanUtilizationInput,
): Promise<boolean> => {
  try {
    return await Effect.runPromise(
      recordFirstPartyPlanUtilization({
        coordinator: input.coordinator,
        providerId: input.providerId,
        snapshot: input.snapshot,
        capturedAt: input.capturedAt,
        ...(input.strategyId === undefined ? {} : { strategyId: input.strategyId }),
        ...(input.claudeOAuthHistoryOwnerIdentifier === undefined
          ? {}
          : { claudeOAuthHistoryOwnerIdentifier: input.claudeOAuthHistoryOwnerIdentifier }),
        ...(input.claudeSelectedTokenAccountKey === undefined
          ? {}
          : { claudeSelectedTokenAccountKey: input.claudeSelectedTokenAccountKey }),
      }),
      input.signal === undefined ? undefined : { signal: input.signal },
    );
  } catch {
    // History persistence is best effort and must not turn a successful,
    // already-persisted usage refresh into a renderer-visible failure.
    return false;
  }
};
