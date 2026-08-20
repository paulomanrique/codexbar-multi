import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { CodexBarConfig } from "../src/config.ts";
import { ProviderFetchClassifiedError } from "../src/errors.ts";
import {
  decodeUsageSnapshot,
  encodeUsageSnapshot,
  RateWindow,
  UsageSnapshot,
} from "../src/usage.ts";

describe("schema contracts", () => {
  it("uses CodexBar's persisted field spelling and private config wire types", () => {
    const config = Schema.decodeUnknownSync(CodexBarConfig)({
      version: 1,
      providers: [
        {
          id: "codex",
          workspaceID: "project-123",
          cookieSource: "manual",
          tokenAccounts: {
            version: 1,
            activeIndex: 0,
            accounts: [{ id: "account", label: "Main", token: "secret", addedAt: 0 }],
          },
        },
      ],
      hooks: { enabled: false, events: [] },
    });
    expect(config.providers[0]).toMatchObject({
      workspaceID: "project-123",
      cookieSource: "manual",
    });
  });

  it("accepts Swift-compatible sparse rate windows", () => {
    const window = Schema.decodeUnknownSync(RateWindow)({ usedPercent: 12.5, windowMinutes: 300 });
    expect(window.usedPercent).toBe(12.5);
    expect(window.isSyntheticPlaceholder).toBeUndefined();
  });

  it("accepts a generic snapshot without provider credentials", () => {
    const snapshot = Schema.decodeUnknownSync(UsageSnapshot)({
      primary: { usedPercent: 1 },
      details: [],
      updatedAt: "2026-08-19T00:00:00Z",
    });
    expect(snapshot.details).toEqual([]);
  });

  it("decodes Swift null lanes, legacy identity keys, and omitted defaults", () => {
    const snapshot = decodeUsageSnapshot({
      primary: {
        usedPercent: 42,
        windowMinutes: 300,
        resetsAt: "2026-08-02T17:00:00Z",
        resetDescription: null,
      },
      secondary: null,
      tertiary: null,
      providerCost: {
        used: 12.5,
        limit: 50,
        currencyCode: "USD",
        period: "Monthly",
        resetsAt: null,
        updatedAt: "2026-08-02T12:00:00Z",
      },
      updatedAt: "2026-08-02T12:00:00Z",
      identity: {
        providerID: "synthetic",
        accountEmail: "fixture@example.com",
        accountOrganization: "Fixture Org",
        loginMethod: "API key",
        accountID: "acct_fixture",
      },
      details: null,
    });

    expect(snapshot.primary?.usedPercent).toBe(42);
    expect(snapshot.secondary).toBeUndefined();
    expect(snapshot.details).toEqual([]);
    expect(snapshot.identity).toEqual({
      providerId: "synthetic",
      accountEmail: "fixture@example.com",
      accountOrganization: "Fixture Org",
      loginMethod: "API key",
      accountId: "acct_fixture",
    });
  });

  it("emits the Swift snapshot wire shape and its omission rules", () => {
    const snapshot = Schema.decodeUnknownSync(UsageSnapshot)({
      primary: { usedPercent: 42, resetsAt: "2026-08-02T17:00:00.000Z" },
      secondary: undefined,
      tertiary: undefined,
      providerCost: {
        used: 12.5,
        limit: 50,
        currencyCode: "USD",
        period: undefined,
        resetsAt: undefined,
        updatedAt: "2026-08-02T12:00:00.000Z",
      },
      details: [],
      updatedAt: "2026-08-02T12:00:00.000Z",
      identity: {
        providerId: "synthetic",
        accountEmail: "fixture@example.com",
        accountOrganization: "Fixture Org",
        loginMethod: "API key",
        accountId: "acct_fixture",
      },
      dataConfidence: "unknown",
    });

    expect(encodeUsageSnapshot(snapshot)).toEqual({
      primary: { usedPercent: 42, resetsAt: "2026-08-02T17:00:00Z" },
      secondary: null,
      tertiary: null,
      providerCost: {
        used: 12.5,
        limit: 50,
        currencyCode: "USD",
        updatedAt: "2026-08-02T12:00:00Z",
      },
      updatedAt: "2026-08-02T12:00:00Z",
      identity: {
        providerID: "synthetic",
        accountEmail: "fixture@example.com",
        accountOrganization: "Fixture Org",
        loginMethod: "API key",
        accountID: "acct_fixture",
      },
      accountEmail: "fixture@example.com",
      accountOrganization: "Fixture Org",
      loginMethod: "API key",
    });
  });

  it("maps future confidence values to Swift's unknown default and trims details", () => {
    const snapshot = decodeUsageSnapshot({
      primary: null,
      secondary: null,
      tertiary: null,
      details: [
        {
          title: " Billing ",
          rows: [{ label: " Total ", value: " $12.50 ", secondaryValue: " 2 requests " }],
          chart: {
            kind: "bars",
            title: " Daily ",
            unit: " USD ",
            points: [{ label: " Monday ", value: 12.5 }],
          },
        },
      ],
      updatedAt: "2026-08-02T12:00:00.000Z",
      dataConfidence: "future",
    });

    expect(snapshot.dataConfidence).toBeUndefined();
    expect(snapshot.details[0]).toEqual({
      title: "Billing",
      rows: [{ label: "Total", value: "$12.50", secondaryValue: "2 requests" }],
      chart: {
        kind: "bars",
        title: "Daily",
        unit: "USD",
        points: [{ label: "Monday", value: 12.5 }],
      },
    });
    expect(encodeUsageSnapshot(snapshot).dataConfidence).toBeUndefined();
  });

  it("rejects non-ISO dates and non-JSON provider enrichments", () => {
    expect(() =>
      decodeUsageSnapshot({ primary: null, secondary: null, tertiary: null, updatedAt: "today" }),
    ).toThrow();
    expect(() =>
      decodeUsageSnapshot({
        primary: null,
        secondary: null,
        tertiary: null,
        updatedAt: "2026-08-02T12:00:00Z",
        openAIAPIUsage: () => undefined,
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(UsageSnapshot)({
        details: Array.from({ length: 9 }, () => ({ rows: [] })),
        updatedAt: "2026-08-02T12:00:00Z",
      }),
    ).toThrow();
  });

  it("preserves classified fetch errors", () => {
    const error = Schema.decodeUnknownSync(ProviderFetchClassifiedError)({
      kind: "rate-limited",
      message: "try later",
      retryAfterSeconds: 2,
    });
    expect(error.kind).toBe("rate-limited");
  });
});
