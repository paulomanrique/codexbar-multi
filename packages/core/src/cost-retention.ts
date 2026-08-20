import type { ProviderId, ProviderInstanceId } from "@codexbar/contracts";
import type { Effect } from "effect";
import type { InfrastructureError } from "./services.ts";

/**
 * Retention boundary for the small, shared usage-history tables.
 *
 * The boundary is exclusive: records whose timestamp equals `before` remain.
 * This mirrors the Swift cost store's inclusive requested-window edges while
 * keeping this generic repository independent of scanner file metadata.
 */
export interface UsageRecordRetentionRequest {
  /** Unix milliseconds; all records strictly older than this value may be removed. */
  readonly before: number;
  /** Limit history pruning to a single first-party or plugin provider instance. */
  readonly historyProviderId?: ProviderInstanceId;
  /** Limit cost pruning to one first-party provider. */
  readonly costProviderId?: ProviderId;
}

/** Counts are returned only after the enclosing persistence transaction commits. */
export interface UsageRecordRetentionResult {
  readonly deletedHistoryRecords: number;
  readonly deletedCostUsageRecords: number;
}

export interface UsageRecordRetentionService {
  /**
   * Atomically applies the requested history and cost pruning. Implementations
   * must leave both tables unchanged when either delete fails.
   */
  readonly prune: (
    request: UsageRecordRetentionRequest,
  ) => Effect.Effect<UsageRecordRetentionResult, InfrastructureError>;
}

/** Shared validation so adapters cannot accidentally turn a bad clock into a destructive prune. */
export const assertUsageRecordRetentionRequest = (request: UsageRecordRetentionRequest): void => {
  if (!Number.isSafeInteger(request.before) || request.before < 0) {
    throw new Error("before must be a non-negative safe integer");
  }
};
