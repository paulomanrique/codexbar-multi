import { describe, expect, it } from "vite-plus/test";

import {
  costTotals,
  displayPercent,
  firstPartyProviderId,
  historySince,
  implementationPresentation,
  claudeSwapActivationRequest,
  safeDateFromTimestamp,
} from "../src/renderer/view-model.ts";

describe("desktop renderer view model", () => {
  it("forwards only an eligible opaque Claude account ID", () => {
    expect(
      claudeSwapActivationRequest(
        { id: "claude" },
        { id: "source-account", active: false, canActivate: true },
      ),
    ).toEqual({ provider: "claude", accountId: "source-account" });
    expect(
      claudeSwapActivationRequest(
        { id: "claude" },
        { id: "source-account", active: true, canActivate: true },
      ),
    ).toBeUndefined();
    expect(
      claudeSwapActivationRequest(
        { id: "openai" },
        { id: "source-account", active: false, canActivate: true },
      ),
    ).toBeUndefined();
  });
  it("never represents a partial implementation as release-ready", () => {
    expect(implementationPresentation({ implementationStatus: "partial" })).toBe("parity-pending");
    expect(implementationPresentation({ implementationStatus: "unported" })).toBe("unported");
  });

  it("bounds malformed usage values before they reach progress geometry", () => {
    expect(displayPercent(-3)).toBe(0);
    expect(displayPercent(36.5)).toBe(36.5);
    expect(displayPercent(140)).toBe(100);
    expect(displayPercent(Number.NaN)).toBe(0);
    expect(displayPercent(Number.POSITIVE_INFINITY)).toBe(0);
    expect(displayPercent(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it("rejects timestamps that JavaScript cannot render safely", () => {
    expect(safeDateFromTimestamp(0)?.toISOString()).toBe("1970-01-01T00:00:00.000Z");
    expect(safeDateFromTimestamp(-1)).toBeUndefined();
    expect(safeDateFromTimestamp(8_640_000_000_000_001)).toBeUndefined();
    expect(safeDateFromTimestamp(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it("only permits the fixed first-party roster through the refresh UI", () => {
    expect(firstPartyProviderId("codex")).toBe("codex");
    expect(firstPartyProviderId("fixture-meter")).toBeUndefined();
  });

  it("keeps history ranges bounded and aggregates the renderer-safe cost DTO", () => {
    expect(historySince(0, 86_400_000)).toBe(0);
    expect(historySince(7, 1_000_000_000)).toBe(395_200_000);
    expect(
      costTotals([
        { providerId: "codex", recordedAt: 1, inputTokens: 3, outputTokens: 5, costUsd: 0.01 },
        { providerId: "codex", recordedAt: 2, inputTokens: 7, outputTokens: 11, costUsd: 0.03 },
      ]),
    ).toEqual({ inputTokens: 10, outputTokens: 16, costUsd: 0.04 });
  });
});
