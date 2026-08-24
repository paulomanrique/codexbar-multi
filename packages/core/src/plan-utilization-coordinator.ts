import type { ProviderId, ProviderInstanceId, UsageSnapshot } from "@codexbar/contracts";
import { Effect, Ref, Semaphore } from "effect";
import {
  PlanUtilizationHistoryBuckets,
  PlanUtilizationHistoryEntry,
  PlanUtilizationHistorySelection,
  PlanUtilizationSeriesHistory,
  PlanUtilizationSeriesName,
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
import {
  codexHistoryCanonicalKey,
  resolveCodexHistoryIdentity,
} from "./codex-history-ownership.ts";
import {
  claudeOAuthPlanUtilizationAccountKey,
  claudePlanUtilizationIdentityAccountKey,
  claudePlanUtilizationLegacyEmailAccountKey,
} from "./claude-history-ownership.ts";
import { antigravityPlanUtilizationIdentityAccountKey } from "./antigravity-history-ownership.ts";
import type { InfrastructureError } from "./services.ts";

const PLAN_UTILIZATION_UNSCOPED_PREFERRED_KEY = "__unscoped__";

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
  readonly updatePreferredAccountKey?: boolean;
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
        const originalBuckets = cloneBuckets(buckets);
        const existing = buckets.historiesFor(input.accountKey);
        const updated = updatePlanUtilizationHistories(existing, samples);
        if (updated !== undefined) buckets.setHistories(updated, input.accountKey);
        if (
          input.updatePreferredAccountKey === true &&
          input.accountKey !== undefined &&
          input.accountKey !== null &&
          input.accountKey.length > 0
        )
          buckets.preferredAccountKey = input.accountKey;
        if (bucketsEqual(buckets, originalBuckets)) return false;
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
   * Records Codex only when the provider snapshot carries a canonical account
   * ID or email owner. Legacy/unscoped adoption remains a separate migration:
   * an unresolved refresh must never borrow a previous account's history.
   */
  recordCodex(input: {
    readonly snapshot: UsageSnapshot;
    readonly capturedAt: Date;
  }): Effect.Effect<boolean, InfrastructureError> {
    const identity = input.snapshot.identity;
    if (identity?.providerId !== "codex") return Effect.succeed(false);
    const accountKey = codexHistoryCanonicalKey(
      resolveCodexHistoryIdentity({
        ...(identity.accountId === undefined ? {} : { accountId: identity.accountId }),
        ...(identity.accountEmail === undefined ? {} : { email: identity.accountEmail }),
      }),
    );
    if (accountKey === undefined) return Effect.succeed(false);
    const samples = extractPlanUtilizationSeriesSamples({
      providerId: "codex",
      snapshot: input.snapshot,
      capturedAt: input.capturedAt,
    });
    return this.record({
      providerId: "codex",
      accountKey,
      samples,
      updatePreferredAccountKey: true,
    });
  }

  /**
   * Records Claude under a scoped identity owner when present, otherwise
   * continues the sticky scoped owner already established for this provider.
   * OAuth file/keychain owner binding remains a separate host-mediated path.
   */
  recordClaudeIdentity(input: {
    readonly snapshot: UsageSnapshot;
    readonly capturedAt: Date;
  }): Effect.Effect<boolean, InfrastructureError> {
    const samples = extractPlanUtilizationSeriesSamples({
      providerId: "claude",
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
        const buckets = providers.claude ?? new PlanUtilizationHistoryBuckets();
        const originalBuckets = cloneBuckets(buckets);
        const identityAccountKey = claudePlanUtilizationIdentityAccountKey(input.snapshot);
        const accountKey = identityAccountKey ?? stickyPlanUtilizationAccountKey(buckets);
        if (accountKey === undefined) return false;
        const canAdoptUnscoped =
          identityAccountKey !== undefined &&
          buckets.preferredAccountKey !== PLAN_UTILIZATION_UNSCOPED_PREFERRED_KEY &&
          Object.keys(buckets.accounts).length === 0;

        if (identityAccountKey !== undefined) {
          materializeLegacyClaudeHistory({
            accountKey,
            snapshot: input.snapshot,
            buckets,
          });
          buckets.preferredAccountKey = accountKey;
          if (canAdoptUnscoped) adoptUnscopedHistory(accountKey, buckets);
        }

        const existing = buckets.historiesFor(accountKey);
        const updated = updatePlanUtilizationHistories(existing, samples);
        if (updated !== undefined) buckets.setHistories(updated, accountKey);
        if (bucketsEqual(buckets, originalBuckets)) return false;

        const nextProviders = { ...providers, claude: buckets };
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

  /**
   * OAuth history never borrows sticky identity or unscoped history. The
   * secret-derived owner is validated and transformed into an opaque account
   * key before the normal serialized recorder sees it.
   */
  recordClaudeOAuth(input: {
    readonly snapshot: UsageSnapshot;
    readonly capturedAt: Date;
    readonly historyOwnerIdentifier?: string | null;
  }): Effect.Effect<boolean, InfrastructureError> {
    const accountKey = claudeOAuthPlanUtilizationAccountKey(input.historyOwnerIdentifier);
    if (accountKey === undefined) return Effect.succeed(false);
    const samples = extractPlanUtilizationSeriesSamples({
      providerId: "claude",
      snapshot: input.snapshot,
      capturedAt: input.capturedAt,
    });
    return this.record({
      providerId: "claude",
      accountKey,
      samples,
      updatePreferredAccountKey: true,
    });
  }

  /**
   * Records only the pinned Gemini 5h/weekly pair. Identityless samples start
   * unscoped or continue the sticky owner; later identity adopts legacy
   * unscoped history exactly like the Swift generic account resolver.
   */
  recordAntigravity(input: {
    readonly snapshot: UsageSnapshot;
    readonly capturedAt: Date;
  }): Effect.Effect<boolean, InfrastructureError> {
    const samples = extractPlanUtilizationSeriesSamples({
      providerId: "antigravity",
      snapshot: input.snapshot,
      capturedAt: input.capturedAt,
      forSessionEquivalents: true,
    });
    if (samples.length === 0) return Effect.succeed(false);

    const ensureLoaded = this.#ensureLoaded;
    const stateRef = this.#state;
    const repository = this.#repository;
    return this.#semaphore.withPermit(
      Effect.gen(function* () {
        const state = yield* ensureLoaded;
        const providers = cloneProviders(state.providers);
        const buckets = providers.antigravity ?? new PlanUtilizationHistoryBuckets();
        const originalBuckets = cloneBuckets(buckets);
        const identityAccountKey = antigravityPlanUtilizationIdentityAccountKey(input.snapshot);
        const accountKey =
          identityAccountKey ?? stickyPlanUtilizationAccountKey(buckets) ?? undefined;

        if (identityAccountKey !== undefined) {
          buckets.preferredAccountKey = identityAccountKey;
          adoptUnscopedHistory(identityAccountKey, buckets);
        }

        let histories = [...buckets.historiesFor(accountKey)];
        if (
          samples.some((sample) =>
            sample.name instanceof PlanUtilizationSeriesName
              ? sample.name.rawValue === "session"
              : sample.name === "session",
          ) &&
          !histories.some((history) => history.name.rawValue === "session")
        ) {
          histories = histories.filter((history) => history.name.rawValue !== "weekly");
        }
        const updated = updatePlanUtilizationHistories(histories, samples) ?? histories;
        buckets.setHistories(updated, accountKey);
        if (bucketsEqual(buckets, originalBuckets)) return false;

        const nextProviders = { ...providers, antigravity: buckets };
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

const materializeLegacyClaudeHistory = (input: {
  readonly accountKey: string;
  readonly snapshot: UsageSnapshot;
  readonly buckets: PlanUtilizationHistoryBuckets;
}): void => {
  const legacyKey = claudePlanUtilizationLegacyEmailAccountKey(input.snapshot);
  if (legacyKey === undefined || legacyKey === input.accountKey) return;
  const legacyHistories = input.buckets.accounts[legacyKey];
  if (legacyHistories === undefined || legacyHistories.length === 0) return;
  const existingHistories = input.buckets.accounts[input.accountKey] ?? [];
  input.buckets.setHistories(
    mergePlanUtilizationHistories(existingHistories, legacyHistories),
    input.accountKey,
  );
  delete input.buckets.accounts[legacyKey];
  if (input.buckets.preferredAccountKey === legacyKey)
    input.buckets.preferredAccountKey = input.accountKey;
};

const adoptUnscopedHistory = (accountKey: string, buckets: PlanUtilizationHistoryBuckets): void => {
  if (buckets.unscoped.length === 0) return;
  const existingHistories = buckets.accounts[accountKey] ?? [];
  buckets.setHistories(
    mergePlanUtilizationHistories(existingHistories, buckets.unscoped),
    accountKey,
  );
  buckets.setHistories([], null);
};

const stickyPlanUtilizationAccountKey = (
  buckets: PlanUtilizationHistoryBuckets,
): string | undefined => {
  if (buckets.preferredAccountKey === PLAN_UTILIZATION_UNSCOPED_PREFERRED_KEY) return undefined;
  const accountKeys = Object.keys(buckets.accounts);
  if (accountKeys.length === 0) return undefined;
  if (
    buckets.preferredAccountKey !== undefined &&
    accountKeys.includes(buckets.preferredAccountKey)
  )
    return buckets.preferredAccountKey;
  if (accountKeys.length === 1) return accountKeys[0];
  return accountKeys.sort((left, right) => {
    const leftLatest = latestCapturedAt(buckets.accounts[left] ?? []);
    const rightLatest = latestCapturedAt(buckets.accounts[right] ?? []);
    return rightLatest - leftLatest || compareUnicodeScalars(left, right);
  })[0];
};

const latestCapturedAt = (histories: readonly PlanUtilizationSeriesHistory[]): number =>
  histories.reduce(
    (latest, history) => Math.max(latest, history.latestCapturedAt?.getTime() ?? -Infinity),
    -Infinity,
  );

const compareUnicodeScalars = (left: string, right: string): number => {
  const leftScalars = Array.from(left, (character) => character.codePointAt(0) ?? 0);
  const rightScalars = Array.from(right, (character) => character.codePointAt(0) ?? 0);
  const length = Math.min(leftScalars.length, rightScalars.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftScalars[index]! - rightScalars[index]!;
    if (difference !== 0) return difference;
  }
  return leftScalars.length - rightScalars.length;
};

const mergePlanUtilizationHistories = (
  ...sources: readonly (readonly PlanUtilizationSeriesHistory[])[]
): readonly PlanUtilizationSeriesHistory[] => {
  let merged: readonly PlanUtilizationSeriesHistory[] = [];
  for (const histories of sources) {
    const samples = histories.flatMap((history) =>
      history.entries.map((entry) => ({
        name: history.name,
        windowMinutes: history.windowMinutes,
        entry,
      })),
    );
    merged = updatePlanUtilizationHistories(merged, samples) ?? merged;
  }
  return merged;
};

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
