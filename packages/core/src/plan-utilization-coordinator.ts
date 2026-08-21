import type { ProviderInstanceId } from "@codexbar/contracts";
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
