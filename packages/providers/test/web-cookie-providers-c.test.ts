import { describe, expect, it } from "vite-plus/test";

import { devin } from "../src/providers/devin.ts";
import { factory, factoryManualCredentials } from "../src/providers/factory.ts";
import { kimi } from "../src/providers/kimi.ts";
import type { ProviderContext, ProviderResponse } from "../src/types.ts";

type Request = {
  readonly method: "GET" | "POST";
  readonly url: URL;
  readonly options?: Record<string, unknown>;
};
const failure = (kind: string) => (message: string) => new Error(`${kind}: ${message}`);
const response = (body: unknown, status = 200): ProviderResponse => ({
  status,
  bodyText: JSON.stringify(body),
});

function context(
  fixture: (request: Request) => ProviderResponse,
  values: Readonly<Record<string, string>> = {},
  cookie = "",
  requests: Request[] = [],
): ProviderContext {
  const request = async (
    method: Request["method"],
    url: string,
    options?: Record<string, unknown>,
  ) => {
    const record = { method, url: new URL(url), ...(options ? { options } : {}) };
    requests.push(record);
    return fixture(record);
  };
  return {
    settings: { get: (key) => values[key], getSecret: (key) => values[key] },
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
    browser: { cookieHeader: async () => cookie },
    env: { timeZone: "UTC" },
    date: {
      now: () => new Date("2026-08-20T12:00:00.000Z"),
      nowMillis: () => Date.parse("2026-08-20T12:00:00.000Z"),
      iso: (value) => new Date(value).toISOString(),
      unixSeconds: (value) => new Date(value * 1_000).toISOString(),
      unixMillis: (value) => new Date(value).toISOString(),
      nextDailyReset: () => "2026-08-21T00:00:00.000Z",
    },
    format: {
      number: (value) => new Intl.NumberFormat("en-US").format(value),
      usd: (value) => `$${value.toFixed(2)}`,
      monthDay: (value) => value.toISOString().slice(5, 10),
    },
    pct: (used, limit) => (limit > 0 ? (used / limit) * 100 : 100),
    amountFromPercent: (usedPercent, limit) => (usedPercent / 100) * limit,
    fail: {
      authenticationExpired: failure("authentication-expired"),
      missingCredential: failure("missing-credential"),
      permissionDenied: failure("permission-denied"),
      rateLimited: failure("rate-limited"),
      providerUnavailable: failure("provider-unavailable"),
      parseFailure: failure("parse-failure"),
      networkFailure: failure("network-failure"),
      apiFailure: failure("api-failure"),
    },
  };
}

describe("Swift-derived Devin, Factory and Kimi parity", () => {
  it("keeps upstream descriptors, web strategies and restricted cookie domains", () => {
    expect([devin, factory, kimi].map((provider) => provider.descriptor.id)).toEqual([
      "devin",
      "factory",
      "kimi",
    ]);
    expect([devin, factory, kimi].map((provider) => provider.id)).toEqual([
      "devin.web",
      "factory.web",
      "kimi.web",
    ]);
    expect(factory.descriptor.cookieDomains).toEqual([
      "app.factory.ai",
      "auth.factory.ai",
      "api.factory.ai",
    ]);
  });

  it.each([
    ["session=abc", { cookieHeader: "session=abc" }],
    ["Cookie: session=abc", { cookieHeader: "session=abc" }],
    ["curl https://app.factory.ai -H 'Cookie: session=abc'", { cookieHeader: "session=abc" }],
    ["curl https://app.factory.ai --cookie 'session=abc'", { cookieHeader: "session=abc" }],
    ["curl https://app.factory.ai -bsession=abc", { cookieHeader: "session=abc" }],
    [
      "access-token=header.payload.signature; session=abc",
      {
        cookieHeader: "access-token=header.payload.signature; session=abc",
        bearerToken: "header.payload.signature",
      },
    ],
    ["Authorization: Bearer factory-token", { bearerToken: "factory-token" }],
    ["Bearer factory-token", { bearerToken: "factory-token" }],
    ["header.payload.signature", { bearerToken: "header.payload.signature" }],
    [
      `Cookie: session=abc\nAuthorization: Bearer factory-token`,
      { cookieHeader: "session=abc", bearerToken: "factory-token" },
    ],
  ] as const)("normalizes Factory manual credential %s", (raw, expected) => {
    expect(factoryManualCredentials(raw)).toEqual(expected);
  });

  it.each([undefined, "", "short-token", "definitely not a cookie or bearer", "theme-only"])(
    "rejects malformed Factory manual credential %s",
    (raw) => {
      expect(factoryManualCredentials(raw)).toBeUndefined();
    },
  );

  it("retries a stale manual cookie with its separate bearer token", async () => {
    const requests: Request[] = [];
    const snapshot = await factory.fetchUsage(
      context(
        (request) => {
          if (request.url.pathname === "/api/app/auth/me") {
            const headers = request.options?.headers as
              | Readonly<Record<string, string>>
              | undefined;
            if (headers?.Cookie) return response({}, 401);
            return response({ userProfile: { id: "selected-user" } });
          }
          if (request.url.pathname === "/api/billing/limits") return response({}, 404);
          return response({
            usage: {
              standard: { userTokens: 10, totalAllowance: 100 },
              premium: { userTokens: 20, totalAllowance: 100 },
            },
          });
        },
        {
          FACTORY_COOKIE_HEADER:
            "Cookie: session=stale\nAuthorization: Bearer factory-access-token",
        },
        "",
        requests,
      ),
    );
    expect(snapshot).toMatchObject({
      primary: { usedPercent: 10 },
      secondary: { usedPercent: 20 },
    });
    expect(requests.map((request) => request.url.hostname)).toEqual([
      "app.factory.ai",
      "auth.factory.ai",
      "api.factory.ai",
      "api.factory.ai",
      "api.factory.ai",
      "api.factory.ai",
    ]);
    for (const request of requests.slice(0, 3)) {
      expect(request.options?.headers).toMatchObject({
        Cookie: "session=stale",
        Authorization: "Bearer factory-access-token",
      });
    }
    for (const request of requests.slice(3)) {
      const headers = request.options?.headers as Readonly<Record<string, string>> | undefined;
      expect(headers).toMatchObject({
        Authorization: "Bearer factory-access-token",
      });
      expect(headers?.Cookie).toBeUndefined();
    }
  });

  it("normalizes Devin organization paths and returns daily, weekly and overage windows", async () => {
    const requests: Request[] = [];
    const snapshot = await devin.fetchUsage(
      context(
        () =>
          response({
            daily_percentage: 0.12,
            weekly_percentage: 42,
            daily_reset_at: "2026-08-21T00:00:00Z",
            weekly_reset_at: "2026-08-27T00:00:00Z",
            plan_name: "pro",
            overage_balance_cents: 7087,
          }),
        {
          DEVIN_BEARER_TOKEN: "Authorization: Bearer fixture-token",
          DEVIN_ORGANIZATION: "https://app.devin.ai/org/example-org/settings/usage",
        },
        "",
        requests,
      ),
    );
    expect(requests[0]?.url.pathname).toBe("/api/org/example-org/billing/quota/usage");
    expect(requests[0]?.options).toMatchObject({
      headers: { Authorization: "Bearer fixture-token" },
    });
    expect(snapshot).toEqual({
      primary: {
        usedPercent: 12,
        resetsAt: "2026-08-21T00:00:00.000Z",
        windowMinutes: 1440,
        resetDescription: "Daily",
      },
      secondary: {
        usedPercent: 42,
        resetsAt: "2026-08-27T00:00:00.000Z",
        windowMinutes: 10080,
        resetDescription: "Weekly",
      },
      cost: { used: 70.87, limit: 0, currency: "USD", period: "Extra usage balance" },
      identity: { organization: "example-org", loginMethod: "Pro" },
    });
  });

  it("uses Factory token rate windows and preserves the extra usage balance", async () => {
    const requests: Request[] = [];
    const snapshot = await factory.fetchUsage(
      context(
        (request) => {
          if (request.url.pathname === "/api/app/auth/me")
            return response({
              userProfile: { id: "user-1", email: "fixture@example.com" },
              organization: {
                name: "Acme",
                subscription: {
                  factoryTier: "enterprise",
                  orbSubscription: { plan: { name: "Pro" } },
                },
              },
            });
          return response({
            usesTokenRateLimitsBilling: true,
            extraUsageBalanceCents: 1250,
            overagePreference: "extra usage",
            limits: {
              standard: {
                fiveHour: { usedPercent: 25, secondsRemaining: 600 },
                weekly: { usedPercent: 50, windowEnd: "2026-08-27T00:00:00Z" },
                monthly: { usedPercent: 75, windowEnd: "2026-09-01T00:00:00Z" },
              },
            },
          });
        },
        { FACTORY_API_KEY: "fixture-key" },
        "",
        requests,
      ),
    );
    expect(requests.map((entry) => entry.url.hostname)).toEqual([
      "api.factory.ai",
      "api.factory.ai",
    ]);
    expect(requests[0]?.options).toMatchObject({
      headers: { Authorization: "Bearer fixture-key" },
    });
    expect(snapshot).toMatchObject({
      primary: { usedPercent: 25, windowMinutes: 300 },
      secondary: { usedPercent: 50, windowMinutes: 10080, resetsAt: "2026-08-27T00:00:00.000Z" },
      tertiary: { usedPercent: 75, resetsAt: "2026-09-01T00:00:00.000Z" },
      cost: { used: 12.5, limit: 0, currency: "USD", period: "Extra usage balance" },
      identity: {
        email: "fixture@example.com",
        organization: "Acme",
        loginMethod: "Factory Enterprise - Pro - Fallback: extra usage",
      },
    });
  });

  it("maps Kimi coding usage, a rate window and optional subscription lanes from its isolated cookie", async () => {
    const snapshot = await kimi.fetchUsage(
      context(
        (request) =>
          request.url.pathname.includes("GetUsages")
            ? response({
                usages: [
                  {
                    scope: "FEATURE_CODING",
                    detail: { limit: "100", used: "25", resetTime: "2026-08-27T00:00:00Z" },
                    limits: [
                      {
                        window: { duration: 5, timeUnit: "TIME_UNIT_HOUR" },
                        detail: { limit: "10", remaining: "4", resetTime: "2026-08-20T15:00:00Z" },
                      },
                    ],
                  },
                ],
              })
            : response({
                subscriptionBalance: {
                  feature: "FEATURE_OMNI",
                  type: "SUBSCRIPTION",
                  amountUsedRatio: 0.42,
                  expireTime: "2026-09-01T00:00:00Z",
                },
              }),
        {},
        "kimi-auth=fixture.token.value",
      ),
    );
    expect(snapshot).toEqual({
      primary: {
        usedPercent: 25,
        windowMinutes: 10080,
        resetsAt: "2026-08-27T00:00:00.000Z",
        resetDescription: "25/100 requests",
      },
      secondary: {
        usedPercent: 60,
        windowMinutes: 300,
        resetsAt: "2026-08-20T15:00:00.000Z",
        resetDescription: "Rate: 6/10 per 5 hours",
      },
      extraRateWindows: [
        {
          id: "kimi-monthly",
          title: "Total usage",
          window: { usedPercent: 42, windowMinutes: 43200, resetsAt: "2026-09-01T00:00:00.000Z" },
        },
      ],
    });
  });
});
