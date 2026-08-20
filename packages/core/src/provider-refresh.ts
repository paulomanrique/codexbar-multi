import { Effect } from "effect";
import type { ProviderId } from "@codexbar/contracts";
import type {
  ProviderFetchContext,
  ProviderFetchError,
  ProviderFetchOutcome,
} from "./provider-fetch-pipeline.ts";
import {
  Clock,
  HistoryRepository,
  type ClockService,
  type HistoryRepositoryService,
  type InfrastructureError,
  type ProviderRuntimeService,
} from "./services.ts";

/**
 * The one place a successfully fetched usage snapshot becomes history. Failed
 * fetches deliberately do not create synthetic or error-shaped history rows.
 */
export const refreshProviderAndPersist = (
  runtime: ProviderRuntimeService,
  providerId: ProviderId,
  context: ProviderFetchContext,
): Effect.Effect<
  ProviderFetchOutcome,
  ProviderFetchError | InfrastructureError,
  ClockService | HistoryRepositoryService
> =>
  Effect.gen(function* () {
    const outcome = yield* runtime.fetch(providerId, context);
    const clock = yield* Clock;
    const history = yield* HistoryRepository;
    const recordedAt = yield* clock.now;
    yield* history.append({ providerId, recordedAt, snapshot: outcome.snapshot });
    return outcome;
  });
