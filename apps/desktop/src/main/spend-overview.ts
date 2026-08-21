import { Effect } from "effect";
import type {
  ProviderId,
  ProviderInstanceId,
  SpendDashboardDTO,
  SpendOverviewDTO,
  UsageSnapshot,
} from "@codexbar/contracts";
import {
  buildSpendDashboard,
  visibleSpendPublicationInputs,
  SpendPublicationCoordinator,
  type CostUsageRecord,
  type SpendDashboardRecord,
  type SpendPublication,
  type SpendPublicationInput,
  type SpendSourceRole,
} from "@codexbar/core";

/**
 * Desktop-only composition seam for the overview card. The UI gets a
 * provider-scoped, already-published view; loading and source discovery stay
 * in the backend producer.
 */
export interface DesktopSpendOverviewInput extends SpendPublicationInput {
  readonly snapshot: UsageSnapshot;
}

export const publishedSpendOverviewInputs = (
  publication: SpendPublication<DesktopSpendOverviewInput> | undefined,
  ownershipFingerprint: string,
  providerIds: ReadonlySet<ProviderInstanceId>,
): ReadonlyArray<DesktopSpendOverviewInput> => {
  if (publication?.configuration?.ownershipFingerprint !== ownershipFingerprint) return [];
  return visibleSpendPublicationInputs(publication, providerIds);
};

const MAX_COST_RECORDS_PER_PROVIDER = 50_000;
const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;

/** A source belongs to one first-party cost ledger for this initial desktop slice. */
export interface DesktopSpendSource {
  /** Main-process-only account/source identifier. Never exposed over IPC. */
  readonly id: string;
  readonly providerId: ProviderId;
  readonly displayName: string;
  readonly role?: SpendSourceRole;
}

export interface DesktopSpendConfiguration {
  /** Opaque config/account ownership hash, computed by the desktop composition root. */
  readonly ownershipFingerprint: string;
  readonly roster: ReadonlyArray<DesktopSpendSource>;
  readonly requestedDays: number;
}

export interface DesktopSpendPersistence {
  readonly costs: {
    readonly list: (
      providerId: ProviderId,
      since: number,
      limit?: number,
    ) => Effect.Effect<ReadonlyArray<CostUsageRecord>, unknown>;
  };
}

export interface DesktopSpendProjection {
  readonly overview: SpendOverviewDTO;
  readonly dashboard: SpendDashboardDTO;
}

interface DesktopSpendInput extends SpendPublicationInput {
  readonly providerId: ProviderId;
  readonly role?: SpendSourceRole;
}

interface ProviderLoad {
  readonly source: DesktopSpendSource;
  readonly records: ReadonlyArray<SpendDashboardRecord>;
  readonly confirmedEmpty: boolean;
  readonly failed: boolean;
  readonly truncated: boolean;
}

const toInput = (source: DesktopSpendSource): DesktopSpendInput => ({
  id: source.id,
  providerId: source.providerId,
  displayName: source.displayName,
  ...(source.role === undefined ? {} : { role: source.role }),
});

const sinceFor = (now: Date, requestedDays: number): number => {
  if (!Number.isSafeInteger(requestedDays) || requestedDays < 1 || requestedDays > 365) {
    throw new TypeError("Spend dashboard requested days must be between 1 and 365.");
  }
  const timestamp = now.getTime();
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new TypeError("Spend dashboard clock must return a non-negative millisecond timestamp.");
  }
  return Math.max(0, timestamp - requestedDays * DAY_MILLISECONDS);
};

/**
 * Main-process publication coordinator. It deliberately consumes only the
 * durable repository interface; it has no knowledge of SQLite paths, worker
 * messages, credentials, or renderer state.
 */
export class DesktopSpendPublisher {
  private readonly coordinator = new SpendPublicationCoordinator<DesktopSpendInput>();
  private currentProjection: DesktopSpendProjection | undefined;
  private currentRecords: ReadonlyArray<SpendDashboardRecord> = [];
  private readonly persistence: DesktopSpendPersistence;
  private readonly now: () => Date;

  constructor(persistence: DesktopSpendPersistence, now: () => Date = () => new Date()) {
    this.persistence = persistence;
    this.now = now;
  }

  current(configuration: DesktopSpendConfiguration): DesktopSpendProjection | undefined {
    const publication = this.coordinator.current();
    if (publication?.configuration?.ownershipFingerprint !== configuration.ownershipFingerprint) {
      return undefined;
    }
    return this.currentProjection;
  }

  cancel(): void {
    this.coordinator.cancel();
  }

  async refresh(configuration: DesktopSpendConfiguration): Promise<DesktopSpendProjection> {
    const capturedNow = this.now();
    const since = sinceFor(capturedNow, configuration.requestedDays);
    const lease = this.coordinator.begin();
    const previous = this.coordinator.current();
    const sameOwner =
      previous?.configuration?.ownershipFingerprint === configuration.ownershipFingerprint;
    const retainedInputs = sameOwner ? (previous?.inputs ?? []) : [];
    const retainedRecords = sameOwner ? this.currentRecords : [];
    const loading = this.coordinator.publish(lease, {
      configuration: { ownershipFingerprint: configuration.ownershipFingerprint },
      loadedAt: capturedNow.toISOString(),
      isRefreshing: true,
      roster: configuration.roster,
      inputs: retainedInputs,
    });
    if (loading === undefined) return this.requireCurrent();
    this.replaceProjection(loading, configuration, retainedRecords, false);

    const grouped = new Map<ProviderId, DesktopSpendSource[]>();
    for (const source of configuration.roster) {
      const entries = grouped.get(source.providerId) ?? [];
      entries.push(source);
      grouped.set(source.providerId, entries);
    }
    const results = await Promise.all(
      [...grouped.entries()].map(
        async ([providerId, sources]): Promise<ReadonlyArray<ProviderLoad>> => {
          // The current repository schema is provider-scoped. Assigning its rows
          // to more than one account would double-count usage, so multi-source
          // providers remain unavailable until a source-scoped ledger is ported.
          if (sources.length !== 1) {
            return sources.map((source) => ({
              source,
              records: [],
              confirmedEmpty: false,
              failed: true,
              truncated: false,
            }));
          }
          const source = sources[0];
          if (source === undefined) return [];
          try {
            const fetched = await Effect.runPromise(
              this.persistence.costs.list(providerId, since, MAX_COST_RECORDS_PER_PROVIDER + 1),
              { signal: lease.signal },
            );
            const truncated = fetched.length > MAX_COST_RECORDS_PER_PROVIDER;
            const records = fetched.slice(0, MAX_COST_RECORDS_PER_PROVIDER).map((record) => ({
              sourceId: source.id,
              providerId: record.providerId,
              recordedAt: record.recordedAt,
              inputTokens: record.inputTokens,
              outputTokens: record.outputTokens,
              costUsd: record.costUsd,
            }));
            return [
              { source, records, confirmedEmpty: records.length === 0, failed: false, truncated },
            ];
          } catch {
            // Repository details stay in the main process. A failure only affects
            // the corresponding source state and can retain a prior safe value.
            return [{ source, records: [], confirmedEmpty: false, failed: true, truncated: false }];
          }
        },
      ),
    );
    if (!this.coordinator.isCurrent(lease)) return this.requireCurrent();

    const flattened = results.flat();
    const failedSourceIds = new Set(
      flattened.filter((result) => result.failed).map((result) => result.source.id),
    );
    const confirmedEmptySourceIds = new Set(
      flattened.filter((result) => result.confirmedEmpty).map((result) => result.source.id),
    );
    const inputs = flattened
      .filter((result) => !result.failed && !result.confirmedEmpty)
      .map((result) => toInput(result.source));
    // A transient read failure preserves only a same-owner prior input. The
    // publication marks it stale and excludes it from totals.
    for (const retained of retainedInputs) {
      if (failedSourceIds.has(retained.id) && !inputs.some((input) => input.id === retained.id)) {
        inputs.push(retained);
      }
    }
    const records = flattened.flatMap((result) => result.records);
    const publication = this.coordinator.publish(lease, {
      configuration: { ownershipFingerprint: configuration.ownershipFingerprint },
      loadedAt: capturedNow.toISOString(),
      isRefreshing: false,
      roster: configuration.roster,
      inputs,
      failedSourceIds,
      confirmedEmptySourceIds,
    });
    if (publication === undefined) return this.requireCurrent();
    return this.replaceProjection(
      publication,
      configuration,
      records,
      flattened.some((result) => result.truncated),
    );
  }

  private replaceProjection(
    publication: SpendPublication<DesktopSpendInput>,
    configuration: DesktopSpendConfiguration,
    records: ReadonlyArray<SpendDashboardRecord>,
    truncated: boolean,
  ): DesktopSpendProjection {
    const model = buildSpendDashboard({
      publication,
      ownershipFingerprint: configuration.ownershipFingerprint,
      requestedDays: configuration.requestedDays,
      records,
      truncated,
    });
    if (model === undefined) throw new Error("Spend publication ownership changed.");
    this.currentRecords = records;
    this.currentProjection = { overview: model.overview, dashboard: model.dashboard };
    return this.currentProjection;
  }

  private requireCurrent(): DesktopSpendProjection {
    if (this.currentProjection === undefined) throw new Error("Spend publication was superseded.");
    return this.currentProjection;
  }
}
