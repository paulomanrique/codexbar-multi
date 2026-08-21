import { describe, expect, it } from "vite-plus/test";
import {
  PLAN_UTILIZATION_MAX_SAMPLES,
  PlanUtilizationHistoryEntry,
  PlanUtilizationSeriesHistory,
  PlanUtilizationSeriesName,
  updatePlanUtilizationEntries,
  updatePlanUtilizationHistories,
} from "../src/index.ts";

const hourStart = new Date("2026-03-17T10:00:00Z");
const minutesAfter = (minutes: number): Date =>
  new Date(hourStart.getTime() + minutes * 60 * 1_000);
const entry = (
  minutes: number,
  usedPercent: number,
  resetsAt?: Date,
): PlanUtilizationHistoryEntry =>
  new PlanUtilizationHistoryEntry({
    capturedAt: minutesAfter(minutes),
    usedPercent,
    ...(resetsAt === undefined ? {} : { resetsAt }),
  });

describe("plan-utilization history recording", () => {
  it("coalesces changed usage within an hour to its peak", () => {
    const first = entry(0, 10);
    const second = entry(25, 35);
    const initial = updatePlanUtilizationEntries([], first);
    expect(initial).toEqual([first]);
    expect(updatePlanUtilizationEntries(initial!, second)).toEqual([second]);
  });

  it("keeps the pre-reset peak and the latest reset segment within an hour", () => {
    const first = entry(5, 82, minutesAfter(30));
    const second = entry(35, 4, minutesAfter(5 * 60));
    const initial = updatePlanUtilizationEntries([], first)!;
    expect(updatePlanUtilizationEntries(initial, second)).toEqual([first, second]);
  });

  it("lets the first known reset boundary replace provisional usage", () => {
    const provisional = entry(5, 82);
    const known = entry(35, 4, minutesAfter(5 * 60));
    const initial = updatePlanUtilizationEntries([], provisional)!;
    expect(updatePlanUtilizationEntries(initial, known)).toEqual([known]);
  });

  it("treats reset boundaries less than two minutes apart as one segment", () => {
    const first = entry(5, 82, minutesAfter(5 * 60));
    const second = entry(35, 4, minutesAfter(5 * 60 + 1.99));
    const updated = updatePlanUtilizationEntries([first], second)!;
    expect(updated).toHaveLength(1);
    expect(updated[0]?.usedPercent).toBe(82);
    expect(updated[0]?.resetsAt?.getTime()).toBe(second.resetsAt?.getTime());
  });

  it("inserts out-of-order samples into their Unix-hour bucket", () => {
    const nextHour = new PlanUtilizationHistoryEntry({
      capturedAt: minutesAfter(65),
      usedPercent: 15,
    });
    const earlierPeak = entry(25, 35);
    const result = updatePlanUtilizationEntries([nextHour], earlierPeak);
    expect(result?.map((sample) => sample.capturedAt.toISOString())).toEqual([
      earlierPeak.capturedAt.toISOString(),
      nextHour.capturedAt.toISOString(),
    ]);
  });

  it("does not report a change for an identical hourly observation", () => {
    const sample = entry(25, 35, minutesAfter(300));
    expect(updatePlanUtilizationEntries([sample], sample)).toBeUndefined();
  });

  it("trims the oldest observation at the two-year hourly limit", () => {
    const base = new Date("2024-01-01T00:00:00Z").getTime();
    const entries = Array.from(
      { length: PLAN_UTILIZATION_MAX_SAMPLES },
      (_, offset) =>
        new PlanUtilizationHistoryEntry({
          capturedAt: new Date(base + offset * 60 * 60 * 1_000),
          usedPercent: offset % 100,
        }),
    );
    const appended = new PlanUtilizationHistoryEntry({
      capturedAt: new Date(base + PLAN_UTILIZATION_MAX_SAMPLES * 60 * 60 * 1_000),
      usedPercent: 50,
    });
    const result = updatePlanUtilizationEntries(entries, appended)!;
    expect(result).toHaveLength(PLAN_UTILIZATION_MAX_SAMPLES);
    expect(result[0]?.capturedAt.getTime()).toBe(entries[1]?.capturedAt.getTime());
    expect(result.at(-1)).toEqual(appended);
  });

  it("folds near-canonical windows and de-duplicates their entries", () => {
    const first = entry(5, 10);
    const second = new PlanUtilizationHistoryEntry({
      capturedAt: minutesAfter(65),
      usedPercent: 20,
    });
    const histories = [
      new PlanUtilizationSeriesHistory({
        name: PlanUtilizationSeriesName.session,
        windowMinutes: 299,
        entries: [first],
      }),
      new PlanUtilizationSeriesHistory({
        name: PlanUtilizationSeriesName.session,
        windowMinutes: 300,
        entries: [first, second],
      }),
    ];
    const updated = updatePlanUtilizationHistories(histories, [
      { name: "weekly", windowMinutes: 10_079, entry: first },
    ]);
    expect(updated).toHaveLength(2);
    expect(updated?.[0]?.name.rawValue).toBe("session");
    expect(updated?.[0]?.windowMinutes).toBe(300);
    expect(updated?.[0]?.entries).toEqual([first, second]);
    expect(updated?.[1]?.name.rawValue).toBe("weekly");
    expect(updated?.[1]?.windowMinutes).toBe(10_080);
  });

  it("returns undefined when all incoming series samples are already canonical", () => {
    const sample = entry(5, 10);
    const history = new PlanUtilizationSeriesHistory({
      name: "session",
      windowMinutes: 300,
      entries: [sample],
    });
    expect(
      updatePlanUtilizationHistories(
        [history],
        [{ name: "session", windowMinutes: 300, entry: sample }],
      ),
    ).toBeUndefined();
  });
});
