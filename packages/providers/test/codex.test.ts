import { describe, expect, it } from "vite-plus/test";

import { codex } from "../src/providers/codex.ts";
import type { ProviderContext } from "../src/types.ts";

function context(json: unknown): ProviderContext {
  const fail = (kind: string) => (message: string) => new Error(`${kind}: ${message}`);
  return {
    settings: { get: () => undefined, getSecret: () => "token" },
    http: {
      get: async () => ({ status: 200, bodyText: JSON.stringify(json) }),
      getJSON: async () => ({ status: 200, bodyText: JSON.stringify(json), json }),
      postJSON: async () => ({ status: 200, bodyText: JSON.stringify(json), json }),
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
    format: { number: String, usd: String, monthDay: (value) => value.toISOString().slice(5, 10) },
    pct: (used, limit) => (used / limit) * 100,
    amountFromPercent: (used, limit) => (used / 100) * limit,
    fail: {
      authenticationExpired: fail("authentication-expired"),
      missingCredential: fail("missing-credential"),
      permissionDenied: fail("permission-denied"),
      rateLimited: fail("rate-limited"),
      providerUnavailable: fail("provider-unavailable"),
      parseFailure: fail("parse-failure"),
      networkFailure: fail("network-failure"),
      apiFailure: fail("api-failure"),
    },
  };
}

describe("Codex OAuth usage vertical slice", () => {
  it("maps wham usage windows without platform knowledge", async () => {
    const snapshot = await codex.fetchUsage(
      context({
        account_id: "account-1",
        plan_type: "plus",
        rate_limit: {
          primary_window: {
            used_percent: 12,
            reset_at: 1_777_000_000,
            limit_window_seconds: 18_000,
          },
          secondary_window: {
            used_percent: 34,
            reset_at: 1_778_000_000,
            limit_window_seconds: 604_800,
          },
        },
        credits: { has_credits: true, unlimited: false, balance: "9.5" },
      }),
    );
    expect(snapshot.primary).toMatchObject({ usedPercent: 12, windowMinutes: 300 });
    expect(snapshot.secondary).toMatchObject({ usedPercent: 34, windowMinutes: 10_080 });
    expect(snapshot.identity).toMatchObject({ accountId: "account-1", loginMethod: "plus" });
  });
});
