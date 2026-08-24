import type { ProviderId, UsageSnapshot } from "@codexbar/contracts";
import { Effect } from "effect";
import type { PlanUtilizationHistoryCoordinator } from "./plan-utilization-coordinator.ts";
import type { InfrastructureError } from "./services.ts";

export interface RecordFirstPartyPlanUtilizationInput {
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
  readonly strategyId?: string;
  readonly claudeOAuthHistoryOwnerIdentifier?: string | null;
  readonly claudeSelectedTokenAccountKey?: string | null;
}

/**
 * Host-neutral admission policy for first-party plan-utilization history.
 * Codex has canonical account ownership. OpenCode Go is the first generic
 * provider whose upstream descriptor always tracks session-equivalent usage.
 */
export const recordFirstPartyPlanUtilization = (
  input: RecordFirstPartyPlanUtilizationInput,
): Effect.Effect<boolean, InfrastructureError> => {
  if (input.providerId === "codex")
    return input.coordinator.recordCodex({
      snapshot: input.snapshot,
      capturedAt: input.capturedAt,
    });
  if (input.providerId === "claude" && input.strategyId === "claude.oauth")
    return (
      input.coordinator.recordClaudeOAuth?.({
        snapshot: input.snapshot,
        capturedAt: input.capturedAt,
        ...(input.claudeOAuthHistoryOwnerIdentifier === undefined
          ? {}
          : { historyOwnerIdentifier: input.claudeOAuthHistoryOwnerIdentifier }),
      }) ?? Effect.succeed(false)
    );
  if (input.providerId === "claude" && input.claudeSelectedTokenAccountKey !== undefined)
    return (
      input.coordinator.recordClaudeSelectedTokenAccount?.({
        snapshot: input.snapshot,
        capturedAt: input.capturedAt,
        accountKey: input.claudeSelectedTokenAccountKey,
      }) ?? Effect.succeed(false)
    );
  if (input.providerId === "claude")
    return input.coordinator.recordClaudeIdentity({
      snapshot: input.snapshot,
      capturedAt: input.capturedAt,
    });
  if (input.providerId === "antigravity")
    return input.coordinator.recordAntigravity({
      snapshot: input.snapshot,
      capturedAt: input.capturedAt,
    });
  if (input.providerId === "opencodego")
    return input.coordinator.recordGenericSessionEquivalent({
      providerId: "opencodego",
      snapshot: input.snapshot,
      capturedAt: input.capturedAt,
    });
  return Effect.succeed(false);
};
