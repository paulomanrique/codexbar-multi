import { readFile } from "node:fs/promises";
import type { ProviderId, UsageSnapshot } from "@codexbar/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { InfrastructureError, PlanUtilizationHistoryCoordinator } from "@codexbar/core";
import {
  recordDesktopPlanUtilization,
  type RecordDesktopPlanUtilizationInput,
} from "../src/main/plan-utilization-history.js";

const snapshot: UsageSnapshot = {
  details: [],
  updatedAt: "2026-08-21T12:34:56.000Z",
  primary: { usedPercent: 10, windowMinutes: 300 },
  secondary: { usedPercent: 20, windowMinutes: 10_080 },
};
const capturedAt = new Date("2026-08-21T12:35:00.000Z");

describe("desktop plan-utilization history", () => {
  it("records the always-tracked OpenCode Go snapshot", async () => {
    const calls: Array<{ providerId: ProviderId; snapshot: UsageSnapshot; capturedAt: Date }> = [];
    await expect(
      recordDesktopPlanUtilization({
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
    ).resolves.toBe(true);
    expect(calls).toEqual([{ providerId: "opencodego", snapshot, capturedAt }]);
  });

  it("records Codex through canonical ownership", async () => {
    const calls: Array<{ snapshot: UsageSnapshot; capturedAt: Date }> = [];
    await expect(
      recordDesktopPlanUtilization({
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
    ).resolves.toBe(true);
    expect(calls).toEqual([{ snapshot, capturedAt }]);
  });

  it("records Claude through identity ownership", async () => {
    const calls: Array<{ snapshot: UsageSnapshot; capturedAt: Date }> = [];
    await expect(
      recordDesktopPlanUtilization({
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
    ).resolves.toBe(true);
    expect(calls).toEqual([{ snapshot, capturedAt }]);
  });

  it("routes the winning Claude OAuth strategy only through opaque ownership", async () => {
    const calls: unknown[] = [];
    let identityCalls = 0;
    const coordinator: RecordDesktopPlanUtilizationInput["coordinator"] = {
      recordAntigravity: () => Effect.succeed(false),
      recordClaudeIdentity: () =>
        Effect.sync(() => {
          identityCalls += 1;
          return true;
        }),
      recordClaudeOAuth: (input) =>
        Effect.sync(() => {
          calls.push(input);
          return true;
        }),
      recordCodex: () => Effect.succeed(false),
      recordGenericSessionEquivalent: () => Effect.succeed(false),
    };
    const owner = "a".repeat(64);
    await expect(
      recordDesktopPlanUtilization({
        coordinator,
        providerId: "claude",
        strategyId: "claude.oauth",
        claudeOAuthHistoryOwnerIdentifier: owner,
        snapshot,
        capturedAt,
      }),
    ).resolves.toBe(true);
    expect(calls).toEqual([{ snapshot, capturedAt, historyOwnerIdentifier: owner }]);
    expect(identityCalls).toBe(0);
  });

  it("fails closed for ownerless Claude OAuth without loading identity history", async () => {
    let loads = 0;
    let saves = 0;
    const coordinator = new PlanUtilizationHistoryCoordinator({
      load: Effect.sync(() => {
        loads += 1;
        return {};
      }),
      save: () =>
        Effect.sync(() => {
          saves += 1;
        }),
    });
    await expect(
      recordDesktopPlanUtilization({
        coordinator,
        providerId: "claude",
        strategyId: "claude.oauth",
        snapshot,
        capturedAt,
      }),
    ).resolves.toBe(false);
    expect(loads).toBe(0);
    expect(saves).toBe(0);
  });

  it("routes selected Claude web history through token-account ownership", async () => {
    const selectedTokenAccountKey = "a".repeat(64);
    const calls: unknown[] = [];
    let identityCalls = 0;
    await expect(
      recordDesktopPlanUtilization({
        coordinator: {
          recordAntigravity: () => Effect.succeed(false),
          recordClaudeIdentity: () =>
            Effect.sync(() => {
              identityCalls += 1;
              return true;
            }),
          recordClaudeSelectedTokenAccount: (input) =>
            Effect.sync(() => {
              calls.push(input);
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
    ).resolves.toBe(true);
    expect(calls).toEqual([{ snapshot, capturedAt, accountKey: selectedTokenAccountKey }]);
    expect(identityCalls).toBe(0);
  });

  it("captures Claude OAuth ownership around both desktop refresh paths", async () => {
    const source = await readFile(new URL("../src/main/index.ts", import.meta.url), "utf8");
    expect(source.match(/activeClaudeOAuthHistoryOwnerCapture\(\)\.captureFetch/g)).toHaveLength(2);
    expect(
      source.match(/activeClaudeOAuthHistoryOwnerCapture\(\)\.consumeHistoryBinding/g),
    ).toHaveLength(2);
    expect(source).toContain("strategyId: outcome.strategyId");
    expect(source).toContain("claudeOAuthHistoryOwnerIdentifier");
    expect(source).toContain("claudeSelectedTokenAccountKey");
  });

  it("does not admit opt-in history providers", async () => {
    let antigravityCalls = 0;
    let claudeCalls = 0;
    let codexCalls = 0;
    let genericCalls = 0;
    const coordinator = {
      recordAntigravity: () =>
        Effect.sync(() => {
          antigravityCalls += 1;
          return true;
        }),
      recordClaudeIdentity: () =>
        Effect.sync(() => {
          claudeCalls += 1;
          return true;
        }),
      recordCodex: () =>
        Effect.sync(() => {
          codexCalls += 1;
          return true;
        }),
      recordGenericSessionEquivalent: () =>
        Effect.sync(() => {
          genericCalls += 1;
          return true;
        }),
    };
    for (const providerId of ["zai"] as const) {
      await expect(
        recordDesktopPlanUtilization({ coordinator, providerId, snapshot, capturedAt }),
      ).resolves.toBe(false);
    }
    expect(antigravityCalls).toBe(0);
    expect(claudeCalls).toBe(0);
    expect(codexCalls).toBe(0);
    expect(genericCalls).toBe(0);
  });

  it("contains storage failures after a successful provider refresh", async () => {
    await expect(
      recordDesktopPlanUtilization({
        coordinator: {
          recordAntigravity: () => Effect.succeed(false),
          recordClaudeIdentity: () => Effect.succeed(false),
          recordCodex: () => Effect.succeed(false),
          recordGenericSessionEquivalent: () =>
            Effect.fail(new InfrastructureError("save plan history", "failed")),
        },
        providerId: "opencodego",
        snapshot,
        capturedAt,
      }),
    ).resolves.toBe(false);
  });
});
