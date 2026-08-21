import { describe, expect, it } from "vite-plus/test";
import { createSpendPublication } from "@codexbar/core";

import { publishedSpendOverviewInputs } from "../src/main/spend-overview.ts";

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
});
