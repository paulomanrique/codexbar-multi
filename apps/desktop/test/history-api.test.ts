import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import type { NodeSqliteWorkerPersistence } from "@codexbar/platform/node";

import { exportCosts, exportHistory, queryCosts, queryHistory } from "../src/main/history-api.ts";
import { loadPersistedOverview } from "../src/main/overview.ts";

const snapshot = (updatedAt: string) => ({
  details: [],
  updatedAt,
  primary: { usedPercent: 25, resetsAt: "2026-01-02T00:00:00.000Z" },
  providerCost: {
    used: 1,
    limit: 10,
    currencyCode: "USD",
    updatedAt,
  },
});

type HistoryRecord = Parameters<NodeSqliteWorkerPersistence["history"]["append"]>[0];
type CostUsageRecord = Parameters<NodeSqliteWorkerPersistence["costs"]["append"]>[0];

const makePersistence = (): Pick<NodeSqliteWorkerPersistence, "history" | "costs"> & {
  readonly historyLimits: number[];
  readonly costLimits: number[];
} => {
  const historyLimits: number[] = [];
  const costLimits: number[] = [];
  const history: HistoryRecord[] = [
    {
      providerId: "codex" as const,
      recordedAt: 10,
      snapshot: snapshot("2026-01-01T00:00:00.000Z"),
    },
    {
      providerId: "codex" as const,
      recordedAt: 20,
      snapshot: snapshot("2026-01-01T01:00:00.000Z"),
    },
  ];
  const costs: CostUsageRecord[] = [
    {
      providerId: "codex" as const,
      recordedAt: 10,
      inputTokens: 3,
      outputTokens: 5,
      costUsd: 0.01,
    },
    {
      providerId: "codex" as const,
      recordedAt: 20,
      inputTokens: 7,
      outputTokens: 11,
      costUsd: 0.03,
    },
  ];
  return {
    history: {
      append: (record) =>
        Effect.sync(() => {
          history.push(record);
        }),
      latest: (providerId) =>
        Effect.sync(() => history.findLast((record) => record.providerId === providerId)),
      list: (providerId, since, limit) =>
        Effect.sync(() => {
          if (limit !== undefined) historyLimits.push(limit);
          const matching = history.filter(
            (record) => record.providerId === providerId && record.recordedAt >= since,
          );
          return limit === undefined ? matching : matching.slice(0, limit);
        }),
    },
    costs: {
      append: (record) =>
        Effect.sync(() => {
          costs.push(record);
        }),
      list: (providerId, since, limit) =>
        Effect.sync(() => {
          if (limit !== undefined) costLimits.push(limit);
          const matching = costs.filter(
            (record) => record.providerId === providerId && record.recordedAt >= since,
          );
          return limit === undefined ? matching : matching.slice(0, limit);
        }),
    },
    historyLimits,
    costLimits,
  };
};

describe("desktop history and cost APIs", () => {
  it("returns bounded provider records and keeps export in the DTO boundary", async () => {
    const persistence = makePersistence();
    await expect(queryHistory(persistence, { provider: "codex", limit: 1 })).resolves.toEqual({
      records: [expect.objectContaining({ providerId: "codex", recordedAt: 10 })],
      truncated: true,
    });
    await expect(queryCosts(persistence, { provider: "codex", since: 15 })).resolves.toEqual({
      records: [expect.objectContaining({ providerId: "codex", recordedAt: 20 })],
      truncated: false,
    });
    expect(persistence.historyLimits).toEqual([2]);
    expect(persistence.costLimits).toEqual([1_001]);
    await expect(
      exportHistory(persistence, { provider: "codex" }, () => new Date("2026-01-02T00:00:00.000Z")),
    ).resolves.toMatchObject({
      schemaVersion: 1,
      exportedAt: "2026-01-02T00:00:00.000Z",
      records: expect.arrayContaining([expect.objectContaining({ providerId: "codex" })]),
    });
    await expect(
      exportCosts(persistence, { provider: "codex" }, () => new Date("2026-01-02T00:00:00.000Z")),
    ).resolves.toMatchObject({
      schemaVersion: 1,
      exportedAt: "2026-01-02T00:00:00.000Z",
      records: expect.arrayContaining([expect.objectContaining({ providerId: "codex" })]),
    });
  });

  it("uses a stored latest snapshot and keeps an unknown empty provider out of history", async () => {
    const persistence = makePersistence();
    const overview = await loadPersistedOverview(
      persistence,
      () => new Date("2026-01-03T00:00:00.000Z"),
      [
        { id: "codex", name: "Codex", status: "partial", enabled: false, source: "oauth" },
        { id: "claude", name: "Claude", status: "unported", enabled: true, source: "cli" },
      ],
    );

    expect(overview.providers).toEqual([
      expect.objectContaining({
        id: "codex",
        enabled: false,
        implementationStatus: "partial",
        source: "oauth",
        updatedAt: "2026-01-01T01:00:00.000Z",
        windows: [
          expect.objectContaining({ kind: "primary", usedPercent: 25, remainingPercent: 75 }),
        ],
      }),
      expect.objectContaining({
        id: "claude",
        enabled: true,
        implementationStatus: "unported",
        source: "cli",
        updatedAt: "2026-01-03T00:00:00.000Z",
        windows: [],
      }),
    ]);
    await expect(queryHistory(persistence, { provider: "claude" })).resolves.toEqual({
      records: [],
      truncated: false,
    });
  });
});
