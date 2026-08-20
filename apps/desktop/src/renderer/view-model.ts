import type { CostUsageRecordDTO, DashboardProviderDTO, ProviderId } from "@codexbar/contracts";
import { PROVIDER_IDS } from "@codexbar/contracts";

export type ProviderImplementationPresentation = "parity-pending" | "unported";

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
