import { describe, expect, it } from "vite-plus/test";
import { parseAmpUsage } from "../src/providers/amp.ts";
import { zed } from "../src/providers/zed.ts";
import type { ProviderContext } from "../src/types.ts";
const ctx = (json: unknown = {}) =>
  ({
    settings: {
      get: (key: string) =>
        (({ ZED_USER_ID: "u", ZED_ACCESS_TOKEN: "t" }) as Record<string, string>)[key],
      getSecret: (key: string) => (({ ZED_ACCESS_TOKEN: "t" }) as Record<string, string>)[key],
    },
    http: {
      get: async () => ({ status: 200, bodyText: JSON.stringify(json) }),
      getJSON: async () => ({ status: 200, bodyText: JSON.stringify(json), json }),
      postJSON: async () => ({ status: 200, bodyText: "{}", json: {} }),
    },
    browser: { cookieHeader: async () => "" },
    env: {},
    date: {
      now: () => new Date(),
      nowMillis: () => 0,
      iso: (x: string) => new Date(x).toISOString(),
      unixSeconds: (x: number) => new Date(x * 1000).toISOString(),
      unixMillis: (x: number) => new Date(x).toISOString(),
      nextDailyReset: () => "",
    },
    format: {
      number: (x: number) => String(x),
      usd: (x: number) => `$${x.toFixed(2)}`,
      monthDay: () => "",
    },
    pct: (x: number, y: number) => (x / y) * 100,
    amountFromPercent: () => 0,
    fail: Object.fromEntries(
      [
        "authenticationExpired",
        "missingCredential",
        "permissionDenied",
        "rateLimited",
        "providerUnavailable",
        "parseFailure",
        "networkFailure",
        "apiFailure",
      ].map((k) => [k, (m: string) => new Error(`${k}:${m}`)]),
    ),
  }) as unknown as ProviderContext;
describe("Swift-derived local/CLI provider domains", () => {
  it("parses Amp CLI quota text", () =>
    expect(parseAmpUsage("Plan: Pro\nUsage: 25%\nBalance: $12.50", ctx())).toMatchObject({
      primary: { usedPercent: 25 },
      identity: { loginMethod: "Pro" },
    }));
  it("maps Zed edit predictions from injected credentials", async () =>
    expect(
      await zed.fetchUsage(
        ctx({
          user: { github_login: "octo" },
          plan: {
            plan_v3: "zed pro",
            usage: { edit_predictions: { used: 2, limit: 10 } },
            subscription_period: { ended_at: "2026-09-01T00:00:00Z" },
          },
        }),
      ),
    ).toMatchObject({
      primary: { usedPercent: 20 },
      identity: { accountID: "octo", loginMethod: "Zed Pro" },
    }));
});
