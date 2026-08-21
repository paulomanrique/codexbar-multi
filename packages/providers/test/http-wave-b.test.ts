import { describe, expect, it } from "vite-plus/test";
import { chutes } from "../src/providers/chutes.ts";
import { doubao } from "../src/providers/doubao.ts";
import { ibmbob } from "../src/providers/ibmbob.ts";
import { warp } from "../src/providers/warp.ts";
import type { ProviderContext, ProviderResponse } from "../src/types.ts";

const now = new Date("2026-08-20T12:00:00.000Z");
const fail = (kind: string) => (message: string) => new Error(`${kind}: ${message}`);
function context(
  fixture: (method: string, url: URL, options?: Record<string, unknown>) => ProviderResponse,
  settings: Record<string, string>,
  requests: Array<{ method: string; url: URL; options?: Record<string, unknown> }> = [],
): ProviderContext {
  const request = async (method: string, url: string, options?: Record<string, unknown>) => {
    const item = { method, url: new URL(url), ...(options ? { options } : {}) };
    requests.push(item);
    return fixture(method, item.url, options);
  };
  return {
    settings: { get: (key) => settings[key], getSecret: (key) => settings[key] },
    http: {
      get: (url, options) => request("GET", url, options),
      getJSON: async (url, options) => {
        const response = await request("GET", url, options);
        return { ...response, json: JSON.parse(response.bodyText) as unknown };
      },
      postJSON: async (url, options) => {
        const response = await request("POST", url, options);
        return { ...response, json: JSON.parse(response.bodyText) as unknown };
      },
    },
    browser: { cookieHeader: async () => "" },
    env: {},
    date: {
      now: () => now,
      nowMillis: () => now.getTime(),
      iso: (value) => new Date(value).toISOString(),
      unixSeconds: (value) => new Date(value * 1_000).toISOString(),
      unixMillis: (value) => new Date(value).toISOString(),
      nextDailyReset: () => "2026-08-21T00:00:00.000Z",
    },
    format: {
      number: String,
      usd: (value) => `$${value}`,
      monthDay: (value) => value.toISOString().slice(5, 10),
    },
    pct: (used, limit) => (limit > 0 ? (used / limit) * 100 : 100),
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
const response = (body: unknown, status = 200): ProviderResponse => ({
  status,
  bodyText: JSON.stringify(body),
});

describe("Swift-derived HTTP provider wave B", () => {
  it("preserves descriptor and strategy IDs", () => {
    expect([doubao, warp, chutes, ibmbob].map((provider) => provider.descriptor.id)).toEqual([
      "doubao",
      "warp",
      "chutes",
      "ibmbob",
    ]);
    expect([doubao, warp, chutes, ibmbob].map((provider) => provider.id)).toEqual([
      "doubao.api",
      "warp.api",
      "chutes.api",
      "ibmbob.api",
    ]);
  });

  it("maps Warp request and combined bonus windows, including GraphQL errors", async () => {
    const requests: Array<{ method: string; url: URL; options?: Record<string, unknown> }> = [];
    const snapshot = await warp.fetchUsage(
      context(
        () =>
          response({
            data: {
              user: {
                __typename: "UserOutput",
                user: {
                  requestLimitInfo: {
                    isUnlimited: false,
                    nextRefreshTime: "2026-08-21T00:00:00Z",
                    requestLimit: "1500",
                    requestsUsedSinceLastRefresh: 5,
                  },
                  bonusGrants: [
                    {
                      requestCreditsGranted: 20,
                      requestCreditsRemaining: 10,
                      expiration: "2026-09-01T10:00:00Z",
                    },
                  ],
                  workspaces: [
                    {
                      bonusGrantsInfo: {
                        grants: [
                          {
                            requestCreditsGranted: "15",
                            requestCreditsRemaining: "5",
                            expiration: "2026-09-01T10:00:00Z",
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          }),
        { WARP_TOKEN: "fixture-key" },
        requests,
      ),
    );
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.options).toMatchObject({
      method: "POST",
      headers: {
        Authorization: "Bearer fixture-key",
        "x-warp-client-id": "warp-app",
        "User-Agent": "Warp/1.0",
      },
    });
    expect(snapshot).toEqual({
      primary: {
        usedPercent: (5 / 1_500) * 100,
        resetsAt: "2026-08-21T00:00:00.000Z",
        resetDescription: "5/1500 credits",
      },
      secondary: {
        usedPercent: ((35 - 15) / 35) * 100,
        resetDescription: "15 credits expires on 2026-09-01T10:00:00.000Z",
      },
      identity: {},
    });
    await expect(
      warp.fetchUsage(
        context(() => response({ errors: [{ message: "Unauthorized" }] }), { WARP_API_KEY: "x" }),
      ),
    ).rejects.toThrow("api-failure: Unauthorized");
  });

  it("uses Chutes quota fallback and preserves active subscription context", async () => {
    const requests: Array<{ method: string; url: URL; options?: Record<string, unknown> }> = [];
    const snapshot = await chutes.fetchUsage(
      context(
        (_method, url) => {
          if (url.pathname.endsWith("subscription_usage"))
            return response({ subscription: { active: false, status: "free" } });
          if (url.pathname.endsWith("/quotas")) return response([{ chute_id: "0", quota: 100 }]);
          return response({ quota: 100, used: 10 });
        },
        { CHUTES_API_KEY: " 'chutes-key' ", CHUTES_API_URL: "https://chutes.test" },
        requests,
      ),
    );
    expect(requests.map((item) => item.url.pathname)).toEqual([
      "/users/me/subscription_usage",
      "/users/me/quotas",
      "/users/me/quota_usage/0",
    ]);
    expect(snapshot).toEqual({
      primary: { usedPercent: 10, resetDescription: "10/100 credits" },
      identity: { loginMethod: "No active subscription" },
    });
    await expect(
      chutes.fetchUsage(
        context(() => response({}), {
          CHUTES_API_KEY: "key",
          CHUTES_API_URL: "http://insecure.test",
        }),
      ),
    ).rejects.toThrow("api-failure:");
  });

  it("accepts a bare HTTPS host and derives utilization from used plus remaining", async () => {
    const requests: Array<{ method: string; url: URL; options?: Record<string, unknown> }> = [];
    const snapshot = await chutes.fetchUsage(
      context(
        (_method, url) => {
          if (url.pathname.endsWith("subscription_usage"))
            return response({ subscription: { used: 25, remaining: 75 } });
          return response({});
        },
        { CHUTES_API_KEY: "key", CHUTES_API_URL: "chutes.test/gateway?tenant=fixture#usage" },
        requests,
      ),
    );
    expect(requests[0]?.url.href).toBe(
      "https://chutes.test/gateway/users/me/subscription_usage?tenant=fixture#usage",
    );
    expect(snapshot.primary).toBeUndefined();
    expect(snapshot).toMatchObject({
      secondary: {
        usedPercent: 25,
        windowMinutes: 30 * 24 * 60,
        resetDescription: "25/100 credits",
      },
      identity: {},
    });
  });

  it("fetches every IBM Bob team, formats Bobcoins and rejects untrusted regions", async () => {
    const requests: Array<{ method: string; url: URL; options?: Record<string, unknown> }> = [];
    const profile = {
      instances: [
        {
          instance_id: "one",
          name: "Personal",
          user_id: "u1",
          plan_name: "Pro+",
          refresh_at: 1788220800,
          region_domain: "us-east.bob.ibm.com",
          teams: [{ id: "t1", name: "Solo", budget_limit: 40 }],
        },
        {
          instance_id: "two",
          user_id: "u2",
          region_domain: "api.eu-de.bob.ibm.com",
          teams: [{ id: "t2", budget_limit: 160 }],
        },
      ],
    };
    const snapshot = await ibmbob.fetchUsage(
      context(
        (_method, url, _options) =>
          url.pathname === "/admin/v1/profile"
            ? response(profile)
            : response({ usage: url.pathname.endsWith("/t1/users/u1") ? 10 : 25 }),
        { BOBSHELL_API_KEY: "fixture-key" },
        requests,
      ),
    );
    expect(requests.map((item) => item.url.host)).toEqual([
      "api.us-east.bob.ibm.com",
      "api.us-east.bob.ibm.com",
      "api.eu-de.bob.ibm.com",
    ]);
    expect(
      requests.every(
        (item) =>
          (item.options?.headers as Record<string, unknown>)?.Authorization ===
          "Apikey fixture-key",
      ),
    ).toBe(true);
    expect(snapshot).toMatchObject({
      primary: { usedPercent: 17.5, resetDescription: "35 / 200 Bobcoins" },
      identity: { organization: "Pro+", loginMethod: "API key" },
    });
    expect(
      (snapshot.details as Array<{ rows: Array<{ value: string }> }>)[0]?.rows.map(
        (row) => row.value,
      ),
    ).toEqual(["10 / 40 Bobcoins", "25 / 160 Bobcoins"]);
    await expect(
      ibmbob.fetchUsage(
        context(
          () =>
            response({
              instances: [
                {
                  instance_id: "one",
                  user_id: "u",
                  region_domain: "evil.example",
                  teams: [{ id: "t" }],
                },
              ],
            }),
          { BOBSHELL_API_KEY: "key" },
        ),
      ),
    ).rejects.toThrow("permission-denied:");
  });

  it("sends the OpenAI-compatible Doubao probe and handles missing credentials", async () => {
    const requests: Array<{ method: string; url: URL; options?: Record<string, unknown> }> = [];
    const snapshot = await doubao.fetchUsage(
      context(
        () => response({ usage: { total_tokens: 1 } }),
        { VOLCENGINE_API_KEY: "key" },
        requests,
      ),
    );
    expect(requests[0]?.url.pathname).toBe("/api/coding/v3/chat/completions");
    expect(requests[0]?.options).toMatchObject({
      method: "POST",
      body: { model: "doubao-seed-2.0-code", max_tokens: 1 },
    });
    expect(snapshot).toEqual({
      identity: { loginMethod: "API key" },
      details: [{ title: "Probe", rows: [{ label: "Total tokens", value: "1" }] }],
    });
    await expect(doubao.fetchUsage(context(() => response({}), {}))).rejects.toThrow(
      "missing-credential:",
    );
  });
});
