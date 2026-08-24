import type { UsageSnapshot } from "@codexbar/contracts";
import type { ProviderFetchOutcome } from "@codexbar/core";
import { describe, expect, it } from "vite-plus/test";

import { makeClaudeOAuthHistoryOwnerCapture } from "../src/claude-oauth-history-capture.ts";

const snapshot: UsageSnapshot = {
  details: [],
  updatedAt: "2026-08-24T12:00:00Z",
  primary: { usedPercent: 10, windowMinutes: 300 },
};

const outcome = (strategyId = "claude.oauth"): ProviderFetchOutcome => ({
  snapshot,
  strategyId,
  source: strategyId === "claude.oauth" ? "oauth" : "cli",
  attempts: [
    { strategyId, source: strategyId === "claude.oauth" ? "oauth" : "cli", available: true },
  ],
});

const tokenAccountKey = (value: string): string => value.repeat(64).slice(0, 64);

describe("Claude OAuth history owner capture", () => {
  it("returns only an owner that stays stable around the winning OAuth fetch", async () => {
    const owner = "a".repeat(64);
    let resolves = 0;
    const capture = makeClaudeOAuthHistoryOwnerCapture({
      resolveOwner: async () => {
        resolves += 1;
        return owner;
      },
    });
    const fetched = await capture.captureFetch("claude", async () => outcome());
    expect(await capture.consume("claude", fetched)).toBe(owner);
    expect(resolves).toBe(2);
    expect(await capture.consume("claude", fetched)).toBeUndefined();
    expect(resolves).toBe(2);
  });

  it("fails closed when the owner changes or either resolver call fails", async () => {
    const owners = ["a".repeat(64), "b".repeat(64)];
    const changed = makeClaudeOAuthHistoryOwnerCapture({
      resolveOwner: async () => owners.shift(),
    });
    const changedOutcome = await changed.captureFetch("claude", async () => outcome());
    expect(await changed.consume("claude", changedOutcome)).toBeUndefined();

    let call = 0;
    const failed = makeClaudeOAuthHistoryOwnerCapture({
      resolveOwner: async () => {
        call += 1;
        if (call === 2) throw new Error("keyring unavailable");
        return "c".repeat(64);
      },
    });
    const failedOutcome = await failed.captureFetch("claude", async () => outcome());
    expect(await failed.consume("claude", failedOutcome)).toBeUndefined();
  });

  it("does not record after cancellation and does not resolve after non-OAuth fetches", async () => {
    const controller = new AbortController();
    let resolves = 0;
    const capture = makeClaudeOAuthHistoryOwnerCapture({
      resolveOwner: async () => {
        resolves += 1;
        return "d".repeat(64);
      },
    });
    const fetched = await capture.captureFetch("claude", async () => outcome());
    controller.abort();
    expect(await capture.consume("claude", fetched, controller.signal)).toBeUndefined();
    expect(resolves).toBe(1);

    const cli = await capture.captureFetch("claude", async () => outcome("claude.cli"));
    expect(await capture.consume("claude", cli)).toBeUndefined();
    expect(resolves).toBe(2);
  });

  it("uses the selected account key instead of a secret-derived OAuth owner", async () => {
    const selectedOwner = "e".repeat(64);
    let ambientResolves = 0;
    const capture = makeClaudeOAuthHistoryOwnerCapture({
      resolveOwner: async () => {
        ambientResolves += 1;
        return "f".repeat(64);
      },
      resolveSelectedAccount: async () => ({
        selectionKey: "selected-oauth",
        oauthHistoryOwnerIdentifier: selectedOwner,
        tokenAccountKey: tokenAccountKey("a"),
      }),
    });
    const fetched = await capture.captureFetch("claude", async () => outcome());
    expect(await capture.consumeHistoryBinding("claude", fetched)).toEqual({
      selectedTokenAccountKey: tokenAccountKey("a"),
    });
    expect(ambientResolves).toBe(0);
  });

  it("rejects history publication when the selected account changes during fetch", async () => {
    const selected = [
      {
        selectionKey: "selected-before",
        tokenAccountKey: tokenAccountKey("b"),
      },
      {
        selectionKey: "selected-after",
        tokenAccountKey: tokenAccountKey("c"),
      },
    ];
    const capture = makeClaudeOAuthHistoryOwnerCapture({
      resolveOwner: async () => "a".repeat(64),
      resolveSelectedAccount: async () => selected.shift(),
    });
    const fetched = await capture.captureFetch("claude", async () => outcome("claude.web"));
    expect(await capture.consumeHistoryBinding("claude", fetched)).toEqual({});
  });

  it("returns selected non-OAuth token bucket once and cleans up cancelled captures", async () => {
    const controller = new AbortController();
    const capture = makeClaudeOAuthHistoryOwnerCapture({
      resolveOwner: async () => "a".repeat(64),
      resolveSelectedAccount: async () => ({
        selectionKey: "selected-web",
        tokenAccountKey: tokenAccountKey("d"),
      }),
    });
    const fetched = await capture.captureFetch("claude", async () => outcome("claude.web"));
    expect(await capture.consumeHistoryBinding("claude", fetched)).toEqual({
      selectedTokenAccountKey: tokenAccountKey("d"),
    });
    expect(await capture.consumeHistoryBinding("claude", fetched)).toEqual({});

    const cancelled = await capture.captureFetch("claude", async () => outcome("claude.web"));
    controller.abort();
    expect(await capture.consumeHistoryBinding("claude", cancelled, controller.signal)).toEqual({});
    expect(await capture.consumeHistoryBinding("claude", cancelled)).toEqual({});
  });

  it("fails closed instead of falling back to ambient ownership when selection resolution fails", async () => {
    let selectedReads = 0;
    let ambientReads = 0;
    const beforeFailure = makeClaudeOAuthHistoryOwnerCapture({
      resolveOwner: async () => {
        ambientReads += 1;
        return "e".repeat(64);
      },
      resolveSelectedAccount: async () => {
        selectedReads += 1;
        if (selectedReads === 1) throw new Error("config unavailable");
        return undefined;
      },
    });
    const beforeOutcome = await beforeFailure.captureFetch("claude", async () => outcome());
    expect(await beforeFailure.consumeHistoryBinding("claude", beforeOutcome)).toEqual({});
    expect(ambientReads).toBe(0);

    selectedReads = 0;
    const afterFailure = makeClaudeOAuthHistoryOwnerCapture({
      resolveOwner: async () => {
        ambientReads += 1;
        return "f".repeat(64);
      },
      resolveSelectedAccount: async () => {
        selectedReads += 1;
        if (selectedReads === 2) throw new Error("config unavailable");
        return undefined;
      },
    });
    const afterOutcome = await afterFailure.captureFetch("claude", async () => outcome());
    expect(await afterFailure.consumeHistoryBinding("claude", afterOutcome)).toEqual({});
  });
});
