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

  it("skips opt-in and unported dedicated history providers", async () => {
    let calls = 0;
    const coordinator = {
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
    for (const providerId of ["zai", "claude", "antigravity"] as const) {
      await expect(
        Effect.runPromise(
          recordFirstPartyPlanUtilization({ coordinator, providerId, snapshot, capturedAt }),
        ),
      ).resolves.toBe(false);
    }
    expect(calls).toBe(0);
  });
});
