import type { ProviderId, UsageSnapshot } from "@codexbar/contracts";
import type { PlanUtilizationHistoryCoordinator } from "@codexbar/core";
import { Effect } from "effect";

export interface RecordDesktopPlanUtilizationInput {
  readonly coordinator: Pick<PlanUtilizationHistoryCoordinator, "recordGenericSessionEquivalent">;
  readonly providerId: ProviderId;
  readonly snapshot: UsageSnapshot;
  readonly capturedAt: Date;
  readonly signal?: AbortSignal;
}

/**
 * OpenCode Go is the first generic provider whose Swift descriptor marks plan
 * utilization as always tracked. Providers that are opt-in upstream stay
 * disabled until the corresponding setting is ported, while providers with
 * dedicated ownership rules fail closed in the core coordinator.
 */
export const recordDesktopPlanUtilization = async (
  input: RecordDesktopPlanUtilizationInput,
): Promise<boolean> => {
  if (input.providerId !== "opencodego") return false;
  try {
    return await Effect.runPromise(
      input.coordinator.recordGenericSessionEquivalent({
        providerId: input.providerId,
        snapshot: input.snapshot,
        capturedAt: input.capturedAt,
      }),
      input.signal === undefined ? undefined : { signal: input.signal },
    );
  } catch {
    // History persistence is best effort and must not turn a successful,
    // already-persisted usage refresh into a renderer-visible failure.
    return false;
  }
};
