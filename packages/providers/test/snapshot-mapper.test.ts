import { describe, expect, it } from "vite-plus/test";
import {
  InvalidProviderSnapshot,
  mapFirstPartyProviderSnapshot,
  mapProviderSnapshot,
} from "../src/snapshot-mapper.ts";

const now = new Date("2026-08-19T12:00:00Z");

describe("upstream plugin snapshot mapper", () => {
  it("maps upstream aliases into the canonical public DTO", () => {
    expect(
      mapProviderSnapshot(
        {
          primary: { usedPercent: 120, windowMinutes: 300 },
          extraWindows: [{ id: "weekly", title: "Weekly", usedPercent: -5, windowMinutes: 10_080 }],
          cost: { used: 3.5, currency: "USD", balance: 9 },
          identity: { email: " user@example.com ", organization: "Acme", accountID: "a1" },
          details: [{ title: "Plan", rows: [{ label: "Tier", value: "Pro" }] }],
          dataConfidence: "exact",
        },
        "openai",
        now,
      ),
    ).toMatchObject({
      primary: { usedPercent: 100, windowMinutes: 300 },
      extraRateWindows: [{ id: "weekly", window: { usedPercent: 0 } }],
      providerCost: { used: 3.5, limit: 0, currencyCode: "USD", balance: 9 },
      identity: {
        providerId: "openai",
        accountEmail: "user@example.com",
        accountOrganization: "Acme",
        accountId: "a1",
      },
      details: [{ rows: [{ label: "Tier", value: "Pro" }] }],
      updatedAt: "2026-08-19T12:00:00.000Z",
      dataConfidence: "exact",
    });
  });

  it("fails closed for empty, oversized, or structurally invalid snapshots", () => {
    expect(() => mapProviderSnapshot({ identity: {} }, "openai", now)).toThrow(
      InvalidProviderSnapshot,
    );
    expect(() =>
      mapProviderSnapshot({ primary: { usedPercent: Number.NaN } }, "openai", now),
    ).toThrow("primary.usedPercent must be a finite number");
    expect(() =>
      mapProviderSnapshot({ extraWindows: Array.from({ length: 65 }, () => ({})) }, "openai", now),
    ).toThrow("extraWindows exceeds 64 entries");
  });

  it("allows only an explicitly marked empty first-party snapshot", () => {
    expect(
      mapFirstPartyProviderSnapshot(
        { emptySnapshot: true },
        { id: "fireworks", allowEmptySnapshot: true },
        now,
      ),
    ).toEqual({
      details: [],
      updatedAt: "2026-08-19T12:00:00.000Z",
      dataConfidence: "unknown",
    });
    expect(() => mapProviderSnapshot({ emptySnapshot: true }, "fireworks", now)).toThrow(
      InvalidProviderSnapshot,
    );
    expect(() =>
      mapFirstPartyProviderSnapshot({ emptySnapshot: true }, { id: "openai" }, now),
    ).toThrow(InvalidProviderSnapshot);
    expect(() =>
      mapFirstPartyProviderSnapshot(
        { emptySnapshot: true, primary: { usedPercent: 0 } },
        { id: "fireworks", allowEmptySnapshot: true },
        now,
      ),
    ).toThrow("cannot accompany snapshot data");
  });

  it("rejects invalid currency, date and detail chart shapes", () => {
    expect(() =>
      mapProviderSnapshot({ cost: { used: 1, currency: "usd" } }, "openai", now),
    ).toThrow("three-letter uppercase");
    expect(() =>
      mapProviderSnapshot({ primary: { usedPercent: 1, resetsAt: "not-a-date" } }, "openai", now),
    ).toThrow("valid ISO-8601 date");
    expect(() =>
      mapProviderSnapshot(
        { details: [{ rows: [], chart: { kind: "pie", points: [] } }] },
        "openai",
        now,
      ),
    ).toThrow("must be 'bars' or 'line'");
  });
});
