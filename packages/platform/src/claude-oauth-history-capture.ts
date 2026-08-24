import type { ProviderId } from "@codexbar/contracts";
import { stableClaudeOAuthHistoryOwner, type ProviderFetchOutcome } from "@codexbar/core";

export interface ClaudeSelectedAccountHistoryBinding {
  readonly selectionKey: string;
  readonly oauthHistoryOwnerIdentifier?: string;
  readonly tokenAccountKey?: string;
}

export interface ClaudeHistoryPublicationBinding {
  readonly oauthHistoryOwnerIdentifier?: string;
  readonly selectedTokenAccountKey?: string;
}

type SelectedAccountResolution =
  | {
      readonly status: "resolved";
      readonly selectedAccount?: ClaudeSelectedAccountHistoryBinding;
    }
  | { readonly status: "failed" };

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
  readonly consumeHistoryBinding: (
    providerId: ProviderId,
    outcome: ProviderFetchOutcome,
    signal?: AbortSignal,
  ) => Promise<ClaudeHistoryPublicationBinding>;
}

/**
 * Keeps the opaque credential owner entirely inside a host composition root.
 * The usage outcome remains unchanged, so DTOs, IPC, and CLI serialization
 * cannot accidentally acquire owner metadata.
 */
export const makeClaudeOAuthHistoryOwnerCapture = (input: {
  readonly resolveOwner: (signal?: AbortSignal) => Promise<string | undefined>;
  readonly resolveSelectedAccount?: (
    signal?: AbortSignal,
  ) => Promise<ClaudeSelectedAccountHistoryBinding | undefined>;
}): ClaudeOAuthHistoryOwnerCapture => {
  const beforeRecords = new WeakMap<
    ProviderFetchOutcome,
    {
      readonly ambientOwner?: string;
      readonly selectedAccount?: ClaudeSelectedAccountHistoryBinding;
      readonly selectedAccountResolutionFailed?: true;
    }
  >();
  const resolveOwner = async (signal?: AbortSignal): Promise<string | undefined> => {
    try {
      return await input.resolveOwner(signal);
    } catch {
      return undefined;
    }
  };
  const resolveSelectedAccount = async (
    signal?: AbortSignal,
  ): Promise<SelectedAccountResolution> => {
    try {
      const selectedAccount = await input.resolveSelectedAccount?.(signal);
      return selectedAccount === undefined
        ? { status: "resolved" }
        : { status: "resolved", selectedAccount };
    } catch {
      return { status: "failed" };
    }
  };
  const consumeHistoryBinding = async (
    providerId: ProviderId,
    outcome: ProviderFetchOutcome,
    signal?: AbortSignal,
  ): Promise<ClaudeHistoryPublicationBinding> => {
    const isAborted = (): boolean => signal?.aborted === true;
    const record = beforeRecords.get(outcome);
    beforeRecords.delete(outcome);
    if (record === undefined || providerId !== "claude" || isAborted()) return {};

    const afterResolution = await resolveSelectedAccount(signal);
    if (isAborted()) return {};
    if (record.selectedAccountResolutionFailed === true || afterResolution.status === "failed") {
      return {};
    }
    const afterSelected = afterResolution.selectedAccount;
    if (record.selectedAccount !== undefined) {
      if (afterSelected?.selectionKey !== record.selectedAccount.selectionKey) return {};
      const selectedTokenAccountKey = record.selectedAccount.tokenAccountKey;
      return selectedTokenAccountKey === undefined ? {} : { selectedTokenAccountKey };
    }
    if (afterSelected !== undefined || outcome.strategyId !== "claude.oauth") return {};
    const afterAmbientOwner = await resolveOwner(signal);
    if (isAborted()) return {};
    const owner = stableClaudeOAuthHistoryOwner(
      outcome.strategyId,
      record.ambientOwner,
      afterAmbientOwner,
    );
    return owner === undefined ? {} : { oauthHistoryOwnerIdentifier: owner };
  };

  return {
    captureFetch: async (providerId, fetch, signal) => {
      const beforeResolution =
        providerId === "claude" && signal?.aborted !== true
          ? await resolveSelectedAccount(signal)
          : { status: "resolved" as const };
      const beforeSelected =
        beforeResolution.status === "resolved" ? beforeResolution.selectedAccount : undefined;
      const beforeAmbientOwner =
        providerId === "claude" &&
        beforeResolution.status === "resolved" &&
        beforeSelected === undefined &&
        signal?.aborted !== true
          ? await resolveOwner(signal)
          : undefined;
      const outcome = await fetch();
      if (providerId === "claude" && signal?.aborted !== true) {
        beforeRecords.set(outcome, {
          ...(beforeAmbientOwner === undefined ? {} : { ambientOwner: beforeAmbientOwner }),
          ...(beforeSelected === undefined ? {} : { selectedAccount: beforeSelected }),
          ...(beforeResolution.status === "failed"
            ? { selectedAccountResolutionFailed: true as const }
            : {}),
        });
      }
      return outcome;
    },
    consumeHistoryBinding,
    consume: async (providerId, outcome, signal) => {
      const binding = await consumeHistoryBinding(providerId, outcome, signal);
      return binding.oauthHistoryOwnerIdentifier;
    },
  };
};
