import { describe, expect, it } from "vite-plus/test";

import { litellm } from "../src/providers/litellm.ts";
import { wayfinder } from "../src/providers/wayfinder.ts";
import { zenmux } from "../src/providers/zenmux.ts";
import type { ProviderContext, ProviderResponse } from "../src/types.ts";

const now = new Date("2026-08-20T12:00:00.000Z");
type Request = {
  readonly method: "GET" | "POST";
  readonly url: URL;
  readonly options?: Record<string, unknown>;
};
type Fixture = (request: Request) => ProviderResponse;
const failure = (kind: string) => (message: string) => new Error(`${kind}: ${message}`);

function context(
  fixture: Fixture,
  settings: Readonly<Record<string, string>>,
  requests: Request[] = [],
): ProviderContext {
  const request = async (
    method: Request["method"],
    url: string,
    options?: Record<string, unknown>,
  ) => {
    const value = { method, url: new URL(url), ...(options === undefined ? {} : { options }) };
    requests.push(value);
    return fixture(value);
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
      number: (value) => String(value),
      usd: (value) =>
        `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      monthDay: () => "Aug 20",
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

const response = (body: unknown, status = 200): ProviderResponse => ({
  status,
  bodyText: JSON.stringify(body),
});

describe("Swift-derived LiteLLM, ZenMux, and Wayfinder parity", () => {
  it("keeps the provider and strategy IDs aligned with upstream", () => {
    expect([litellm, zenmux, wayfinder].map((provider) => provider.descriptor.id)).toEqual([
      "litellm",
      "zenmux",
      "wayfinder",
    ]);
    expect([litellm, zenmux, wayfinder].map((provider) => provider.id)).toEqual([
      "litellm.api",
      "zenmux.api",
      "wayfinder.api",
    ]);
  });

  it("uses LiteLLM virtual-key metadata to select the matching user and team budget", async () => {
    const requests: Request[] = [];
    const snapshot = await litellm.fetchUsage(
      context(
        (request) => {
          if (request.url.pathname === "/key/info")
            return response({
              info: {
                key_name: "sk-...IAAw",
                user_id: "user-123",
                team_id: "team-456",
                expires: "2026-09-11T00:12:55.950Z",
              },
            });
          if (request.url.pathname === "/user/info")
            return response({
              user_id: "user-123",
              user_info: {
                user_id: "user-123",
                user_email: "litellm-user@example.com",
                max_budget: 300,
                spend: 212.35371625,
              },
              teams: [
                { team_alias: "unrelated", team_id: "other", max_budget: 5, spend: 4 },
                {
                  team_alias: "ai",
                  team_id: "team-456",
                  max_budget: 1_000,
                  spend: 215.32456585,
                  budget_reset_at: "2026-06-15T00:00:00Z",
                },
              ],
            });
          throw new Error(`Unexpected request ${request.url}`);
        },
        { LITELLM_API_KEY: "  'sk-test' ", LITELLM_BASE_URL: "https://litellm.example.com/v1" },
        requests,
      ),
    );
    expect(requests.map((request) => request.url.href)).toEqual([
      "https://litellm.example.com/key/info",
      "https://litellm.example.com/user/info?user_id=user-123",
    ]);
    expect(
      requests.every((request) => {
        const headers = request.options?.headers as Record<string, string> | undefined;
        return headers?.Authorization === "Bearer sk-test";
      }),
    ).toBe(true);
    expect(snapshot).toEqual({
      primary: { usedPercent: (212.35371625 / 300) * 100, resetDescription: "$212.35 / $300.00" },
      secondary: {
        usedPercent: (215.32456585 / 1_000) * 100,
        resetsAt: "2026-06-15T00:00:00.000Z",
        resetDescription: "Team ai: $215.32 / $1,000.00",
      },
      providerCost: { used: 212.35371625, limit: 300, currency: "USD", period: "Personal budget" },
      subscriptionExpiresAt: "2026-09-11T00:12:55.950Z",
      identity: { email: "litellm-user@example.com", organization: "ai", loginMethod: "api" },
      dataConfidence: "exact",
    });
  });

  it("preserves LiteLLM team-only virtual-key usage and rejects a mismatched team", async () => {
    const snapshot = await litellm.fetchUsage(
      context(
        (request) =>
          request.url.pathname === "/key/info"
            ? response({ info: { team_id: "team-456" } })
            : response({
                team_id: "team-456",
                team_info: {
                  team_alias: "platform",
                  team_id: "team-456",
                  max_budget: 100,
                  spend: 25,
                },
              }),
        { LITELLM_API_KEY: "sk-team", LITELLM_BASE_URL: "https://litellm.example.com" },
      ),
    );
    expect(snapshot).toEqual({
      secondary: { usedPercent: 25, resetDescription: "Team platform: $25.00 / $100.00" },
      providerCost: { used: 25, limit: 100, currency: "USD", period: "Team budget" },
      identity: { organization: "platform", loginMethod: "api" },
      dataConfidence: "exact",
    });
    await expect(
      litellm.fetchUsage(
        context(
          (request) =>
            request.url.pathname === "/key/info"
              ? response({ info: { team_id: "expected" } })
              : response({ team_info: { team_id: "different" } }),
          { LITELLM_API_KEY: "sk-team", LITELLM_BASE_URL: "https://litellm.example.com" },
        ),
      ),
    ).rejects.toThrow("parse-failure: LiteLLM team_id did not match /key/info.");
  });

  it("maps ZenMux quota windows and retains the subscription when optional PAYG fails", async () => {
    const requests: Request[] = [];
    const subscription = {
      success: true,
      data: {
        plan: { tier: "ultra", expires_at: "2026-04-12T08:26:56.000Z" },
        account_status: "healthy",
        quota_5_hour: {
          usage_percentage: 0.0715,
          resets_at: "2026-03-24T08:35:09.000Z",
          max_flows: 800,
          used_flows: 57.2,
        },
        quota_7_day: {
          usage_percentage: 0.0673,
          resets_at: "2026-03-26T02:15:05.000Z",
          max_flows: 6_182,
          used_flows: 416.11,
        },
      },
    };
    const snapshot = await zenmux.fetchUsage(
      context(
        (request) => {
          if (request.url.pathname.endsWith("subscription/detail")) return response(subscription);
          return response({ success: true, data: { currency: "usd", total_credits: 482.74 } });
        },
        { ZENMUX_MANAGEMENT_API_KEY: " 'management-key' " },
        requests,
      ),
    );
    expect(requests.map((request) => request.url.href)).toEqual([
      "https://zenmux.ai/api/v1/management/subscription/detail",
      "https://zenmux.ai/api/v1/management/payg/balance",
    ]);
    expect(snapshot).toMatchObject({
      primary: {
        windowMinutes: 300,
        resetsAt: "2026-03-24T08:35:09.000Z",
        resetDescription: "57.20 / 800 flows",
      },
      secondary: {
        windowMinutes: 10_080,
        resetsAt: "2026-03-26T02:15:05.000Z",
        resetDescription: "416.11 / 6182 flows",
      },
      providerCost: { used: 482.74, limit: 0, currency: "USD", period: "ZenMux PAYG balance" },
      subscriptionExpiresAt: "2026-04-12T08:26:56.000Z",
      identity: { loginMethod: "Ultra plan" },
      dataConfidence: "exact",
    });
    expect((snapshot.primary as { usedPercent: number }).usedPercent).toBeCloseTo(7.15, 8);
    expect((snapshot.secondary as { usedPercent: number }).usedPercent).toBeCloseTo(6.73, 8);
    const noBalance = await zenmux.fetchUsage(
      context(
        (request) =>
          request.url.pathname.endsWith("subscription/detail")
            ? response(subscription)
            : response({}, 500),
        { ZENMUX_MANAGEMENT_API_KEY: "management-key" },
      ),
    );
    expect(noBalance).toMatchObject({ identity: { loginMethod: "Ultra plan" } });
    expect((noBalance.primary as { usedPercent: number }).usedPercent).toBeCloseTo(7.15, 8);
    expect(noBalance).not.toHaveProperty("providerCost");
  });

  it("does not hide a rejected ZenMux management credential", async () => {
    await expect(
      zenmux.fetchUsage(
        context(() => response({ error: "unauthorized" }, 401), {
          ZENMUX_MANAGEMENT_API_KEY: "wrong",
        }),
      ),
    ).rejects.toThrow("authentication-expired: ZenMux rejected the Management API key.");
  });

  it("consolidates Wayfinder health, models, savings and optional Prometheus metrics", async () => {
    const requests: Request[] = [];
    const snapshot = await wayfinder.fetchUsage(
      context(
        (request) => {
          if (request.url.pathname === "/healthz")
            return response({
              status: "degraded",
              offline: false,
              missing_keys: ["OPENAI", "ANTHROPIC"],
            });
          if (request.url.pathname === "/router/models")
            return response({ dry_run: false, models: [{ name: "a" }, { name: "b" }] });
          if (request.url.pathname === "/v1/savings")
            return response({
              priced: true,
              requests: 14,
              tokens: 400,
              realized: 1,
              baseline: 5.12,
              saved: 4.12,
              saved_pct: 80.46875,
              by_route: {
                local: { requests: 10, saved: 2, tokens: 100 },
                cloud: { requests: 4, saved: 2.12, tokens: 300 },
              },
            });
          if (request.url.pathname === "/metrics")
            return {
              status: 200,
              bodyText:
                "wayfinder_router_decision_latency_seconds_sum 1.25\nwayfinder_router_decision_latency_seconds_count 10\n",
            };
          throw new Error(`Unexpected request ${request.url}`);
        },
        { WAYFINDER_GATEWAY_URL: "http://127.0.0.1:8088" },
        requests,
      ),
    );
    expect(requests.map((request) => request.url.href)).toEqual([
      "http://127.0.0.1:8088/healthz",
      "http://127.0.0.1:8088/router/models",
      "http://127.0.0.1:8088/v1/savings?period=30d",
      "http://127.0.0.1:8088/metrics",
    ]);
    expect(snapshot).toEqual({
      details: [
        {
          title: "Usage",
          rows: [
            { label: "Gateway", value: "degraded · 2 models" },
            { label: "Routed", value: "local: 10 · cloud: 4" },
            { label: "Saved", value: "$4.12 · 80.5% vs highest-cost route" },
            { label: "Avg decision", value: "125.0 ms" },
          ],
        },
      ],
      identity: {
        organization: "2 models · local gateway",
        loginMethod: "Degraded — 2 keys missing",
      },
      dataConfidence: "exact",
    });
    await expect(
      wayfinder.fetchUsage(
        context(() => response({}), { WAYFINDER_GATEWAY_URL: "http://remote.example.test" }),
      ),
    ).rejects.toThrow(
      "api-failure: WAYFINDER_GATEWAY_URL must be HTTPS, or HTTP only for a loopback gateway.",
    );
  });
});
