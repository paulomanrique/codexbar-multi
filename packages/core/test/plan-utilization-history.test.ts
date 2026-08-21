import { describe, expect, it } from "vite-plus/test";

import {
  PlanUtilizationHistoryBuckets,
  PlanUtilizationHistoryEntry,
  PlanUtilizationHistorySelection,
  PlanUtilizationSeriesHistory,
  PlanUtilizationSeriesName,
  decodePlanUtilizationHistoryDocument,
  decodePlanUtilizationHistoryProviders,
  parsePlanUtilizationHistoryDocument,
  stringifyPlanUtilizationHistoryDocument,
} from "../src/index.ts";

const date = (value: string) => new Date(value);
const entry = (capturedAt: string, usedPercent: number, resetsAt?: string) =>
  new PlanUtilizationHistoryEntry({
    capturedAt: date(capturedAt),
    usedPercent,
    ...(resetsAt === undefined ? {} : { resetsAt: date(resetsAt) }),
  });

describe("plan utilization history (Swift parity)", () => {
  it("canonicalizes series windows, entries, accounts, and ISO dates", () => {
    const buckets = new PlanUtilizationHistoryBuckets({
      preferredAccountKey: "acct",
      unscoped: [
        new PlanUtilizationSeriesHistory({
          name: "weekly",
          windowMinutes: 10_080,
          entries: [
            entry("2026-08-21T00:00:02Z", 12),
            entry("2026-08-21T00:00:01Z", 12, "2026-08-22T00:00:00Z"),
          ],
        }),
        new PlanUtilizationSeriesHistory({
          name: "session",
          windowMinutes: 300,
          entries: [entry("2026-08-21T00:00:00Z", 50)],
        }),
      ],
      accounts: {
        empty: [],
        acct: [
          new PlanUtilizationSeriesHistory({
            name: "monthly",
            windowMinutes: 43_200,
            entries: [entry("2026-08-21T00:00:00.123Z", 1)],
          }),
        ],
      },
      sessionEquivalentWindowPairIdentities: { acct: "pair-1" },
    });
    expect(stringifyPlanUtilizationHistoryDocument(buckets)).toBe(
      '{"accounts":{"acct":[{"entries":[{"capturedAt":"2026-08-21T00:00:00Z","usedPercent":1}],"name":"monthly","windowMinutes":43200}]},"preferredAccountKey":"acct","sessionEquivalentWindowPairIdentities":{"acct":"pair-1"},"unscoped":[{"entries":[{"capturedAt":"2026-08-21T00:00:00Z","usedPercent":50}],"name":"session","windowMinutes":300},{"entries":[{"capturedAt":"2026-08-21T00:00:01Z","resetsAt":"2026-08-22T00:00:00Z","usedPercent":12},{"capturedAt":"2026-08-21T00:00:02Z","usedPercent":12}],"name":"weekly","windowMinutes":10080}],"version":1}',
    );
  });

  it("round-trips the v1 document and preserves Swift ordering", () => {
    const buckets = new PlanUtilizationHistoryBuckets({
      preferredAccountKey: "acct",
      unscoped: [
        new PlanUtilizationSeriesHistory({
          name: "session",
          windowMinutes: 300,
          entries: [entry("2026-08-21T00:00:00Z", 50)],
        }),
      ],
      accounts: {
        acct: [
          new PlanUtilizationSeriesHistory({
            name: "weekly",
            windowMinutes: 10_080,
            entries: [entry("2026-08-21T00:00:01Z", 12)],
          }),
        ],
      },
      sessionEquivalentWindowPairIdentities: { acct: "pair-1" },
    });
    const json = stringifyPlanUtilizationHistoryDocument(buckets);
    expect(json).toBe(
      '{"accounts":{"acct":[{"entries":[{"capturedAt":"2026-08-21T00:00:01Z","usedPercent":12}],"name":"weekly","windowMinutes":10080}]},"preferredAccountKey":"acct","sessionEquivalentWindowPairIdentities":{"acct":"pair-1"},"unscoped":[{"entries":[{"capturedAt":"2026-08-21T00:00:00Z","usedPercent":50}],"name":"session","windowMinutes":300}],"version":1}',
    );
    const decoded = parsePlanUtilizationHistoryDocument(json);
    expect(decoded?.preferredAccountKey).toBe("acct");
    expect(decoded?.historiesFor("acct")[0]?.name.rawValue).toBe("weekly");
    expect(decoded?.unscoped[0]?.latestCapturedAt?.toISOString()).toBe("2026-08-21T00:00:00.000Z");
  });

  it("fails soft for malformed JSON, unknown schema, and malformed provider files", () => {
    expect(parsePlanUtilizationHistoryDocument("not json")).toBeUndefined();
    expect(
      decodePlanUtilizationHistoryDocument({ version: 2, unscoped: [], accounts: {} }),
    ).toBeUndefined();
    expect(
      decodePlanUtilizationHistoryDocument({ version: 1, unscoped: [], accounts: { acct: "bad" } }),
    ).toBeUndefined();
    expect(
      decodePlanUtilizationHistoryProviders({
        "bad/id": { version: 1, unscoped: [], accounts: {} },
        codex: { version: 1, unscoped: [], accounts: {} },
      }),
    ).toHaveProperty("codex");
  });

  it("sanitizes decodable empty and non-positive series like the Swift loader", () => {
    const decoded = decodePlanUtilizationHistoryDocument({
      version: 1,
      unscoped: [
        { name: "empty", windowMinutes: 300, entries: [] },
        {
          name: "invalid-window",
          windowMinutes: 0,
          entries: [{ capturedAt: "2026-08-21T00:00:00Z", usedPercent: 1 }],
        },
        {
          name: "session",
          windowMinutes: 300,
          entries: [{ capturedAt: "2026-08-21T00:00:00Z", usedPercent: 1 }],
        },
      ],
      accounts: {},
    });
    expect(decoded?.unscoped.map((history) => history.name.rawValue)).toEqual(["session"]);
  });

  it("uses Unicode-scalar ordering and rejects unsafe window integers", () => {
    const decoded = decodePlanUtilizationHistoryDocument({
      version: 1,
      unscoped: [
        {
          name: "Å",
          windowMinutes: 300,
          entries: [{ capturedAt: "2026-08-21T00:00:00Z", usedPercent: 1 }],
        },
        {
          name: "Z",
          windowMinutes: 300,
          entries: [{ capturedAt: "2026-08-21T00:00:00Z", usedPercent: 1 }],
        },
      ],
      accounts: {},
    });
    expect(decoded?.unscoped.map((history) => history.name.rawValue)).toEqual(["Z", "Å"]);
    const accounts = new PlanUtilizationHistoryBuckets({
      accounts: {
        Å: [
          new PlanUtilizationSeriesHistory({
            name: "session",
            windowMinutes: 300,
            entries: [entry("2026-08-21T00:00:00Z", 1)],
          }),
        ],
        Z: [
          new PlanUtilizationSeriesHistory({
            name: "session",
            windowMinutes: 300,
            entries: [entry("2026-08-21T00:00:00Z", 1)],
          }),
        ],
      },
      sessionEquivalentWindowPairIdentities: { Å: "accent", Z: "ascii" },
    });
    const serialized = stringifyPlanUtilizationHistoryDocument(accounts);
    expect(serialized.indexOf('"Z"')).toBeLessThan(serialized.indexOf('"Å"'));
    expect(
      decodePlanUtilizationHistoryDocument({
        version: 1,
        unscoped: [
          {
            name: "session",
            windowMinutes: Number.MAX_SAFE_INTEGER + 1,
            entries: [{ capturedAt: "2026-08-21T00:00:00Z", usedPercent: 1 }],
          },
        ],
        accounts: {},
      }),
    ).toBeUndefined();
  });

  it("preserves account and identity bucket mutations", () => {
    const buckets = new PlanUtilizationHistoryBuckets();
    buckets.setHistories(
      [
        new PlanUtilizationSeriesHistory({
          name: "session",
          windowMinutes: 300,
          entries: [entry("2026-08-21T00:00:00Z", 1)],
        }),
      ],
      "acct",
    );
    expect(buckets.historiesFor("acct")).toHaveLength(1);
    buckets.setSessionEquivalentWindowPairIdentity("pair-1", "acct");
    buckets.moveSessionEquivalentWindowPairIdentity("acct", "new");
    expect(buckets.sessionEquivalentWindowPairIdentityFor("new")).toBe("pair-1");
    buckets.invalidateSessionEquivalentWindowPairIdentity("new");
    expect(buckets.sessionEquivalentWindowPairIdentityFor("new")).toBe("__codexbar_invalidated__");
    buckets.setHistories([], "acct");
    expect(buckets.accounts).not.toHaveProperty("acct");
  });

  it("matches canonical window aliases", () => {
    expect(PlanUtilizationSeriesName.session.canonicalWindowMinutes(299)).toBe(300);
    expect(PlanUtilizationSeriesName.weekly.canonicalWindowMinutes(10_071)).toBe(10_080);
    expect(new PlanUtilizationSeriesName("custom").canonicalWindowMinutes(299)).toBe(299);
    expect(PlanUtilizationHistorySelection.unavailable.cacheIdentity).toBe("unavailable");
  });
});
