import { describe, expect, it } from "vite-plus/test";
import { mapFirstPartyProviderSnapshot } from "../src/snapshot-mapper.ts";
import { fireworks } from "../src/providers/fireworks.ts";
import { moonshot } from "../src/providers/moonshot.ts";
import type { ProviderContext } from "../src/types.ts";

function context(body: unknown, settings: Record<string, string> = {}): ProviderContext {
  const fail = (kind: string) => (message: string) => new Error(`${kind}: ${message}`);
  return {
    settings: { get: (key) => settings[key], getSecret: (key) => settings[key] },
    http: {
      get: async () => ({ status: 200, bodyText: JSON.stringify(body) }),
      getJSON: async () => ({ status: 200, bodyText: JSON.stringify(body), json: body }),
      postJSON: async () => ({ status: 200, bodyText: JSON.stringify(body), json: body }),
    },
    browser: { cookieHeader: async () => "" },
    env: {},
    date: {
      now: () => new Date("2026-08-19T00:00:00Z"),
      nowMillis: () => Date.parse("2026-08-19T00:00:00Z"),
      iso: (value) => new Date(value).toISOString(),
      unixSeconds: (value) => new Date(value * 1000).toISOString(),
      unixMillis: (value) => new Date(value).toISOString(),
      nextDailyReset: () => "2026-08-20T00:00:00Z",
    },
    format: {
      number: String,
      usd: (value) => `$${value}`,
      monthDay: (value) => value.toISOString().slice(5, 10),
    },
    pct: (used, limit) => (used / limit) * 100,
    amountFromPercent: (used, limit) => (used / 100) * limit,
    fail: {
      authenticationExpired: fail("auth"),
      missingCredential: fail("missing"),
      permissionDenied: fail("permission"),
      rateLimited: fail("rate"),
      providerUnavailable: fail("unavailable"),
      parseFailure: fail("parse"),
      networkFailure: fail("network"),
      apiFailure: fail("api"),
    },
  };
}

describe("HTTP provider wave fixtures", () => {
  it("sums Fireworks billing line items in the newest currency", async () => {
    const snapshot = await fireworks.fetchUsage(
      context(
        {
          lineItems: [
            { totalCost: { currencyCode: "USD", units: "1", nanos: 500000000 } },
            { totalCost: { currencyCode: "USD", units: "2", nanos: 0 } },
          ],
        },
        { FIREWORKS_API_KEY: "fixture-key", FIREWORKS_ACCOUNT_SLUG: "acct" },
      ),
    );
    expect(
      mapFirstPartyProviderSnapshot(
        snapshot,
        fireworks.descriptor,
        new Date("2026-08-19T00:00:00Z"),
      ).providerCost,
    ).toMatchObject({
      used: 3.5,
      currencyCode: "USD",
      period: "Last 30 days",
    });
  });

  it("maps Moonshot balance identity without synthesizing a quota", async () => {
    const snapshot = await moonshot.fetchUsage(
      context(
        {
          code: 0,
          scode: "0x0",
          status: true,
          data: { available_balance: 49.58, voucher_balance: 50, cash_balance: 12.34 },
        },
        { MOONSHOT_API_KEY: "fixture-key" },
      ),
    );
    expect(snapshot.primary).toBeUndefined();
    expect(snapshot.identity).toMatchObject({ loginMethod: "Balance: $49.58" });
  });
});
