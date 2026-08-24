import type { ProviderId } from "@codexbar/contracts";
import { stableClaudeOAuthHistoryOwner, type ProviderFetchOutcome } from "@codexbar/core";

export interface ClaudeOAuthHistoryOwnerCapture {
  readonly captureFetch: (
    providerId: ProviderId,
    fetch: () => Promise<ProviderFetchOutcome>,
    signal?: AbortSignal,
  ) => Promise<ProviderFetchOutcome>;
  readonly consume: (
    providerId: ProviderId,
    outcome: ProviderFetchOutcome,
    signal?: AbortSignal,
  ) => Promise<string | undefined>;
}

/**
 * Keeps the opaque credential owner entirely inside a host composition root.
 * The usage outcome remains unchanged, so DTOs, IPC, and CLI serialization
 * cannot accidentally acquire owner metadata.
 */
export const makeClaudeOAuthHistoryOwnerCapture = (input: {
  readonly resolveOwner: (signal?: AbortSignal) => Promise<string | undefined>;
}): ClaudeOAuthHistoryOwnerCapture => {
  const beforeOwners = new WeakMap<ProviderFetchOutcome, string | undefined>();
  const resolveOwner = async (signal?: AbortSignal): Promise<string | undefined> => {
    try {
      return await input.resolveOwner(signal);
    } catch {
      return undefined;
    }
  };

  return {
    captureFetch: async (providerId, fetch, signal) => {
      const before =
        providerId === "claude" && signal?.aborted !== true
          ? await resolveOwner(signal)
          : undefined;
      const outcome = await fetch();
      if (
        providerId === "claude" &&
        outcome.strategyId === "claude.oauth" &&
        signal?.aborted !== true
      ) {
        beforeOwners.set(outcome, before);
      }
      return outcome;
    },
    consume: async (providerId, outcome, signal) => {
      const isAborted = (): boolean => signal?.aborted === true;
      const wasCaptured = beforeOwners.has(outcome);
      const before = beforeOwners.get(outcome);
      beforeOwners.delete(outcome);
      if (
        !wasCaptured ||
        providerId !== "claude" ||
        outcome.strategyId !== "claude.oauth" ||
        isAborted()
      ) {
        return undefined;
      }
      const after = await resolveOwner(signal);
      if (isAborted()) return undefined;
      return stableClaudeOAuthHistoryOwner(outcome.strategyId, before, after);
    },
  };
};
