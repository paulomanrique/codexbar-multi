import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { createSpendPublication, type CostUsageRecord } from "@codexbar/core";

import {
  DesktopSpendPublisher,
  publishedSpendOverviewInputs,
  type DesktopSpendPersistence,
} from "../src/main/spend-overview.ts";

const snapshot = {
  details: [],
  updatedAt: "2026-08-20T00:00:00.000Z",
  dataConfidence: "exact" as const,
};

describe("published desktop spend overview (Swift #3067 parity)", () => {
  it("reuses only current, available sources in the requested provider silo", () => {
    const publication = createSpendPublication({
      revision: 1,
      generation: 1,
      configuration: { ownershipFingerprint: "owner-a" },
      loadedAt: "2026-08-20T00:00:00.000Z",
      isRefreshing: false,
      roster: [
        { id: "codex:work", providerId: "codex", displayName: "Codex work" },
        { id: "claude", providerId: "claude", displayName: "Claude" },
      ],
      inputs: [
        { id: "codex:work", providerId: "codex", displayName: "Codex work", snapshot },
        { id: "claude", providerId: "claude", displayName: "Claude", snapshot },
      ],
      failedSourceIds: new Set(["claude"]),
    });

    expect(publishedSpendOverviewInputs(publication, "owner-a", new Set(["codex"]))).toEqual([
      expect.objectContaining({ id: "codex:work", providerId: "codex" }),
    ]);
    expect(publishedSpendOverviewInputs(publication, "owner-a", new Set(["claude"]))).toEqual([]);
    expect(publishedSpendOverviewInputs(publication, "owner-b", new Set(["codex"]))).toEqual([]);
  });

  it("publishes repository-backed overview and dashboard DTOs without source identities", async () => {
    const records: readonly CostUsageRecord[] = [
      {
        providerId: "codex",
        recordedAt: Date.parse("2026-08-20T10:00:00.000Z"),
        inputTokens: 12,
        outputTokens: 8,
        costUsd: 0.5,
      },
    ];
    const persistence: DesktopSpendPersistence = {
      costs: {
        list: (provider) => Effect.succeed(provider === "codex" ? records : []),
      },
    };
    const publisher = new DesktopSpendPublisher(
      persistence,
      () => new Date("2026-08-20T12:00:00.000Z"),
    );
    const projection = await publisher.refresh({
      ownershipFingerprint: "safe-owner-digest",
      requestedDays: 30,
      roster: [
        { id: "codex:private-profile", providerId: "codex", displayName: "Codex" },
        { id: "openai", providerId: "openai", displayName: "OpenAI" },
      ],
    });

    expect(projection.overview).toMatchObject({
      schemaVersion: 1,
      isRefreshing: false,
      totals: expect.objectContaining({ totalTokens: 20, costUsd: 0.5, sourceCount: 1 }),
      sources: [
        { provider: "codex", displayName: "Codex", state: "available" },
        { provider: "openai", displayName: "OpenAI", state: "confirmed-empty" },
      ],
    });
    expect(projection.dashboard.dailyPoints).toEqual([
      {
        provider: "codex",
        day: "2026-08-20",
        inputTokens: 12,
        outputTokens: 8,
        costUsd: 0.5,
      },
    ]);
    expect(JSON.stringify(projection)).not.toContain("codex:private-profile");
  });

  it("keeps a prior provider result stale on a failed read and rejects late generations", async () => {
    let shouldFail = false;
    let resolveFirst: ((records: readonly CostUsageRecord[]) => void) | undefined;
    let firstCall = true;
    const persistence: DesktopSpendPersistence = {
      costs: {
        list: () =>
          Effect.promise(() => {
            if (shouldFail) return Promise.reject(new Error("private storage detail"));
            if (!firstCall) {
              return Promise.resolve([
                {
                  providerId: "codex",
                  recordedAt: Date.parse("2026-08-20T10:00:00.000Z"),
                  inputTokens: 2,
                  outputTokens: 3,
                  costUsd: 0.1,
                },
              ]);
            }
            firstCall = false;
            return new Promise<readonly CostUsageRecord[]>((resolve) => {
              resolveFirst = resolve;
            });
          }),
      },
    };
    const publisher = new DesktopSpendPublisher(
      persistence,
      () => new Date("2026-08-20T12:00:00.000Z"),
    );
    const configuration = {
      ownershipFingerprint: "safe-owner-digest",
      requestedDays: 30,
      roster: [{ id: "codex", providerId: "codex" as const, displayName: "Codex" }],
    };
    const first = publisher.refresh(configuration);
    const second = await publisher.refresh(configuration);
    resolveFirst?.([]);
    const firstResult = await first;
    expect(firstResult.overview.generation).toBe(second.overview.generation);

    shouldFail = true;
    const stale = await publisher.refresh(configuration);
    expect(stale.overview.sources).toEqual([
      expect.objectContaining({ provider: "codex", state: "stale-last-known" }),
    ]);
    expect(stale.overview.totals.totalTokens).toBe(0);
  });
});
