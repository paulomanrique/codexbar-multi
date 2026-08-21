import { describe, expect, it } from "vite-plus/test";
import type { UsageSnapshot } from "@codexbar/contracts";

import { SessionQuotaCoordinator, sessionQuotaWindow } from "../src/index.ts";

const start = new Date("2026-08-21T00:00:00.000Z");
const at = (minutes: number) => new Date(start.getTime() + minutes * 60_000);

function snapshot(input: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    details: [],
    updatedAt: start.toISOString(),
    ...input,
  };
}

const lane = (usedPercent: number, windowMinutes?: number) => ({
  usedPercent,
  ...(windowMinutes === undefined ? {} : { windowMinutes }),
});

describe("session quota coordinator (Swift UsageStore parity)", () => {
  it("uses only real session lanes and preserves provider-specific exclusions", () => {
    expect(sessionQuotaWindow("mimo", snapshot({ primary: lane(100) }))).toBeUndefined();
    expect(sessionQuotaWindow("qoder", snapshot({ primary: lane(100) }))).toBeUndefined();
    expect(sessionQuotaWindow("crof", snapshot({ primary: lane(100) }))).toBeUndefined();
    expect(
      sessionQuotaWindow("crof", snapshot({ primary: lane(100), secondary: lane(10, 24 * 60) })),
    ).toMatchObject({ source: "primary" });
    expect(
      sessionQuotaWindow("openai", snapshot({ primary: lane(1, 6 * 60 + 1) })),
    ).toBeUndefined();
  });

  it("uses Copilot secondary only when a primary session lane is absent", () => {
    const fallback = sessionQuotaWindow("copilot", snapshot({ secondary: lane(20) }));
    expect(fallback).toMatchObject({
      source: "copilot-secondary-fallback",
      window: { usedPercent: 20 },
    });
    expect(
      sessionQuotaWindow("copilot", snapshot({ primary: lane(20), secondary: lane(100) })),
    ).toMatchObject({ source: "primary", window: { usedPercent: 20 } });
  });

  it("uses the most constrained Antigravity 5-hour family lane", () => {
    const fromSummary = sessionQuotaWindow(
      "antigravity",
      snapshot({
        extraRateWindows: [
          {
            id: "antigravity-quota-summary-a",
            title: "A",
            usageKnown: true,
            window: lane(40, 300),
          },
          {
            id: "antigravity-quota-summary-b",
            title: "B",
            usageKnown: true,
            window: lane(80, 300),
          },
          {
            id: "antigravity-quota-summary-weekly",
            title: "W",
            usageKnown: true,
            window: lane(100, 10_080),
          },
        ],
      }),
    );
    expect(fromSummary).toMatchObject({
      source: "antigravity-quota-summary",
      window: { usedPercent: 80 },
    });
    expect(
      sessionQuotaWindow("antigravity", snapshot({ primary: lane(30), secondary: lane(90, 300) })),
    ).toMatchObject({ source: "antigravity-legacy", window: { usedPercent: 90 } });
  });

  it("keeps transition state in memory and posts only non-sensitive events", () => {
    const coordinator = new SessionQuotaCoordinator();
    expect(
      coordinator.observe({
        provider: "claude",
        snapshot: snapshot({ primary: lane(10) }),
        now: start,
      }),
    ).toMatchObject({ disposition: "evaluated" });
    const depleted = coordinator.observe({
      provider: "claude",
      snapshot: snapshot({ primary: lane(100), updatedAt: at(1).toISOString() }),
      now: at(1),
    });
    expect(depleted.notification).toEqual({
      id: "session-claude-depleted",
      provider: "claude",
      transition: "depleted",
    });
    expect(JSON.stringify(depleted.notification)).not.toContain("identity");
  });

  it("does not treat synthetic placeholders as a restore or replace a real baseline", () => {
    const coordinator = new SessionQuotaCoordinator();
    coordinator.observe({
      provider: "claude",
      snapshot: snapshot({ primary: lane(100) }),
      now: start,
    });
    expect(
      coordinator.observe({
        provider: "claude",
        snapshot: snapshot({
          primary: { ...lane(0), isSyntheticPlaceholder: true },
          updatedAt: at(1).toISOString(),
        }),
        now: at(1),
      }).disposition,
    ).toBe("synthetic-placeholder");
    expect(
      coordinator.observe({
        provider: "claude",
        snapshot: snapshot({ primary: lane(50), updatedAt: at(2).toISOString() }),
        now: at(2),
      }).notification,
    ).toMatchObject({ transition: "restored" });
  });

  it("resets the Copilot baseline when moving between fallback and primary lanes", () => {
    const coordinator = new SessionQuotaCoordinator();
    coordinator.observe({
      provider: "copilot",
      snapshot: snapshot({ secondary: lane(100) }),
      now: start,
    });
    const primary = coordinator.observe({
      provider: "copilot",
      snapshot: snapshot({
        primary: lane(0),
        secondary: lane(100),
        updatedAt: at(1).toISOString(),
      }),
      now: at(1),
    });
    expect(primary.evaluation?.outcome).toBe("baseline-changed");
    expect(primary.notification).toBeUndefined();
  });

  it("fails closed for Codex until a securely-derived owner key exists", () => {
    const coordinator = new SessionQuotaCoordinator();
    const missingOwner = coordinator.observe({
      provider: "codex",
      snapshot: snapshot({ primary: lane(100) }),
      now: start,
    });
    expect(missingOwner).toEqual({ disposition: "codex-owner-unavailable" });
    // The same sample cannot establish the required fresh, owner-scoped baseline.
    expect(
      coordinator.observe({
        provider: "codex",
        snapshot: snapshot({ primary: lane(100) }),
        codexOwnerKey: "opaque-owner-a",
        now: start,
      }).disposition,
    ).toBe("stale-codex-baseline");
    expect(
      coordinator.observe({
        provider: "codex",
        snapshot: snapshot({ primary: lane(100), updatedAt: at(1).toISOString() }),
        codexOwnerKey: "opaque-owner-a",
        now: at(1),
      }).evaluation?.outcome,
    ).toBe("baseline-changed");
  });

  it("honors the disabled setting while still retaining ordinary-provider baselines", () => {
    const coordinator = new SessionQuotaCoordinator();
    const result = coordinator.observe({
      provider: "claude",
      snapshot: snapshot({ primary: lane(100) }),
      notificationsEnabled: false,
      now: start,
    });
    expect(result.evaluation?.outcome).toBe("none");
    expect(result.notification).toBeUndefined();
  });

  it("keeps the Codex disabled preference distinct from missing ownership", () => {
    const result = new SessionQuotaCoordinator().observe({
      provider: "codex",
      snapshot: snapshot({ primary: lane(100) }),
      notificationsEnabled: false,
      now: start,
    });
    expect(result).toEqual({ disposition: "notifications-disabled" });
  });

  it("fails closed for an invalid host evaluation time", () => {
    expect(
      new SessionQuotaCoordinator().observe({
        provider: "claude",
        snapshot: snapshot({ primary: lane(100) }),
        now: new Date(Number.NaN),
      }),
    ).toEqual({ disposition: "invalid-observation" });
  });
});
