import { describe, expect, it } from "vite-plus/test";
import { mapXaiDailySpendSnapshot } from "../src/index.ts";

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
});
