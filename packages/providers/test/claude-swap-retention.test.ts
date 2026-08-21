import { describe, expect, it } from "vite-plus/test";

import {
  CLAUDE_SWAP_DEFERRED_POLLING_NOTE,
  claudeSwapAccountFingerprint,
  deserializeClaudeSwapRetainedUsage,
  projectClaudeSwapAccounts,
  serializeClaudeSwapRetainedUsage,
} from "../src/providers/claude-swap-retention.ts";

const now = new Date("2026-08-20T12:00:00Z");
const future = "2026-08-21T12:00:00Z";

const row = (overrides: Record<string, unknown> = {}) => ({
  number: 1,
  email: "limited@example.com",
  isActive: true,
  usageStatus: "ok" as const,
  fiveHour: { usedPercent: 100, resetsAt: future },
  ...overrides,
});

describe("Claude Swap retained at-limit usage (#3081)", () => {
  it("projects an unavailable at-limit payload, prunes reset lanes, and retains the limit note", () => {
    const accounts = projectClaudeSwapAccounts(
      {
        accounts: [
          row({
            usageStatus: "unavailable",
            fiveHour: { usedPercent: 100, resetsAt: "2026-08-20T11:59:00Z" },
            sevenDay: { usedPercent: 100, resetsAt: future },
          }),
        ],
      },
      { now },
    );
    expect(accounts[0]?.snapshot?.primary).toBeUndefined();
    expect(accounts[0]).toMatchObject({
      snapshot: { secondary: { usedPercent: 100 } },
      error: "Weekly limit reached. Resets in 1d.",
    });
  });

  it("retains only exhausted future windows for a matching account after an unavailable response", () => {
    const previous = projectClaudeSwapAccounts({ accounts: [row()] }, { now });
    const accounts = projectClaudeSwapAccounts(
      { accounts: [row({ usageStatus: "unavailable", fiveHour: undefined })] },
      { now, previousAccounts: previous },
    );
    expect(accounts[0]).toMatchObject({
      snapshot: {
        primary: { usedPercent: 100 },
        identity: { accountEmail: "limited@example.com" },
      },
      error: "Session limit reached. Resets in 1d.",
    });
  });

  it("does not reuse a slot when its email changes or is absent", () => {
    const previous = projectClaudeSwapAccounts({ accounts: [row()] }, { now });
    for (const email of ["new@example.com", ""]) {
      const accounts = projectClaudeSwapAccounts(
        { accounts: [row({ email, usageStatus: "unavailable", fiveHour: undefined })] },
        { now, previousAccounts: previous },
      );
      expect(accounts[0]?.snapshot).toBeUndefined();
      expect(accounts[0]).toMatchObject({
        displayLabel: email === "" ? "Account 1" : email,
        error: CLAUDE_SWAP_DEFERRED_POLLING_NOTE,
      });
    }
  });

  it("keeps non-unavailable sentinels metric-less even with an at-limit payload", () => {
    const accounts = projectClaudeSwapAccounts(
      { accounts: [row({ usageStatus: "token_expired" })] },
      { now },
    );
    expect(accounts[0]?.snapshot).toBeUndefined();
    expect(accounts[0]).toMatchObject({
      error: "Token expired. Switch to this account in claude-swap to refresh it.",
    });
  });

  it("uses Swift-compatible scoped weekly IDs and excludes all-models duplicates", () => {
    const accounts = projectClaudeSwapAccounts(
      {
        accounts: [
          row({
            scoped: [
              { name: "Fable", usedPercent: 100, resetsAt: future },
              { name: "All Models", usedPercent: 100, resetsAt: future },
              { name: "Fable", usedPercent: 40, resetsAt: future },
            ],
          }),
        ],
      },
      { now },
    );
    expect(accounts[0]?.snapshot?.extraRateWindows).toEqual([
      expect.objectContaining({ id: "claude-weekly-scoped-fable", title: "Fable only" }),
    ]);
  });

  it("serializes only a fingerprint and reconstructs an inert cache account", () => {
    const original = projectClaudeSwapAccounts({ accounts: [row()] }, { now });
    const serialized = serializeClaudeSwapRetainedUsage(original);
    expect(serialized).not.toContain("limited@example.com");
    expect(JSON.parse(serialized)).toMatchObject([{ opaqueID: "1" }]);
    expect(serialized).toContain(
      claudeSwapAccountFingerprint("limited@example.com", "1") ?? "never",
    );
    const restored = deserializeClaudeSwapRetainedUsage(serialized);
    expect(restored[0]).toMatchObject({
      displayLabel: "",
      snapshot: { identity: { accountId: expect.stringMatching(/^fp:[a-f0-9]{64}$/u) } },
    });
    const reused = projectClaudeSwapAccounts(
      { accounts: [row({ usageStatus: "unavailable", fiveHour: undefined })] },
      { now, previousAccounts: restored },
    );
    expect(reused[0]?.snapshot?.primary?.usedPercent).toBe(100);
  });

  it("matches the upstream SHA-256 slot discriminator and rejects malformed retained records", () => {
    expect(claudeSwapAccountFingerprint(" User@Example.com ", "1")).toBe(
      "25cfb780dcb7aa773b9f64d6a756e21975ef46309c509d083cf15dca16fa9cd3",
    );
    expect(deserializeClaudeSwapRetainedUsage("not-json")).toEqual([]);
    expect(
      deserializeClaudeSwapRetainedUsage(
        JSON.stringify([{ opaqueId: "1", accountFingerprint: "not-a-hash", updatedAt: future }]),
      ),
    ).toEqual([]);
  });
});
