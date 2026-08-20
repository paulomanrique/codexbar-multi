import { Effect } from "effect";
import type {
  CostUsageExportDTO,
  CostUsageQueryDTO,
  CostUsageQueryResultDTO,
  HistoryExportDTO,
  HistoryQueryDTO,
  HistoryQueryResultDTO,
} from "@codexbar/contracts";
import type { NodeSqliteWorkerPersistence } from "@codexbar/platform/node";

const DEFAULT_RESULT_LIMIT = 1_000;

type Persistence = Pick<NodeSqliteWorkerPersistence, "history" | "costs">;

const limitFor = (query: { readonly limit?: number | undefined }): number =>
  query.limit ?? DEFAULT_RESULT_LIMIT;

const fetchLimitFor = (query: { readonly limit?: number | undefined }): number =>
  limitFor(query) + 1;

export const queryHistory = async (
  persistence: Persistence,
  query: HistoryQueryDTO,
): Promise<HistoryQueryResultDTO> => {
  const records = await Effect.runPromise(
    persistence.history.list(query.provider, query.since ?? 0, fetchLimitFor(query)),
  );
  const limit = limitFor(query);
  return { records: records.slice(0, limit), truncated: records.length > limit };
};

export const exportHistory = async (
  persistence: Persistence,
  query: HistoryQueryDTO,
  now: () => Date = () => new Date(),
): Promise<HistoryExportDTO> => ({
  schemaVersion: 1,
  exportedAt: now().toISOString(),
  ...(await queryHistory(persistence, query)),
});

export const queryCosts = async (
  persistence: Persistence,
  query: CostUsageQueryDTO,
): Promise<CostUsageQueryResultDTO> => {
  const records = await Effect.runPromise(
    persistence.costs.list(query.provider, query.since ?? 0, fetchLimitFor(query)),
  );
  const limit = limitFor(query);
  return { records: records.slice(0, limit), truncated: records.length > limit };
};

export const exportCosts = async (
  persistence: Persistence,
  query: CostUsageQueryDTO,
  now: () => Date = () => new Date(),
): Promise<CostUsageExportDTO> => ({
  schemaVersion: 1,
  exportedAt: now().toISOString(),
  ...(await queryCosts(persistence, query)),
});
