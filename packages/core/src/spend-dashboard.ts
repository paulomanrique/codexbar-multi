import type {
  ProviderId,
  SpendDailyPointDTO,
  SpendDashboardDTO,
  SpendOverviewDTO,
  SpendProviderRowDTO,
  SpendSourceDTO,
  SpendTotalsDTO,
} from "@codexbar/contracts";

import {
  visibleSpendPublicationInputs,
  type SpendPublication,
  type SpendPublicationInput,
} from "./spend-publication.ts";

/** A repository row already assigned to one internal spend source by the host. */
export interface SpendDashboardRecord {
  /** Internal-only. It is deliberately omitted from all renderer DTOs. */
  readonly sourceId: string;
  readonly providerId: ProviderId;
  readonly recordedAt: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
}

export interface BuildSpendDashboardRequest<Input extends SpendPublicationInput> {
  readonly publication: SpendPublication<Input>;
  /** Must match the current desktop configuration before a projection is reused. */
  readonly ownershipFingerprint: string;
  readonly requestedDays: number;
  readonly records: ReadonlyArray<SpendDashboardRecord>;
  /** A bounded repository read can report that totals are only a prefix. */
  readonly truncated: boolean;
}

export interface SpendDashboardModel {
  readonly overview: SpendOverviewDTO;
  readonly dashboard: SpendDashboardDTO;
}

interface MutableTotals {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  readonly sourceIds: Set<string>;
  readonly days: Set<string>;
}

interface MutableDailyPoint {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

const checkedNatural = (name: string, value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer.`);
  }
  return value;
};

const checkedCost = (value: number): number => {
  if (!Number.isFinite(value) || value < 0)
    throw new TypeError("Spend cost must be finite and non-negative.");
  return value;
};

const addNatural = (name: string, left: number, right: number): number =>
  checkedNatural(name, left + right);

const addCost = (left: number, right: number): number => {
  const total = left + right;
  if (!Number.isFinite(total) || total < 0)
    throw new RangeError("Spend cost total is not representable.");
  return total;
};

const makeTotals = (): MutableTotals => ({
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  sourceIds: new Set<string>(),
  days: new Set<string>(),
});

const toTotals = (value: MutableTotals): SpendTotalsDTO => ({
  inputTokens: value.inputTokens,
  outputTokens: value.outputTokens,
  totalTokens: addNatural("Spend total tokens", value.inputTokens, value.outputTokens),
  costUsd: value.costUsd,
  coveredDayCount: value.days.size,
  sourceCount: value.sourceIds.size,
});

const dayFor = (recordedAt: number): string => {
  checkedNatural("Spend record timestamp", recordedAt);
  const date = new Date(recordedAt);
  if (!Number.isFinite(date.getTime())) throw new TypeError("Spend record timestamp is invalid.");
  return date.toISOString().slice(0, 10);
};

const requestedDays = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 1 || value > 365) {
    throw new TypeError("Spend dashboard requested days must be between 1 and 365.");
  }
  return value;
};

const projectedSources = <Input extends SpendPublicationInput>(
  publication: SpendPublication<Input>,
): ReadonlyArray<SpendSourceDTO> =>
  publication.sources.map(({ providerId, displayName, role, state }) => ({
    provider: providerId,
    displayName,
    role,
    state,
  }));

/**
 * Pure shared spend aggregation. Internal source IDs are required while
 * joining data but are intentionally removed before the projection reaches
 * desktop IPC. A record can only contribute through its currently available
 * source, so stale data never leaks into an overview total.
 */
export const buildSpendDashboard = <Input extends SpendPublicationInput>(
  request: BuildSpendDashboardRequest<Input>,
): SpendDashboardModel | undefined => {
  const days = requestedDays(request.requestedDays);
  if (request.publication.configuration?.ownershipFingerprint !== request.ownershipFingerprint) {
    return undefined;
  }

  const visibleInputs = visibleSpendPublicationInputs(request.publication);
  const inputById = new Map(visibleInputs.map((input) => [input.id, input]));
  const loadedAt = Date.parse(request.publication.loadedAt);
  if (!Number.isFinite(loadedAt)) throw new TypeError("Spend publication loadedAt is invalid.");
  const windowStart = Math.max(0, loadedAt - days * 24 * 60 * 60 * 1_000);
  const providerTotals = new Map<ProviderId, MutableTotals>();
  const providerNames = new Map<ProviderId, string>();
  const daily = new Map<string, MutableDailyPoint>();
  const total = makeTotals();

  for (const record of request.records) {
    const input = inputById.get(record.sourceId);
    // A row without a current source owner is a stale/mismatched repository
    // row. It must not be silently attributed to another provider/account.
    if (input === undefined) continue;
    if (input.providerId !== record.providerId) {
      throw new TypeError(`Spend record '${record.sourceId}' crosses provider ownership.`);
    }
    checkedNatural("Spend record timestamp", record.recordedAt);
    // Defend the aggregation boundary as well as the SQLite query boundary:
    // malformed/out-of-scope rows cannot alter a requested spend window.
    if (record.recordedAt < windowStart || record.recordedAt > loadedAt) continue;
    checkedNatural("Spend input tokens", record.inputTokens);
    checkedNatural("Spend output tokens", record.outputTokens);
    checkedCost(record.costUsd);
    const day = dayFor(record.recordedAt);
    let providerTotal = providerTotals.get(record.providerId);
    if (providerTotal === undefined) {
      providerTotal = makeTotals();
      providerTotals.set(record.providerId, providerTotal);
      providerNames.set(record.providerId, input.displayName);
    }
    for (const totals of [providerTotal, total]) {
      totals.inputTokens = addNatural(
        "Spend input token total",
        totals.inputTokens,
        record.inputTokens,
      );
      totals.outputTokens = addNatural(
        "Spend output token total",
        totals.outputTokens,
        record.outputTokens,
      );
      totals.costUsd = addCost(totals.costUsd, record.costUsd);
      totals.sourceIds.add(record.sourceId);
      totals.days.add(day);
    }
    const dailyKey = `${record.providerId}\u0000${day}`;
    const point = daily.get(dailyKey) ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    point.inputTokens = addNatural(
      "Spend daily input token total",
      point.inputTokens,
      record.inputTokens,
    );
    point.outputTokens = addNatural(
      "Spend daily output token total",
      point.outputTokens,
      record.outputTokens,
    );
    point.costUsd = addCost(point.costUsd, record.costUsd);
    daily.set(dailyKey, point);
  }

  const providers: SpendProviderRowDTO[] = [...providerTotals.entries()]
    .map(([provider, totals]) => ({
      provider,
      displayName: providerNames.get(provider) ?? provider,
      totals: toTotals(totals),
    }))
    .toSorted(
      (left, right) =>
        right.totals.costUsd - left.totals.costUsd || left.provider.localeCompare(right.provider),
    );
  const dailyPoints: SpendDailyPointDTO[] = [...daily.entries()]
    .map(([key, totals]) => {
      const [provider, day] = key.split("\u0000");
      if (provider === undefined || day === undefined)
        throw new TypeError("Invalid spend daily bucket.");
      return {
        provider: provider as ProviderId,
        day,
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        costUsd: totals.costUsd,
      };
    })
    .toSorted(
      (left, right) =>
        left.day.localeCompare(right.day) || left.provider.localeCompare(right.provider),
    );

  const overview: SpendOverviewDTO = {
    schemaVersion: 1,
    revision: request.publication.revision,
    generation: request.publication.generation,
    loadedAt: request.publication.loadedAt,
    isRefreshing: request.publication.isRefreshing,
    truncated: request.truncated,
    sources: projectedSources(request.publication),
    totals: toTotals(total),
    providers,
  };
  return {
    overview,
    dashboard: { overview, requestedDays: days, dailyPoints },
  };
};
