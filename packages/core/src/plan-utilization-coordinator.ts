import type { ProviderId, ProviderInstanceId, UsageSnapshot } from "@codexbar/contracts";
import { Effect, Ref, Semaphore } from "effect";
import {
  PlanUtilizationHistoryBuckets,
  PlanUtilizationHistoryEntry,
  PlanUtilizationHistorySelection,
  PlanUtilizationSeriesHistory,
  type PlanUtilizationHistoryProviders,
} from "./plan-utilization-history.ts";
import {
  updatePlanUtilizationHistories,
  type PlanUtilizationSeriesSample,
} from "./plan-utilization-recorder.ts";
import {
  extractPlanUtilizationSeriesSamples,
  reconcileGenericSessionEquivalentHistory,
} from "./plan-utilization-samples.ts";
import type { InfrastructureError } from "./services.ts";

export interface PlanUtilizationHistoryRepository {
  readonly load: Effect.Effect<PlanUtilizationHistoryProviders, InfrastructureError>;
  readonly save: (
    providers: PlanUtilizationHistoryProviders,
  ) => Effect.Effect<void, InfrastructureError>;
}

interface CoordinatorState {
  readonly loaded: boolean;
  readonly revision: number;
  readonly providers: PlanUtilizationHistoryProviders;
}

export interface RecordPlanUtilizationSamplesInput {
  readonly providerId: ProviderInstanceId;
  readonly accountKey?: string | null;
  readonly samples: readonly PlanUtilizationSeriesSample[];
}

/**
 * Owns the load-before-mutate invariant from Swift's `UsageStore` without
 * coupling the domain to a filesystem or Electron. The semaphore makes a
 * startup refresh wait for the persisted decode and serializes publications,
 * so no refresh can overwrite history loaded concurrently.
 */
export class PlanUtilizationHistoryCoordinator {
  readonly #repository: PlanUtilizationHistoryRepository;
  readonly #state = Ref.makeUnsafe<CoordinatorState>({
    loaded: false,
    revision: 0,
    providers: {},
  });
  readonly #semaphore = Semaphore.makeUnsafe(1);

  constructor(repository: PlanUtilizationHistoryRepository) {
    this.#repository = repository;
  }

  get load(): Effect.Effect<PlanUtilizationHistoryProviders, InfrastructureError> {
    const stateRef = this.#state;
    const repository = this.#repository;
    return this.#semaphore.withPermit(
      Effect.gen(function* () {
        const state = yield* Ref.get(stateRef);
        if (state.loaded) return cloneProviders(state.providers);
        const providers = cloneProviders(yield* repository.load);
        yield* Ref.set(stateRef, {
          loaded: true,
          revision: state.revision + 1,
          providers,
        });
        return cloneProviders(providers);
      }),
    );
  }

  record(input: RecordPlanUtilizationSamplesInput): Effect.Effect<boolean, InfrastructureError> {
    if (input.samples.length === 0) return Effect.succeed(false);
    const samples = input.samples.map((sample) => ({
      name: sample.name,
      windowMinutes: sample.windowMinutes,
      entry: new PlanUtilizationHistoryEntry({
        capturedAt: sample.entry.capturedAt,
        usedPercent: sample.entry.usedPercent,
        ...(sample.entry.resetsAt === undefined ? {} : { resetsAt: sample.entry.resetsAt }),
      }),
    }));
    const ensureLoaded = this.#ensureLoaded;
    const stateRef = this.#state;
    const repository = this.#repository;
    return this.#semaphore.withPermit(
      Effect.gen(function* () {
        const state = yield* ensureLoaded;
        const providers = cloneProviders(state.providers);
        const buckets = providers[input.providerId] ?? new PlanUtilizationHistoryBuckets();
        const existing = buckets.historiesFor(input.accountKey);
        const updated = updatePlanUtilizationHistories(existing, samples);
        if (updated === undefined) return false;

        buckets.setHistories(updated, input.accountKey);
        const nextProviders = { ...providers, [input.providerId]: buckets };
        const nextState: CoordinatorState = {
          loaded: true,
          revision: state.revision + 1,
          providers: nextProviders,
        };
        yield* Ref.set(stateRef, nextState);
        yield* repository.save(cloneProviders(nextProviders));
        return true;
      }),
    );
  }

  /**
   * Records generic-provider 5h/weekly lanes only after source-identity
   * reconciliation. Codex, Claude, and Antigravity have dedicated ownership
   * rules and are rejected here rather than merged into a generic bucket.
   */
  recordGenericSessionEquivalent(input: {
    readonly providerId: ProviderId;
    readonly snapshot: UsageSnapshot;
    readonly capturedAt: Date;
    readonly accountKey?: string | null;
  }): Effect.Effect<boolean, InfrastructureError> {
    if (["codex", "claude", "antigravity"].includes(input.providerId)) return Effect.succeed(false);
    const samples = extractPlanUtilizationSeriesSamples({
      providerId: input.providerId,
      snapshot: input.snapshot,
      capturedAt: input.capturedAt,
    });
    if (samples.length === 0) return Effect.succeed(false);

    const ensureLoaded = this.#ensureLoaded;
    const stateRef = this.#state;
    const repository = this.#repository;
    return this.#semaphore.withPermit(
      Effect.gen(function* () {
        const state = yield* ensureLoaded;
        const providers = cloneProviders(state.providers);
        const buckets = providers[input.providerId] ?? new PlanUtilizationHistoryBuckets();
        const originalBuckets = cloneBuckets(buckets);
        const previousIdentity = buckets.sessionEquivalentWindowPairIdentityFor(input.accountKey);
        const reconciled = reconcileGenericSessionEquivalentHistory({
          ...(previousIdentity === undefined ? {} : { previousIdentity }),
          snapshot: input.snapshot,
          histories: buckets.historiesFor(input.accountKey),
          samples,
        });
        const updated =
          updatePlanUtilizationHistories(reconciled.histories, reconciled.samples) ??
          reconciled.histories;
        buckets.setHistories(updated, input.accountKey);
        if (reconciled.historyIdentity !== undefined) {
          buckets.setSessionEquivalentWindowPairIdentity(
            reconciled.historyIdentity,
            input.accountKey,
          );
        }
        if (bucketsEqual(buckets, originalBuckets)) return false;

        const nextProviders = { ...providers, [input.providerId]: buckets };
        yield* Ref.set(stateRef, {
          loaded: true,
          revision: state.revision + 1,
          providers: nextProviders,
        });
        yield* repository.save(cloneProviders(nextProviders));
        return true;
      }),
    );
  }

  selection(
    providerId: ProviderInstanceId,
    accountKey?: string | null,
  ): Effect.Effect<PlanUtilizationHistorySelection, InfrastructureError> {
    const ensureLoaded = this.#ensureLoaded;
    return this.#semaphore.withPermit(
      Effect.gen(function* () {
        const state = yield* ensureLoaded;
        const histories = state.providers[providerId]?.historiesFor(accountKey) ?? [];
        return new PlanUtilizationHistorySelection(accountKey, cloneHistories(histories));
      }),
    );
  }

  get snapshot(): Effect.Effect<
    { readonly revision: number; readonly providers: PlanUtilizationHistoryProviders },
    InfrastructureError
  > {
    const ensureLoaded = this.#ensureLoaded;
    return this.#semaphore.withPermit(
      Effect.gen(function* () {
        const state = yield* ensureLoaded;
        return { revision: state.revision, providers: cloneProviders(state.providers) };
      }),
    );
  }

  removeProvider(providerId: ProviderInstanceId): Effect.Effect<boolean, InfrastructureError> {
    const ensureLoaded = this.#ensureLoaded;
    const stateRef = this.#state;
    const repository = this.#repository;
    return this.#semaphore.withPermit(
      Effect.gen(function* () {
        const state = yield* ensureLoaded;
        if (state.providers[providerId] === undefined) return false;
        const providers = { ...state.providers };
        delete providers[providerId];
        yield* Ref.set(stateRef, {
          loaded: true,
          revision: state.revision + 1,
          providers,
        });
        yield* repository.save(cloneProviders(providers));
        return true;
      }),
    );
  }

  get #ensureLoaded(): Effect.Effect<CoordinatorState, InfrastructureError> {
    const stateRef = this.#state;
    const repository = this.#repository;
    return Effect.gen(function* () {
      const state = yield* Ref.get(stateRef);
      if (state.loaded) return state;
      const providers = cloneProviders(yield* repository.load);
      const loaded = {
        loaded: true,
        revision: state.revision + 1,
        providers,
      } satisfies CoordinatorState;
      yield* Ref.set(stateRef, loaded);
      return loaded;
    });
  }
}

const cloneProviders = (
  providers: PlanUtilizationHistoryProviders,
): PlanUtilizationHistoryProviders =>
  Object.fromEntries(
    Object.entries(providers).flatMap(([providerId, buckets]) =>
      buckets === undefined ? [] : [[providerId, cloneBuckets(buckets)] as const],
    ),
  );

const cloneBuckets = (buckets: PlanUtilizationHistoryBuckets): PlanUtilizationHistoryBuckets =>
  new PlanUtilizationHistoryBuckets({
    ...(buckets.preferredAccountKey === undefined
      ? {}
      : { preferredAccountKey: buckets.preferredAccountKey }),
    unscoped: cloneHistories(buckets.unscoped),
    accounts: Object.fromEntries(
      Object.entries(buckets.accounts).map(([accountKey, histories]) => [
        accountKey,
        cloneHistories(histories),
      ]),
    ),
    sessionEquivalentWindowPairIdentities: {
      ...buckets.sessionEquivalentWindowPairIdentities,
    },
  });

const cloneHistories = (
  histories: readonly PlanUtilizationSeriesHistory[],
): readonly PlanUtilizationSeriesHistory[] =>
  histories.map(
    (history) =>
      new PlanUtilizationSeriesHistory({
        name: history.name,
        windowMinutes: history.windowMinutes,
        entries: history.entries.map(
          (entry) =>
            new PlanUtilizationHistoryEntry({
              capturedAt: entry.capturedAt,
              usedPercent: entry.usedPercent,
              ...(entry.resetsAt === undefined ? {} : { resetsAt: entry.resetsAt }),
            }),
        ),
      }),
  );

const bucketsEqual = (
  left: PlanUtilizationHistoryBuckets,
  right: PlanUtilizationHistoryBuckets,
): boolean =>
  left.preferredAccountKey === right.preferredAccountKey &&
  historiesEqual(left.unscoped, right.unscoped) &&
  stringMapsEqual(
    left.sessionEquivalentWindowPairIdentities,
    right.sessionEquivalentWindowPairIdentities,
  ) &&
  stringMapsEqual(
    Object.fromEntries(Object.keys(left.accounts).map((key) => [key, key])),
    Object.fromEntries(Object.keys(right.accounts).map((key) => [key, key])),
  ) &&
  Object.keys(left.accounts).every((key) =>
    historiesEqual(left.accounts[key] ?? [], right.accounts[key] ?? []),
  );

const historiesEqual = (
  left: readonly PlanUtilizationSeriesHistory[],
  right: readonly PlanUtilizationSeriesHistory[],
): boolean =>
  left.length === right.length &&
  left.every((history, index) => {
    const candidate = right[index];
    return (
      candidate !== undefined &&
      history.name.rawValue === candidate.name.rawValue &&
      history.windowMinutes === candidate.windowMinutes &&
      history.entries.length === candidate.entries.length &&
      history.entries.every((entry, entryIndex) => {
        const other = candidate.entries[entryIndex];
        return (
          other !== undefined &&
          entry.capturedAt.getTime() === other.capturedAt.getTime() &&
          entry.usedPercent === other.usedPercent &&
          entry.resetsAt?.getTime() === other.resetsAt?.getTime()
        );
      })
    );
  });

const stringMapsEqual = (
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean => {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key])
  );
};
