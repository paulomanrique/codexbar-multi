import type { NamedRateWindow, RateWindow, UsageSnapshot } from "@codexbar/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  extractPlanUtilizationSeriesSamples,
  genericSessionEquivalentWindowComponents,
  parseSessionEquivalentPairIdentity,
  PlanUtilizationHistoryEntry,
  PlanUtilizationSeriesHistory,
  PlanUtilizationSeriesName,
  reconcileGenericSessionEquivalentHistory,
  resolveGenericSessionEquivalentWindowPair,
} from "../src/index.ts";

const capturedAt = new Date("2026-08-21T12:34:56Z");
const window = (
  usedPercent: number,
  windowMinutes: number,
  overrides: Partial<RateWindow> = {},
): RateWindow => ({ usedPercent, windowMinutes, ...overrides });
const named = (id: string, rateWindow: RateWindow, usageKnown?: boolean): NamedRateWindow => ({
  id,
  title: id,
  window: rateWindow,
  ...(usageKnown === undefined ? {} : { usageKnown }),
});
const snapshot = (overrides: Partial<UsageSnapshot> = {}): UsageSnapshot => ({
  details: [],
  updatedAt: capturedAt.toISOString(),
  ...overrides,
});
const projection = (
  providerId: Parameters<typeof extractPlanUtilizationSeriesSamples>[0]["providerId"],
  value: UsageSnapshot,
  forSessionEquivalents = false,
) =>
  extractPlanUtilizationSeriesSamples({
    providerId,
    snapshot: value,
    capturedAt,
    ...(forSessionEquivalents ? { forSessionEquivalents: true } : {}),
  });
const sampleName = (value: string | PlanUtilizationSeriesName): string =>
  value instanceof PlanUtilizationSeriesName ? value.rawValue : value;

describe("plan-utilization sample projection", () => {
  it("classifies Codex lanes by semantic duration rather than slot", () => {
    const samples = projection(
      "codex",
      snapshot({
        primary: window(55, 43_200),
        secondary: window(5, 10_080),
      }),
    );
    expect(samples.map((sample) => [sampleName(sample.name), sample.windowMinutes])).toEqual([
      ["weekly", 10_080],
      ["monthly", 43_200],
    ]);
  });

  it("preserves Claude and OpenCode Go provider-specific lane roles", () => {
    const claude = projection(
      "claude",
      snapshot({
        primary: window(10, 300),
        secondary: window(20, 10_080),
        tertiary: window(30, 10_080),
      }),
    );
    expect(claude.map((sample) => sampleName(sample.name))).toEqual(["session", "opus", "weekly"]);

    const opencodego = projection(
      "opencodego",
      snapshot({
        primary: window(10, 300),
        secondary: window(20, 10_080),
        tertiary: window(30, 43_200),
      }),
    );
    expect(opencodego.map((sample) => sampleName(sample.name))).toEqual([
      "session",
      "weekly",
      "monthly",
    ]);
  });

  it("resolves matching named 5h/weekly families with Swift's UTF-8 identity framing", () => {
    const value = snapshot({
      extraRateWindows: [
        named("café-session", window(12, 300)),
        named("café-weekly", window(48, 10_080)),
      ],
    });
    expect(resolveGenericSessionEquivalentWindowPair(value)).toEqual({
      kind: "resolved",
      session: window(12, 300),
      weekly: window(48, 10_080),
      weeklyWindowId: "café-weekly",
      historyIdentity: "19#named:café-session18#named:café-weekly",
    });
    expect(projection("zai", value).map((sample) => sampleName(sample.name))).toEqual([
      "session",
      "weekly",
    ]);
  });

  it("marks mixed or duplicated candidates ambiguous and exposes only resolved components", () => {
    const value = snapshot({
      extraRateWindows: [
        named("one-session", window(10, 300)),
        named("two-session", window(20, 300)),
        named("one-weekly", window(30, 10_080)),
      ],
    });
    expect(resolveGenericSessionEquivalentWindowPair(value)).toEqual({ kind: "ambiguous" });
    expect(genericSessionEquivalentWindowComponents(value).session).toBeUndefined();
    expect(projection("zai", value).map((sample) => sampleName(sample.name))).toEqual(["weekly"]);
  });

  it("treats omitted usageKnown as true and explicit false as incomplete", () => {
    const available = snapshot({
      extraRateWindows: [
        named("alpha-5h", window(10, 300)),
        named("alpha-weekly", window(20, 10_080)),
      ],
    });
    expect(resolveGenericSessionEquivalentWindowPair(available).kind).toBe("resolved");
    const unavailable = snapshot({
      extraRateWindows: [
        named("alpha-5h", window(10, 300), false),
        named("alpha-weekly", window(20, 10_080)),
      ],
    });
    expect(resolveGenericSessionEquivalentWindowPair(unavailable)).toEqual({ kind: "incomplete" });
  });

  it("uses the monthly sentinel exclusively for MiMo and StepFun", () => {
    const value = snapshot({
      primary: window(70, 43_200),
      secondary: window(20, 10_080),
    });
    for (const providerId of ["mimo", "stepfun"] as const) {
      expect(projection(providerId, value).map((sample) => sampleName(sample.name))).toEqual([
        "monthly",
      ]);
    }
  });

  it("projects only the complete Gemini Antigravity pair for session equivalents", () => {
    const value = snapshot({
      extraRateWindows: [
        named("antigravity-quota-summary-gemini-5h", window(15, 300)),
        named("antigravity-quota-summary-gemini-weekly", window(60, 10_080)),
        named("antigravity-quota-summary-claude-weekly", window(90, 10_080)),
      ],
    });
    expect(projection("antigravity", value).map((sample) => sample.entry.usedPercent)).toEqual([
      90,
    ]);
    expect(
      projection("antigravity", value, true).map((sample) => [
        sampleName(sample.name),
        sample.entry.usedPercent,
      ]),
    ).toEqual([
      ["session", 15],
      ["weekly", 60],
    ]);
  });

  it("drops synthetic/invalid-duration windows and clamps persisted percentages", () => {
    const samples = projection(
      "claude",
      snapshot({
        primary: window(150, 300),
        secondary: window(20, 10_080, { isSyntheticPlaceholder: true }),
        tertiary: window(30, 0),
      }),
    );
    expect(samples).toHaveLength(1);
    expect(samples[0]?.entry.usedPercent).toBe(100);
    expect(samples[0]?.entry.capturedAt).toEqual(capturedAt);
  });

  it("parses length-framed identities and rejects malformed UTF-8 boundaries or tails", () => {
    expect(parseSessionEquivalentPairIdentity("19#named:café-session18#named:café-weekly")).toEqual(
      {
        session: "named:café-session",
        weekly: "named:café-weekly",
      },
    );
    for (const malformed of [
      "named:a1#b",
      "999999999999999999999#a1#b",
      "4#café1#b",
      "1#a1#b-tail",
    ]) {
      expect(parseSessionEquivalentPairIdentity(malformed)).toBeUndefined();
    }
  });

  it("removes only a generic lane whose resolved source identity changed", () => {
    const previousSnapshot = snapshot({
      primary: window(10, 300),
      secondary: window(20, 10_080),
    });
    const currentSnapshot = snapshot({
      secondary: window(30, 10_080),
      tertiary: window(40, 300),
    });
    const previous = resolveGenericSessionEquivalentWindowPair(previousSnapshot);
    expect(previous.kind).toBe("resolved");
    const histories = [
      new PlanUtilizationSeriesHistory({
        name: "session",
        windowMinutes: 300,
        entries: [new PlanUtilizationHistoryEntry({ capturedAt, usedPercent: 10 })],
      }),
      new PlanUtilizationSeriesHistory({
        name: "weekly",
        windowMinutes: 10_080,
        entries: [new PlanUtilizationHistoryEntry({ capturedAt, usedPercent: 20 })],
      }),
      new PlanUtilizationSeriesHistory({
        name: "monthly",
        windowMinutes: 43_200,
        entries: [new PlanUtilizationHistoryEntry({ capturedAt, usedPercent: 30 })],
      }),
    ];
    const reconciled = reconcileGenericSessionEquivalentHistory({
      ...(previous.kind === "resolved" ? { previousIdentity: previous.historyIdentity } : {}),
      snapshot: currentSnapshot,
      histories,
      samples: projection("zai", currentSnapshot),
    });
    expect(reconciled.histories.map((history) => history.name.rawValue)).toEqual([
      "weekly",
      "monthly",
    ]);
    expect(reconciled.samples.map((sample) => sampleName(sample.name))).toEqual([
      "session",
      "weekly",
    ]);
  });

  it("admits only the stable weekly lane while a generic pair is incomplete", () => {
    const currentSnapshot = snapshot({ secondary: window(20, 10_080) });
    const samples = [
      {
        name: PlanUtilizationSeriesName.session,
        windowMinutes: 300,
        entry: new PlanUtilizationHistoryEntry({ capturedAt, usedPercent: 10 }),
      },
      ...projection("zai", currentSnapshot),
    ];
    const reconciled = reconcileGenericSessionEquivalentHistory({
      snapshot: currentSnapshot,
      histories: [],
      samples,
    });
    expect(reconciled.historyIdentity).toBe("14#__unresolved__18#standard:secondary");
    expect(reconciled.samples.map((sample) => sampleName(sample.name))).toEqual(["weekly"]);
  });

  it("drops ambiguous session samples and retains weekly only for the same source", () => {
    const previousSnapshot = snapshot({
      extraRateWindows: [
        named("alpha-session", window(10, 300)),
        named("alpha-weekly", window(20, 10_080)),
      ],
    });
    const previous = resolveGenericSessionEquivalentWindowPair(previousSnapshot);
    expect(previous.kind).toBe("resolved");
    const ambiguous = snapshot({
      extraRateWindows: [
        named("alpha-session", window(10, 300)),
        named("other-session", window(30, 300)),
        named("alpha-weekly", window(40, 10_080)),
      ],
    });
    const candidates = [
      {
        name: PlanUtilizationSeriesName.session,
        windowMinutes: 300,
        entry: new PlanUtilizationHistoryEntry({ capturedAt, usedPercent: 30 }),
      },
      ...projection("zai", ambiguous),
    ];
    const retained = reconcileGenericSessionEquivalentHistory({
      ...(previous.kind === "resolved" ? { previousIdentity: previous.historyIdentity } : {}),
      snapshot: ambiguous,
      histories: [],
      samples: candidates,
    });
    expect(retained.samples.map((sample) => sampleName(sample.name))).toEqual(["weekly"]);

    const mismatched = reconcileGenericSessionEquivalentHistory({
      previousIdentity: "13#named:beta-5h17#named:beta-weekly",
      snapshot: ambiguous,
      histories: [],
      samples: candidates,
    });
    expect(mismatched.samples).toEqual([]);
  });
});
