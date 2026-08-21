import type { SpendDashboardDTO, SpendOverviewDTO, SpendSourceStateDTO } from "@codexbar/contracts";

export type SpendPresentationState = "loading" | "error" | "empty" | "ready";

export interface SpendDaySeriesPoint {
  readonly day: string;
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface SpendPresentation {
  readonly state: SpendPresentationState;
  readonly overview: SpendOverviewDTO | undefined;
  /** Daily values are aggregated only across published provider rows. */
  readonly dailySeries: readonly SpendDaySeriesPoint[];
  readonly staleSourceCount: number;
  readonly unavailableSourceCount: number;
  readonly loadingSourceCount: number;
}

const zeroTotals = (overview: SpendOverviewDTO): boolean =>
  overview.totals.totalTokens === 0 && overview.totals.costUsd === 0;

const countSources = (overview: SpendOverviewDTO, state: SpendSourceStateDTO): number =>
  overview.sources.filter((source) => source.state === state).length;

/**
 * Turns the safe IPC projection into presentation-ready aggregates. Provider
 * IDs are used only to join the two safe DTO collections; they never become
 * labels or renderer-visible identifiers.
 */
export const spendPresentation = (
  overview: SpendOverviewDTO | undefined,
  dashboard: SpendDashboardDTO | undefined,
  loading: boolean,
  failed: boolean,
): SpendPresentation => {
  // A dashboard carries the overview it was built from. Prefer that atomic
  // pair whenever it is available, including during overlapping refreshes.
  const publishedOverview = dashboard?.overview ?? overview;
  if (failed) {
    return {
      state: "error",
      overview: publishedOverview,
      dailySeries: [],
      staleSourceCount:
        publishedOverview === undefined ? 0 : countSources(publishedOverview, "stale-last-known"),
      unavailableSourceCount:
        publishedOverview === undefined ? 0 : countSources(publishedOverview, "unavailable"),
      loadingSourceCount:
        publishedOverview === undefined ? 0 : countSources(publishedOverview, "loading"),
    };
  }
  if (publishedOverview === undefined) {
    return {
      state: loading ? "loading" : "empty",
      overview: undefined,
      dailySeries: [],
      staleSourceCount: 0,
      unavailableSourceCount: 0,
      loadingSourceCount: 0,
    };
  }

  const visibleProviders = new Set(
    publishedOverview.providers.map((provider) => provider.provider),
  );
  const buckets = new Map<string, SpendDaySeriesPoint>();
  for (const point of dashboard?.dailyPoints ?? []) {
    if (!visibleProviders.has(point.provider)) continue;
    const current = buckets.get(point.day) ?? {
      day: point.day,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    buckets.set(point.day, {
      day: point.day,
      costUsd: current.costUsd + point.costUsd,
      inputTokens: current.inputTokens + point.inputTokens,
      outputTokens: current.outputTokens + point.outputTokens,
    });
  }
  const dailySeries = [...buckets.values()].sort((left, right) =>
    left.day.localeCompare(right.day),
  );
  return {
    state: zeroTotals(publishedOverview) && dailySeries.length === 0 ? "empty" : "ready",
    overview: publishedOverview,
    dailySeries,
    staleSourceCount: countSources(publishedOverview, "stale-last-known"),
    unavailableSourceCount: countSources(publishedOverview, "unavailable"),
    loadingSourceCount: countSources(publishedOverview, "loading"),
  };
};
