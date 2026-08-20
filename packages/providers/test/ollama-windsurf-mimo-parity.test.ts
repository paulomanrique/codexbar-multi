import { describe, expect, it } from "vite-plus/test";

import { mimo } from "../src/providers/mimo.ts";
import { ollama } from "../src/providers/ollama.ts";
import { windsurf } from "../src/providers/windsurf.ts";
import type { ProviderContext, ProviderResponse } from "../src/types.ts";

type Request = {
  readonly method: "GET" | "POST";
  readonly url: URL;
  readonly options?: Record<string, unknown>;
};
const fail = (kind: string) => (message: string) => new Error(`${kind}: ${message}`);
const json = (value: unknown, status = 200): ProviderResponse => ({
  status,
  bodyText: JSON.stringify(value),
});
const context = (
  callback: (request: Request) => ProviderResponse,
  settings: Record<string, string> = {},
): ProviderContext => {
  const request = async (method: "GET" | "POST", url: string, options?: Record<string, unknown>) =>
    callback({ method, url: new URL(url), ...(options ? { options } : {}) });
  return {
    settings: { get: (key) => settings[key], getSecret: (key) => settings[key] },
    http: {
      get: (url, options) => request("GET", url, options),
      getJSON: async (url, options) => {
        const result = await request("GET", url, options);
        return { ...result, json: JSON.parse(result.bodyText) as unknown };
      },
      postJSON: async (url, options) => {
        const result = await request("POST", url, options);
        return { ...result, json: JSON.parse(result.bodyText) as unknown };
      },
    },
    browser: { cookieHeader: async () => "" },
    env: {},
    date: {
      now: () => new Date("2026-08-20T12:00:00Z"),
      nowMillis: () => Date.parse("2026-08-20T12:00:00Z"),
      iso: (value) => new Date(value).toISOString(),
      unixSeconds: (value) => new Date(value * 1_000).toISOString(),
      unixMillis: (value) => new Date(value).toISOString(),
      nextDailyReset: () => "2026-08-21T00:00:00Z",
    },
    format: {
      number: (value, options) =>
        new Intl.NumberFormat("en-US", options as Intl.NumberFormatOptions).format(value),
      usd: (value) => `$${value.toFixed(2)}`,
      monthDay: (value) => value.toISOString().slice(5, 10),
    },
    pct: (used, total) => (used / total) * 100,
    amountFromPercent: (percent, total) => (percent / 100) * total,
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
};

describe("Ollama, Windsurf, and MiMo Swift-derived provider parity", () => {
  it("keeps IDs and declarative browser capabilities", () => {
    expect([ollama, windsurf, mimo].map((provider) => provider.descriptor.id)).toEqual([
      "ollama",
      "windsurf",
      "mimo",
    ]);
    for (const provider of [ollama, windsurf, mimo])
      expect(provider.descriptor.capabilities).toEqual(["browser-cookies"]);
  });
  it("parses Ollama settings HTML session and weekly windows", async () => {
    const raw = await ollama.fetchUsage(
      context(
        () => ({
          status: 200,
          bodyText:
            '<span>Cloud Usage</span><span>free</span><div id="header-email">user@example.com</div><span>Session usage</span><span>0.1% used</span><div data-time="2026-08-20T14:00:00Z"></div><span>Weekly usage</span><span>0.7% used</span><div data-time="2026-08-25T00:00:00Z"></div>',
        }),
        { OLLAMA_COOKIE: "__Secure-session=fixture" },
      ),
    );
    expect(raw).toMatchObject({
      primary: { usedPercent: 0.1, windowMinutes: 300 },
      secondary: { usedPercent: 0.7, windowMinutes: 10_080 },
      identity: { loginMethod: "free", accountEmail: "user@example.com" },
    });
  });
  it("preserves Windsurf session headers and daily/weekly response mapping", async () => {
    let request: Request | undefined;
    const raw = await windsurf.fetchUsage(
      context(
        (candidate) => {
          request = candidate;
          return json({
            planStatus: {
              planInfo: { planName: "Pro" },
              dailyQuotaRemainingPercent: 64,
              weeklyQuotaRemainingPercent: 80,
              dailyQuotaResetAtUnix: 1_800_000_000,
              weeklyQuotaResetAtUnix: 1_800_100_000,
            },
          });
        },
        {
          WINDSURF_SESSION: JSON.stringify({
            devin_session_token: "session",
            devin_auth1_token: "auth",
            devin_account_id: "account",
            devin_primary_org_id: "org",
          }),
        },
      ),
    );
    expect(request?.options).toMatchObject({
      headers: {
        "x-devin-session-token": "session",
        "x-devin-auth1-token": "auth",
        "x-devin-account-id": "account",
        "x-devin-primary-org-id": "org",
        "Connect-Protocol-Version": "1",
      },
    });
    expect(raw).toMatchObject({
      primary: { usedPercent: 36 },
      secondary: { usedPercent: 20 },
      identity: { loginMethod: "Pro" },
    });
  });
  it("combines MiMo balance and optional token-plan data", async () => {
    const raw = await mimo.fetchUsage(
      context(
        (request) =>
          request.url.pathname.endsWith("/balance")
            ? json({
                code: 0,
                data: { balance: "25.51", cashBalance: "20", giftBalance: "5.51", currency: "USD" },
              })
            : request.url.pathname.endsWith("/detail")
              ? json({
                  code: 0,
                  data: { planCode: "standard", currentPeriodEnd: "2026-09-01 00:00:00" },
                })
              : json({
                  code: 0,
                  data: {
                    monthUsage: { percent: 0.1, items: [{ used: 10, limit: 100, percent: 0.1 }] },
                  },
                }),
        { MIMO_COOKIE: "api-platform_serviceToken=token; userId=user" },
      ),
    );
    expect(raw).toMatchObject({
      primary: { usedPercent: 10, resetDescription: "10 / 100 Credits" },
      details: [{ rows: [{ label: "Balance", value: "$25.51 (Paid: $20.00 / Granted: $5.51)" }] }],
      identity: { loginMethod: "Standard" },
    });
  });
});
