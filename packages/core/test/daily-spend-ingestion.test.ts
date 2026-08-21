import { describe, expect, it } from "vite-plus/test";
import { mapGrokLocalSessionTokenActivity, mapXaiDailySpendSnapshot } from "../src/index.ts";

const snapshot = (
  points: readonly { readonly label: string; readonly value: number }[],
  dataConfidence: "exact" | "estimated" | "percentOnly" | "unknown" = "exact",
  updatedAt = "2026-08-20T23:59:59.000-07:00",
) => ({
  details: [
    {
      title: "Billing summary",
      rows: [{ label: "Prepaid balance", value: "$100.00" }],
      chart: { kind: "bars" as const, title: "Daily spend", unit: "USD", points },
    },
  ],
  updatedAt,
  dataConfidence,
});

describe("xAI daily spend ingestion", () => {
  it("maps only valid non-negative UTC-day spend and never turns prepaid balance into spend", () => {
    const mapped = mapXaiDailySpendSnapshot(
      snapshot([
        { label: "2026-08-19", value: 0.5 },
        { label: "2026-08-20", value: 1.25 },
        { label: "2026-02-30", value: 9 },
        { label: "2026-08-21", value: -1 },
        { label: "not-a-day", value: 8 },
      ]),
    );
    expect(mapped).toMatchObject({ availability: "available", coverage: "exact" });
    // updatedAt is Aug 21 in UTC, regardless of its -07:00 session-local date.
    expect(mapped.until).toBe(Date.parse("2026-08-21T00:00:00.000Z"));
    expect(mapped.records).toEqual([
      expect.objectContaining({ recordedAt: Date.parse("2026-08-19T00:00:00.000Z"), costUsd: 0.5 }),
      expect.objectContaining({
        recordedAt: Date.parse("2026-08-20T00:00:00.000Z"),
        costUsd: 1.25,
      }),
    ]);
  });

  it("keeps estimated coverage, distinguishes an empty chart, and leaves missing analytics unavailable", () => {
    expect(
      mapXaiDailySpendSnapshot(snapshot([{ label: "2026-08-20", value: 1 }], "estimated")),
    ).toMatchObject({ availability: "available", coverage: "estimated" });
    expect(
      mapXaiDailySpendSnapshot(snapshot([{ label: "2026-08-20", value: 1 }], "percentOnly")),
    ).toMatchObject({ availability: "available", coverage: "estimated" });
    expect(
      mapXaiDailySpendSnapshot(snapshot([{ label: "2026-08-20", value: 1 }], "unknown")),
    ).toMatchObject({ availability: "available", coverage: "estimated" });
    expect(mapXaiDailySpendSnapshot(snapshot([]))).toMatchObject({
      availability: "available",
      coverage: "exact",
      records: [],
    });
    expect(
      mapXaiDailySpendSnapshot({
        details: [
          { title: "Billing summary", rows: [{ label: "Prepaid balance", value: "$100.00" }] },
        ],
        updatedAt: "2026-08-20T00:00:00.000Z",
        dataConfidence: "exact",
      }),
    ).toMatchObject({ availability: "unavailable", records: [] });
  });

  it("keeps xAI on a fixed 30-day UTC feed and never uses the newest point as today", () => {
    const mapped = mapXaiDailySpendSnapshot(
      snapshot(
        [
          { label: "2026-08-19", value: 0.5 },
          { label: "2026-08-20", value: 1.26 },
          { label: "2026-08-21", value: 9.99 },
        ],
        "estimated",
        "2026-08-21T01:30:00.000+03:00",
      ),
    );
    expect(mapped.until).toBe(Date.parse("2026-08-20T00:00:00.000Z"));
    expect(mapped.since).toBe(Date.parse("2026-07-22T00:00:00.000Z"));
    expect(mapped).toMatchObject({
      availability: "available",
      coverage: "estimated",
      records: [
        { recordedAt: Date.parse("2026-08-19T00:00:00.000Z"), costUsd: 0.5 },
        { recordedAt: Date.parse("2026-08-20T00:00:00.000Z"), costUsd: 1.26 },
      ],
    });
  });
});

describe("Grok local-session token ingestion", () => {
  it("uses host-provided local today instead of reinterpreting it as a UTC clock", () => {
    const mapped = mapGrokLocalSessionTokenActivity({
      // This is deliberately one day behind the scanner's UTC instant in the
      // fixture: Grok buckets are Calendar.current / host-local days.
      today: "2026-08-19",
      truncated: false,
      daily: [
        { date: "2026-08-18", totalTokens: 100, sessionCount: 1 },
        { date: "2026-08-19", totalTokens: 250, sessionCount: 1 },
      ],
    });
    expect(mapped).toMatchObject({
      availability: "available",
      coverage: "exact",
      until: Date.parse("2026-08-19T00:00:00.000Z"),
      records: [
        {
          providerId: "grok",
          recordedAt: Date.parse("2026-08-18T00:00:00.000Z"),
          inputTokens: 100,
          outputTokens: 0,
          costUsd: 0,
        },
        {
          providerId: "grok",
          recordedAt: Date.parse("2026-08-19T00:00:00.000Z"),
          inputTokens: 250,
          outputTokens: 0,
          costUsd: 0,
        },
      ],
    });
  });

  it("does not publish a zero-token local directory and fails closed on malformed host buckets", () => {
    expect(
      mapGrokLocalSessionTokenActivity({ today: "2026-08-20", truncated: false, daily: [] }),
    ).toMatchObject({ availability: "unavailable", records: [] });
    expect(() =>
      mapGrokLocalSessionTokenActivity({
        today: "2026-08-20",
        truncated: false,
        daily: [{ date: "not-a-day", totalTokens: 1, sessionCount: 1 }],
      }),
    ).toThrow("Grok local-session day is invalid");
    expect(
      mapGrokLocalSessionTokenActivity({
        today: "2026-08-20",
        truncated: true,
        daily: [{ date: "2026-08-20", totalTokens: 1, sessionCount: 1 }],
      }).coverage,
    ).toBe("estimated");
  });
});
