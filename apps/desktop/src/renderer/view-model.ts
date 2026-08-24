import type {
  CostUsageRecordDTO,
  DashboardAccountDTO,
  DashboardProviderDTO,
  DefaultBrowserSessionStatusesDTO,
  DefaultBrowserSessionStatusStateDTO,
  ProviderId,
} from "@codexbar/contracts";
import { PROVIDER_IDS } from "@codexbar/contracts";

export type ProviderImplementationPresentation = "parity-pending" | "unported";
export type BrowserLoginPresentationStatus = "idle" | "waiting" | "connected" | "unavailable";

/**
 * `partial` deliberately does not mean that a provider is ready for release.
 * It only means that a TypeScript implementation exists and still needs the
 * oracle/parity gate. Keeping this mapping separate makes that distinction
 * hard to accidentally regress in the renderer.
 */
export const implementationPresentation = (
  provider: Pick<DashboardProviderDTO, "implementationStatus">,
): ProviderImplementationPresentation =>
  provider.implementationStatus === "partial" ? "parity-pending" : "unported";

/** UI bars must not overflow when a provider reports a temporarily bad value. */
export const displayPercent = (percent: number): number =>
  Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;

/**
 * IPC schemas allow any Natural timestamp, while JavaScript Dates support a
 * smaller range. Keep invalid/out-of-range values out of both `Intl` and
 * `toISOString`, which otherwise throw while rendering.
 */
export const safeDateFromTimestamp = (timestamp: number): Date | undefined => {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) return undefined;
  const value = new Date(timestamp);
  return Number.isFinite(value.getTime()) ? value : undefined;
};

/** A dashboard instance can be a user plugin; only the closed first-party IDs may be refreshed. */
export const firstPartyProviderId = (id: string): ProviderId | undefined =>
  (PROVIDER_IDS as readonly string[]).includes(id) ? (id as ProviderId) : undefined;

/** The renderer can submit only the opaque ID from the current Claude account card. */
export const claudeSwapActivationRequest = (
  provider: Pick<DashboardProviderDTO, "id">,
  account: Pick<DashboardAccountDTO, "id" | "active" | "canActivate">,
): { readonly provider: "claude"; readonly accountId: string } | undefined =>
  provider.id === "claude" && !account.active && account.canActivate
    ? { provider: "claude", accountId: account.id }
    : undefined;

export const browserLoginStatusFromDefaultSessionState = (
  state: DefaultBrowserSessionStatusStateDTO,
): BrowserLoginPresentationStatus =>
  state === "persisted" ? "connected" : state === "absent" ? "idle" : "unavailable";

export interface BrowserSessionPresentationStatuses {
  readonly t3chat: BrowserLoginPresentationStatus;
  readonly grok: BrowserLoginPresentationStatus;
}

/** Serializes the two browser-login mutations before React can render disabled controls. */
export const makeBrowserLoginMutationGate = () => {
  let pending = false;
  return {
    tryStart: (): boolean => {
      if (pending) return false;
      pending = true;
      return true;
    },
    finish: (): void => {
      pending = false;
    },
  };
};

/**
 * Applies only the newest credential-status read. Login/logout invalidates any
 * older bootstrap read before mutating its visible pending state.
 */
export const makeDefaultBrowserSessionStatusLoader = (options: {
  readonly read: () => Promise<DefaultBrowserSessionStatusesDTO>;
  readonly publish: (statuses: BrowserSessionPresentationStatuses) => void;
}) => {
  let generation = 0;
  return {
    invalidate: (): void => {
      generation += 1;
    },
    load: async (): Promise<void> => {
      const requestGeneration = ++generation;
      try {
        const statuses = await options.read();
        if (requestGeneration !== generation) return;
        options.publish({
          t3chat: browserLoginStatusFromDefaultSessionState(statuses.t3chatDefault),
          grok: browserLoginStatusFromDefaultSessionState(statuses.grokDefault),
        });
      } catch {
        if (requestGeneration !== generation) return;
        options.publish({ t3chat: "unavailable", grok: "unavailable" });
      }
    },
  };
};

const withLoginProviderName = (template: string, providerName: string): string =>
  template.replaceAll("T3 Chat", providerName);

export const browserLoginActionState = (
  status: BrowserLoginPresentationStatus,
  providerName: string,
  copy: {
    readonly waiting: string;
    readonly connected: string;
    readonly start: string;
    readonly logout: string;
    readonly unavailable: string;
  },
) =>
  ({
    loginLabel:
      status === "unavailable"
        ? `${providerName}: ${copy.unavailable}`
        : status === "waiting"
          ? `${providerName}: ${copy.waiting}`
          : status === "connected"
            ? withLoginProviderName(copy.connected, providerName)
            : withLoginProviderName(copy.start, providerName),
    loginDisabled: status === "waiting" || status === "unavailable",
    showLogout: status === "connected",
    logoutLabel: `${providerName}: ${copy.logout}`,
    logoutDisabled: status === "unavailable",
  }) as const;

export const historySince = (days: number, now: number = Date.now()): number =>
  Math.max(0, now - Math.max(1, Math.floor(days)) * 24 * 60 * 60 * 1000);

export interface CostTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
}

export const costTotals = (records: readonly CostUsageRecordDTO[]): CostTotals =>
  records.reduce<CostTotals>(
    (total, record) => ({
      inputTokens: total.inputTokens + record.inputTokens,
      outputTokens: total.outputTokens + record.outputTokens,
      costUsd: total.costUsd + record.costUsd,
    }),
    { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  );
