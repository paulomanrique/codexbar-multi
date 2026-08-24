import type { ProviderId, UsageSnapshot } from "@codexbar/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { recordFirstPartyPlanUtilization } from "../src/index.ts";

const capturedAt = new Date("2026-08-21T12:35:00.000Z");
const snapshot: UsageSnapshot = {
  details: [],
  updatedAt: "2026-08-21T12:34:56.000Z",
  primary: { usedPercent: 10, windowMinutes: 300 },
  secondary: { usedPercent: 20, windowMinutes: 10_080 },
};

describe("first-party plan-utilization recording policy", () => {
  it("routes Codex to canonical owner recording", async () => {
    const calls: Array<{ snapshot: UsageSnapshot; capturedAt: Date }> = [];
    await expect(
      Effect.runPromise(
        recordFirstPartyPlanUtilization({
          coordinator: {
            recordAntigravity: () => Effect.succeed(false),
            recordClaudeIdentity: () => Effect.succeed(false),
            recordCodex: (input) =>
              Effect.sync(() => {
                calls.push(input);
                return true;
              }),
            recordGenericSessionEquivalent: () => Effect.succeed(false),
          },
          providerId: "codex",
          snapshot,
          capturedAt,
        }),
      ),
    ).resolves.toBe(true);
    expect(calls).toEqual([{ snapshot, capturedAt }]);
  });

  it("routes OpenCode Go to generic session-equivalent recording", async () => {
    const calls: Array<{ providerId: ProviderId; snapshot: UsageSnapshot; capturedAt: Date }> = [];
    await expect(
      Effect.runPromise(
        recordFirstPartyPlanUtilization({
          coordinator: {
            recordAntigravity: () => Effect.succeed(false),
            recordClaudeIdentity: () => Effect.succeed(false),
            recordCodex: () => Effect.succeed(false),
            recordGenericSessionEquivalent: (input) =>
              Effect.sync(() => {
                calls.push(input);
                return true;
              }),
          },
          providerId: "opencodego",
          snapshot,
          capturedAt,
        }),
      ),
    ).resolves.toBe(true);
    expect(calls).toEqual([{ providerId: "opencodego", snapshot, capturedAt }]);
  });

  it("routes Claude to identity-owned recording", async () => {
    const calls: Array<{ snapshot: UsageSnapshot; capturedAt: Date }> = [];
    await expect(
      Effect.runPromise(
        recordFirstPartyPlanUtilization({
          coordinator: {
            recordAntigravity: () => Effect.succeed(false),
            recordClaudeIdentity: (input) =>
              Effect.sync(() => {
                calls.push(input);
                return true;
              }),
            recordCodex: () => Effect.succeed(false),
            recordGenericSessionEquivalent: () => Effect.succeed(false),
          },
          providerId: "claude",
          snapshot,
          capturedAt,
        }),
      ),
    ).resolves.toBe(true);
    expect(calls).toEqual([{ snapshot, capturedAt }]);
  });

  it("routes Claude OAuth only to opaque owner recording and fails closed without it", async () => {
    const oauthCalls: unknown[] = [];
    let identityCalls = 0;
    const coordinator = {
      recordAntigravity: () => Effect.succeed(false),
      recordClaudeIdentity: () =>
        Effect.sync(() => {
          identityCalls += 1;
          return true;
        }),
      recordClaudeOAuth: (input: unknown) =>
        Effect.sync(() => {
          oauthCalls.push(input);
          return true;
        }),
      recordCodex: () => Effect.succeed(false),
      recordGenericSessionEquivalent: () => Effect.succeed(false),
    };
    await expect(
      Effect.runPromise(
        recordFirstPartyPlanUtilization({
          coordinator,
          providerId: "claude",
          strategyId: "claude.oauth",
          claudeOAuthHistoryOwnerIdentifier: "a".repeat(64),
          snapshot,
          capturedAt,
        }),
      ),
    ).resolves.toBe(true);
    expect(oauthCalls).toEqual([{ snapshot, capturedAt, historyOwnerIdentifier: "a".repeat(64) }]);
    expect(identityCalls).toBe(0);

    const withoutOAuthRecorder = {
      recordAntigravity: coordinator.recordAntigravity,
      recordClaudeIdentity: coordinator.recordClaudeIdentity,
      recordCodex: coordinator.recordCodex,
      recordGenericSessionEquivalent: coordinator.recordGenericSessionEquivalent,
    };
    await expect(
      Effect.runPromise(
        recordFirstPartyPlanUtilization({
          coordinator: withoutOAuthRecorder,
          providerId: "claude",
          strategyId: "claude.oauth",
          snapshot,
          capturedAt,
        }),
      ),
    ).resolves.toBe(false);
    expect(identityCalls).toBe(0);
  });

  it("routes selected non-OAuth Claude to token-account recording before identity", async () => {
    const selectedTokenAccountKey = "a".repeat(64);
    const selectedCalls: unknown[] = [];
    let identityCalls = 0;
    await expect(
      Effect.runPromise(
        recordFirstPartyPlanUtilization({
          coordinator: {
            recordAntigravity: () => Effect.succeed(false),
            recordClaudeIdentity: () =>
              Effect.sync(() => {
                identityCalls += 1;
                return true;
              }),
            recordClaudeSelectedTokenAccount: (input: unknown) =>
              Effect.sync(() => {
                selectedCalls.push(input);
                return true;
              }),
            recordCodex: () => Effect.succeed(false),
            recordGenericSessionEquivalent: () => Effect.succeed(false),
          },
          providerId: "claude",
          strategyId: "claude.web",
          claudeSelectedTokenAccountKey: selectedTokenAccountKey,
          snapshot,
          capturedAt,
        }),
      ),
    ).resolves.toBe(true);
    expect(selectedCalls).toEqual([
      {
        snapshot,
        capturedAt,
        accountKey: selectedTokenAccountKey,
      },
    ]);
    expect(identityCalls).toBe(0);
  });

  it("skips opt-in and still-unported dedicated history providers", async () => {
    let calls = 0;
    const coordinator = {
      recordAntigravity: () =>
        Effect.sync(() => {
          calls += 1;
          return true;
        }),
      recordClaudeIdentity: () =>
        Effect.sync(() => {
          calls += 1;
          return true;
        }),
      recordCodex: () =>
        Effect.sync(() => {
          calls += 1;
          return true;
        }),
      recordGenericSessionEquivalent: () =>
        Effect.sync(() => {
          calls += 1;
          return true;
        }),
    };
    for (const providerId of ["zai"] as const) {
      await expect(
        Effect.runPromise(
          recordFirstPartyPlanUtilization({ coordinator, providerId, snapshot, capturedAt }),
        ),
      ).resolves.toBe(false);
    }
    expect(calls).toBe(0);
  });

  it("routes Antigravity to its dedicated family/account recording", async () => {
    const calls: Array<{ snapshot: UsageSnapshot; capturedAt: Date }> = [];
    await expect(
      Effect.runPromise(
        recordFirstPartyPlanUtilization({
          coordinator: {
            recordAntigravity: (input) =>
              Effect.sync(() => {
                calls.push(input);
                return true;
              }),
            recordClaudeIdentity: () => Effect.succeed(false),
            recordCodex: () => Effect.succeed(false),
            recordGenericSessionEquivalent: () => Effect.succeed(false),
          },
          providerId: "antigravity",
          snapshot,
          capturedAt,
        }),
      ),
    ).resolves.toBe(true);
    expect(calls).toEqual([{ snapshot, capturedAt }]);
  });
});
