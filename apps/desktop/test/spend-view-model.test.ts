import { describe, expect, it } from "vite-plus/test";
import type { SpendDashboardDTO, SpendOverviewDTO } from "@codexbar/contracts";

import { spendPresentation } from "../src/renderer/spend-view-model.ts";

const totals = {
  inputTokens: 10,
  outputTokens: 20,
  totalTokens: 30,
  costUsd: 0.75,
  coveredDayCount: 2,
  sourceCount: 1,
};
const overview: SpendOverviewDTO = {
  schemaVersion: 1,
  revision: 1,
  generation: 1,
  loadedAt: "2026-08-20T00:00:00.000Z",
  isRefreshing: false,
  truncated: false,
  sources: [
    { provider: "codex", displayName: "Codex", role: "subscription", state: "available" },
    { provider: "claude", displayName: "Claude", role: "subscription", state: "stale-last-known" },
    { provider: "openai", displayName: "OpenAI", role: "enrichment", state: "unavailable" },
  ],
  totals,
  providers: [{ provider: "codex", displayName: "Codex", totals }],
};

describe("spend renderer presentation", () => {
  it("keeps totals and day points in the published provider silos", () => {
    const dashboard: SpendDashboardDTO = {
      overview,
      requestedDays: 30,
      dailyPoints: [
        { provider: "codex", day: "2026-08-19", inputTokens: 3, outputTokens: 4, costUsd: 0.2 },
        { provider: "codex", day: "2026-08-19", inputTokens: 7, outputTokens: 16, costUsd: 0.55 },
        { provider: "claude", day: "2026-08-19", inputTokens: 999, outputTokens: 999, costUsd: 99 },
      ],
    };

    expect(spendPresentation(overview, dashboard, false, false)).toMatchObject({
      state: "ready",
      staleSourceCount: 1,
      unavailableSourceCount: 1,
      dailySeries: [{ day: "2026-08-19", inputTokens: 10, outputTokens: 20, costUsd: 0.75 }],
    });
  });

  it("models loading, empty, and failed requests deterministically", () => {
    expect(spendPresentation(undefined, undefined, true, false).state).toBe("loading");
    expect(spendPresentation(undefined, undefined, false, true).state).toBe("error");
    expect(
      spendPresentation(
        { ...overview, totals: { ...totals, totalTokens: 0, costUsd: 0 }, providers: [] },
        undefined,
        false,
        false,
      ).state,
    ).toBe("empty");
  });

  it("does not preserve internal source identities in the renderer model", () => {
    const presentation = spendPresentation(overview, undefined, false, false);
    const rendered = JSON.stringify(presentation);
    expect(rendered).not.toContain("fingerprint");
    expect(rendered).not.toContain("sourceId");
    expect(rendered).not.toContain("secret");
  });
});
