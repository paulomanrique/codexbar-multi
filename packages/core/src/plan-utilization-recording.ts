import type { ProviderId, UsageSnapshot } from "@codexbar/contracts";
import { Effect } from "effect";
import type { PlanUtilizationHistoryCoordinator } from "./plan-utilization-coordinator.ts";
import type { InfrastructureError } from "./services.ts";

export interface RecordFirstPartyPlanUtilizationInput {
  readonly coordinator: Pick<
    PlanUtilizationHistoryCoordinator,
    "recordCodex" | "recordGenericSessionEquivalent"
  >;
  readonly providerId: ProviderId;
  readonly snapshot: UsageSnapshot;
  readonly capturedAt: Date;
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
  if (input.providerId === "opencodego")
    return input.coordinator.recordGenericSessionEquivalent({
      providerId: "opencodego",
      snapshot: input.snapshot,
      capturedAt: input.capturedAt,
    });
  return Effect.succeed(false);
};
