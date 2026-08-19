import { Context, Effect, Result } from "effect";
import type {
  ProviderError,
  ProviderFetchClassifiedError as ContractFetchFailure,
  ProviderId,
  UsageSnapshot,
} from "@codexbar/contracts";
import { Clock } from "./services.ts";
import type { ClockService } from "./services.ts";

export type FetchSource = "cli" | "web" | "oauth" | "api-token" | "local-probe" | "web-dashboard";

export interface ProviderFetchContext {
  readonly sourceMode: "auto" | "web" | "cli" | "oauth" | "api";
  readonly includeCredits: boolean;
  readonly metadata?: Readonly<Record<string, string>>;
}

/** A portable classified failure used by adapters that need a delayed retry. */
export class ClassifiedFetchFailure extends Error {
  readonly _tag = "ClassifiedFetchFailure";
  readonly kind:
    | "authentication-expired"
    | "missing-credential"
    | "permission-denied"
    | "rate-limited"
    | "provider-unavailable"
    | "parse-failure"
    | "network-failure"
    | "api-failure";
  readonly retryAfterMs: number | undefined;

  constructor(
    kind:
      | "authentication-expired"
      | "missing-credential"
      | "permission-denied"
      | "rate-limited"
      | "provider-unavailable"
      | "parse-failure"
      | "network-failure"
      | "api-failure",
    message: string,
    retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ClassifiedFetchFailure";
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
}

export class NoAvailableStrategy extends Error {
  readonly _tag = "NoAvailableStrategy";
  readonly providerId: ProviderId;

  constructor(providerId: ProviderId) {
    super(`No available fetch strategy for ${providerId}.`);
    this.name = "NoAvailableStrategy";
    this.providerId = providerId;
  }
}

export type FetchFailure = ProviderError | ContractFetchFailure;
export type ProviderFetchError = FetchFailure | ClassifiedFetchFailure | NoAvailableStrategy;

export interface ProviderFetchStrategy {
  readonly id: string;
  readonly source: FetchSource;
  readonly isAvailable: (context: ProviderFetchContext) => Effect.Effect<boolean>;
  readonly fetch: (
    context: ProviderFetchContext,
  ) => Effect.Effect<UsageSnapshot, FetchFailure | ClassifiedFetchFailure>;
  /** Strategy-specific policy, mirroring the Swift descriptor's shouldFallback hook. */
  readonly shouldFallback: (
    error: FetchFailure | ClassifiedFetchFailure,
    context: ProviderFetchContext,
  ) => boolean;
}

export interface ProviderFetchAttempt {
  readonly strategyId: string;
  readonly source: FetchSource;
  readonly available: boolean;
  readonly error?: FetchFailure | ClassifiedFetchFailure;
}

export interface ProviderFetchOutcome {
  readonly snapshot: UsageSnapshot;
  readonly strategyId: string;
  readonly source: FetchSource;
  readonly attempts: ReadonlyArray<ProviderFetchAttempt>;
}

export interface ProviderFetchPipelineService {
  readonly fetch: (
    providerId: ProviderId,
    context: ProviderFetchContext,
  ) => Effect.Effect<ProviderFetchOutcome, ProviderFetchError, ClockService>;
}

export const ProviderFetchPipeline = Context.Service<ProviderFetchPipelineService>(
  "@codexbar/core/ProviderFetchPipeline",
);

export interface ProviderFetchPipelineConfig {
  readonly resolveStrategies: (
    providerId: ProviderId,
    context: ProviderFetchContext,
  ) => Effect.Effect<ReadonlyArray<ProviderFetchStrategy>>;
}

/**
 * Builds the ordered pipeline used by every provider. Availability is recorded,
 * interruption is never turned into fallback, and classified retry happens once
 * before the descriptor gets its one faithful shouldFallback decision.
 */
export const makeProviderFetchPipeline = (
  config: ProviderFetchPipelineConfig,
): ProviderFetchPipelineService => ({
  fetch: (providerId, context) =>
    Effect.gen(function* () {
      const clock = yield* Clock;
      const strategies = yield* config.resolveStrategies(providerId, context);
      const attempts: Array<ProviderFetchAttempt> = [];
      let lastError: FetchFailure | ClassifiedFetchFailure | undefined;

      for (const strategy of strategies) {
        const available = yield* strategy.isAvailable(context);
        if (!available) {
          attempts.push({ strategyId: strategy.id, source: strategy.source, available: false });
          continue;
        }

        const result = yield* Effect.result(runClassifiedRetryOnce(strategy.fetch(context), clock));
        if (Result.isSuccess(result)) {
          attempts.push({ strategyId: strategy.id, source: strategy.source, available: true });
          return {
            snapshot: result.success,
            strategyId: strategy.id,
            source: strategy.source,
            attempts,
          };
        }

        const error = result.failure;
        lastError = error;
        attempts.push({ strategyId: strategy.id, source: strategy.source, available: true, error });
        if (!strategy.shouldFallback(error, context)) {
          return yield* Effect.fail(error);
        }
      }

      return yield* Effect.fail(lastError ?? new NoAvailableStrategy(providerId));
    }),
});

const runClassifiedRetryOnce = <A>(
  operation: Effect.Effect<A, FetchFailure | ClassifiedFetchFailure>,
  clock: ClockService,
): Effect.Effect<A, FetchFailure | ClassifiedFetchFailure> =>
  Effect.flatMap(Effect.result(operation), (result) => {
    if (Result.isSuccess(result)) return Effect.succeed(result.success);
    const retryAfterMs = retryAfterMilliseconds(result.failure);
    if (retryAfterMs === undefined) return Effect.fail(result.failure);
    return Effect.andThen(clock.sleep(retryAfterMs), operation);
  });

const retryAfterMilliseconds = (
  error: FetchFailure | ClassifiedFetchFailure,
): number | undefined => {
  if (error instanceof ClassifiedFetchFailure) {
    return normalizedDelay(error.retryAfterMs);
  }
  // Contracts deliberately crosses the core boundary as data. Accept its two
  // supported duration spellings without coupling core to a provider package.
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    const milliseconds = record.retryAfterMs;
    if (typeof milliseconds === "number") return normalizedDelay(milliseconds);
    const seconds = record.retryAfterSeconds;
    if (typeof seconds === "number") return normalizedDelay(seconds * 1_000);
  }
  return undefined;
};

const normalizedDelay = (milliseconds: number | undefined): number | undefined => {
  if (milliseconds === undefined || !Number.isFinite(milliseconds) || milliseconds < 0)
    return undefined;
  return Math.min(milliseconds, 10_000);
};
