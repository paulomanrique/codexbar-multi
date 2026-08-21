import type { ProviderId, UsageSnapshot } from "@codexbar/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { InfrastructureError } from "@codexbar/core";
import { recordDesktopPlanUtilization } from "../src/main/plan-utilization-history.js";

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

  it("does not admit opt-in or dedicated-history providers", async () => {
    let calls = 0;
    const coordinator = {
      recordGenericSessionEquivalent: () =>
        Effect.sync(() => {
          calls += 1;
          return true;
        }),
    };
    for (const providerId of ["zai", "codex", "claude", "antigravity"] as const) {
      await expect(
        recordDesktopPlanUtilization({ coordinator, providerId, snapshot, capturedAt }),
      ).resolves.toBe(false);
    }
    expect(calls).toBe(0);
  });

  it("contains storage failures after a successful provider refresh", async () => {
    await expect(
      recordDesktopPlanUtilization({
        coordinator: {
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
