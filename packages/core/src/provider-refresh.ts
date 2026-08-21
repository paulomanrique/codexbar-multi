import { Effect } from "effect";
import type { ProviderId } from "@codexbar/contracts";
import type {
  ProviderFetchContext,
  ProviderFetchError,
  ProviderFetchOutcome,
} from "./provider-fetch-pipeline.ts";
import {
  Clock,
  CostUsageRepository,
  HistoryRepository,
  type ClockService,
  type CostUsageRepositoryService,
  type HistoryRepositoryService,
  type InfrastructureError,
  type ProviderRuntimeService,
} from "./services.ts";
import { mapXaiDailySpendSnapshot } from "./daily-spend-ingestion.ts";

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
  ClockService | HistoryRepositoryService | CostUsageRepositoryService
> =>
  Effect.gen(function* () {
    const outcome = yield* runtime.fetch(providerId, context);
    const clock = yield* Clock;
    const history = yield* HistoryRepository;
    const costs = yield* CostUsageRepository;
    const recordedAt = yield* clock.now;
    yield* history.append({ providerId, recordedAt, snapshot: outcome.snapshot });
    // xAI's Management API chart is cumulative per UTC day. Replace it as a
    // single transaction, never append it alongside the preceding refresh.
    if (providerId === "xai") yield* costs.replaceDaily(mapXaiDailySpendSnapshot(outcome.snapshot));
    return outcome;
  });
