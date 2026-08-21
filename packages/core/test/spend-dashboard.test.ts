import { describe, expect, it } from "vite-plus/test";

import { buildSpendDashboard, createSpendPublication } from "../src/index.ts";

const loadedAt = "2026-08-20T12:00:00.000Z";

describe("spend dashboard projection (Swift #3067 parity)", () => {
  it("aggregates only available owned sources and keeps source IDs out of the DTO", () => {
    const publication = createSpendPublication({
      revision: 3,
      generation: 8,
      configuration: { ownershipFingerprint: "owner-a" },
      loadedAt,
      isRefreshing: false,
      roster: [
        { id: "codex:private-account", providerId: "codex", displayName: "Codex work" },
        { id: "claude", providerId: "claude", displayName: "Claude" },
      ],
      inputs: [
        { id: "codex:private-account", providerId: "codex", displayName: "Codex work" },
        { id: "claude", providerId: "claude", displayName: "Claude" },
      ],
      failedSourceIds: new Set(["claude"]),
    });

    const result = buildSpendDashboard({
      publication,
      ownershipFingerprint: "owner-a",
      requestedDays: 30,
      truncated: false,
      records: [
        {
          sourceId: "codex:private-account",
          providerId: "codex",
          recordedAt: Date.parse("2026-08-20T09:00:00.000Z"),
          inputTokens: 4,
          outputTokens: 6,
          costUsd: 0.25,
        },
        {
          sourceId: "claude",
          providerId: "claude",
          recordedAt: Date.parse("2026-08-20T09:00:00.000Z"),
          inputTokens: 999,
          outputTokens: 999,
          costUsd: 99,
        },
        {
          sourceId: "codex:private-account",
          providerId: "codex",
          recordedAt: Date.parse("2026-07-01T09:00:00.000Z"),
          inputTokens: 999,
          outputTokens: 999,
          costUsd: 99,
        },
      ],
    });

    expect(result?.overview).toMatchObject({
      revision: 3,
      generation: 8,
      totals: {
        inputTokens: 4,
        outputTokens: 6,
        totalTokens: 10,
        costUsd: 0.25,
        coveredDayCount: 1,
        sourceCount: 1,
      },
      sources: [
        { provider: "codex", displayName: "Codex work", state: "available" },
        { provider: "claude", displayName: "Claude", state: "stale-last-known" },
      ],
      providers: [
        {
          provider: "codex",
          displayName: "Codex work",
          totals: expect.objectContaining({ costUsd: 0.25 }),
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("codex:private-account");
    expect(result?.dashboard.dailyPoints).toEqual([
      {
        provider: "codex",
        day: "2026-08-20",
        inputTokens: 4,
        outputTokens: 6,
        costUsd: 0.25,
      },
    ]);
  });

  it("refuses a projection after ownership changes and fails closed on crossed records", () => {
    const publication = createSpendPublication({
      revision: 1,
      generation: 1,
      configuration: { ownershipFingerprint: "owner-a" },
      loadedAt,
      isRefreshing: false,
      roster: [{ id: "codex", providerId: "codex", displayName: "Codex" }],
      inputs: [{ id: "codex", providerId: "codex", displayName: "Codex" }],
    });
    expect(
      buildSpendDashboard({
        publication,
        ownershipFingerprint: "owner-b",
        requestedDays: 30,
        truncated: false,
        records: [],
      }),
    ).toBeUndefined();
    expect(() =>
      buildSpendDashboard({
        publication,
        ownershipFingerprint: "owner-a",
        requestedDays: 30,
        truncated: false,
        records: [
          {
            sourceId: "codex",
            providerId: "claude",
            recordedAt: 1,
            inputTokens: 0,
            outputTokens: 0,
            costUsd: 0,
          },
        ],
      }),
    ).toThrow("crosses provider ownership");
  });
});
