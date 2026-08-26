import { describe, expect, it } from "vite-plus/test";

import { bedrock } from "../src/providers/bedrock.ts";
import { copilot } from "../src/providers/copilot.ts";
import { minimax } from "../src/providers/minimax.ts";
import type { ProviderContext, ProviderResponse } from "../src/types.ts";

type Request = {
  readonly method: "GET" | "POST";
  readonly url: URL;
  readonly options?: Record<string, unknown>;
};
const now = new Date("2026-08-20T12:00:00.000Z");
const failure = (kind: string) => (message: string) => new Error(`${kind}: ${message}`);
const response = (json: unknown, status = 200): ProviderResponse => ({
  status,
  bodyText: JSON.stringify(json),
});

function context(
  fixture: (request: Request) => ProviderResponse,
  settings: Readonly<Record<string, string>>,
  requests: Request[] = [],
): ProviderContext {
  const request = async (
    method: Request["method"],
    url: string,
    options?: Record<string, unknown>,
  ) => {
    const value = { method, url: new URL(url), ...(options ? { options } : {}) };
    requests.push(value);
    return fixture(value);
  };
  return {
    settings: { get: (key) => settings[key], getSecret: (key) => settings[key] },
    http: {
      get: (url, options) => request("GET", url, options),
      getJSON: async (url, options) => {
        const value = await request("GET", url, options);
        return { ...value, json: JSON.parse(value.bodyText) as unknown };
      },
      postJSON: async (url, options) => {
        const value = await request("POST", url, options);
        return { ...value, json: JSON.parse(value.bodyText) as unknown };
      },
    },
    browser: { cookieHeader: async () => "HERTZ-SESSION=fixture" },
    env: {},
    date: {
      now: () => new Date(now),
      nowMillis: () => now.getTime(),
      iso: (value) => new Date(value).toISOString(),
      unixSeconds: (value) => new Date(value * 1_000).toISOString(),
      unixMillis: (value) => new Date(value).toISOString(),
      nextDailyReset: () => "2026-08-21T00:00:00.000Z",
    },
    format: {
      number: (value) => String(value),
      usd: (value) => `$${value}`,
      monthDay: () => "Aug 20",
    },
    pct: (used, limit) => (limit > 0 ? (used / limit) * 100 : 100),
    amountFromPercent: (used, limit) => (used / 100) * limit,
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

describe("Swift-derived complex cloud provider wave B", () => {
  it("preserves IDs and strategy names", () => {
    expect([bedrock, copilot, minimax].map((provider) => provider.descriptor.id)).toEqual([
      "bedrock",
      "copilot",
      "minimax",
    ]);
    expect([bedrock, copilot, minimax].map((provider) => provider.id)).toEqual([
      "bedrock.api",
      "copilot.api",
      "minimax.api",
    ]);
  });

  it("signs the Bedrock Cost Explorer request and maps Bedrock-only monthly spend", async () => {
    const requests: Request[] = [];
    const snapshot = await bedrock.fetchUsage(
      context(
        () =>
          response({
            ResultsByTime: [
              {
                Groups: [
                  { Keys: ["Amazon Bedrock"], Metrics: { UnblendedCost: { Amount: "12.50" } } },
                  { Keys: ["Amazon EC2"], Metrics: { UnblendedCost: { Amount: "9.25" } } },
                ],
              },
            ],
          }),
        {
          AWS_ACCESS_KEY_ID: "AKIAFIXTURE",
          AWS_SECRET_ACCESS_KEY: "fixture-secret",
          AWS_BEDROCK_MONTHLY_BUDGET: "50",
        },
        requests,
      ),
    );
    expect(requests[0]?.url.href).toBe("https://ce.us-east-1.amazonaws.com/");
    const firstRequest = requests[0];
    if (firstRequest === undefined) throw new Error("expected a Bedrock request");
    const firstHeaders = firstRequest.options?.headers as Record<string, string> | undefined;
    if (firstHeaders === undefined) throw new Error("expected signed Bedrock headers");
    expect(firstHeaders.Authorization).toContain(
      "Credential=AKIAFIXTURE/20260820/us-east-1/ce/aws4_request",
    );
    expect(snapshot).toEqual({
      primary: {
        usedPercent: 25,
        resetsAt: "2026-09-01T00:00:00.000Z",
        resetDescription: "Monthly budget",
      },
      cost: {
        used: 12.5,
        limit: 50,
        currency: "USD",
        period: "Monthly",
        resetsAt: "2026-09-01T00:00:00.000Z",
      },
      identity: { loginMethod: "Spend: $12.50 - Budget: $50.00" },
    });
  });

  it("uses the GitHub OAuth token and keeps chat-only Copilot quota in the secondary lane", async () => {
    const requests: Request[] = [];
    const snapshot = await copilot.fetchUsage(
      context(
        () =>
          response({
            copilot_plan: "business",
            quota_reset_date: "2026-08-31",
            quota_snapshots: {
              chat: { entitlement: 100, remaining: 25, percent_remaining: 25, credits_used: 75 },
            },
          }),
        { COPILOT_API_TOKEN: "oauth-token" },
        requests,
      ),
    );
    expect(requests[0]?.url.href).toBe("https://api.github.com/copilot_internal/user");
    expect(requests[0]?.options).toMatchObject({ headers: { Authorization: "token oauth-token" } });
    expect(snapshot).toEqual({
      secondary: { usedPercent: 75, resetsAt: "2026-08-31T00:00:00.000Z" },
      details: [
        {
          title: "Credits",
          rows: [{ label: "Credits used", value: "75", secondaryValue: "Quota reset" }],
        },
      ],
      identity: { loginMethod: "Business" },
    });
  });

  it("treats zero-entitlement Copilot billing placeholders as unmetered rather than fake zero usage", async () => {
    const snapshot = await copilot.fetchUsage(
      context(
        () =>
          response({
            token_based_billing: true,
            copilot_plan: "business",
            quota_snapshots: {
              premium_interactions: { entitlement: 0, remaining: 0, percent_remaining: 100 },
            },
          }),
        { COPILOT_API_TOKEN: "oauth-token" },
      ),
    );
    expect(snapshot).toEqual({ identity: { loginMethod: "Business" } });
  });

  it("retries the MiniMax China token-plan endpoint and treats count fields as remaining", async () => {
    const requests: Request[] = [];
    const snapshot = await minimax.fetchUsage(
      context(
        (request) => {
          if (request.url.hostname === "api.minimax.io") return response({}, 401);
          return response({
            current_subscribe_title: "Token Plan Pro",
            base_resp: { status_code: 0 },
            model_remains: [
              {
                model_name: "general",
                current_interval_total_count: 100,
                current_interval_usage_count: 25,
                start_time: 1787227200000,
                end_time: 1787245200000,
                current_weekly_total_count: 200,
                current_weekly_usage_count: 50,
                weekly_start_time: 1786646400000,
                weekly_end_time: 1787251200000,
              },
            ],
          });
        },
        { MINIMAX_API_TOKEN: "sk-cp-fixture" },
        requests,
      ),
    );
    expect(requests.map((request) => `${request.url.hostname}${request.url.pathname}`)).toEqual([
      "api.minimax.io/v1/token_plan/remains",
      "api.minimax.io/v1/api/openplatform/coding_plan/remains",
      "api.minimaxi.com/v1/token_plan/remains",
    ]);
    expect(snapshot).toMatchObject({
      primary: { usedPercent: 75, windowMinutes: 300 },
      secondary: { usedPercent: 75, windowMinutes: 10080 },
      identity: { loginMethod: "Token Plan Pro" },
    });
  });

  it("maps MiniMax data.services payloads and point balances", async () => {
    const snapshot = await minimax.fetchUsage(
      context(
        () =>
          response({
            base_resp: { status_code: 0 },
            data: {
              plan_name: "Coding Plan Enterprise",
              points_balance: 12.5,
              services: [
                {
                  service_type: "general",
                  window_type: "weekly",
                  usage: 20,
                  limit: 100,
                  percent: 20,
                },
              ],
            },
          }),
        { MINIMAX_API_TOKEN: "sk-cp-fixture" },
      ),
    );
    expect(snapshot).toMatchObject({
      primary: {
        usedPercent: 20,
        resetDescription: "20 / 100 general · weekly",
      },
      providerCost: {
        used: 12.5,
        limit: 0,
        currencyCode: "Points",
        period: "MiniMax points balance",
      },
      identity: { loginMethod: "Coding Plan Enterprise" },
    });
  });

  it("narrows MiniMax API fallback to authentication and HTTP 404", () => {
    const apiStrategy = minimax.strategies?.find((strategy) => strategy.id === "minimax.api");
    expect(apiStrategy?.fallbackOn).toEqual(["authentication-expired", "missing-credential"]);
    expect(apiStrategy?.fallbackWhen?.({ kind: "api-failure", message: "HTTP 404" })).toBe(true);
    expect(apiStrategy?.fallbackWhen?.({ kind: "api-failure", message: "HTTP 500" })).toBe(false);
    expect(apiStrategy?.fallbackWhen?.({ kind: "network-failure", message: "offline" })).toBe(
      false,
    );
  });

  it("tries the legacy MiniMax API endpoint after 404 but keeps HTTP 500 terminal", async () => {
    const fallbackRequests: Request[] = [];
    await minimax.fetchUsage(
      context(
        (request) =>
          request.url.pathname === "/v1/token_plan/remains"
            ? response({}, 404)
            : response({
                model_remains: [
                  {
                    model_name: "general",
                    current_interval_total_count: 100,
                    current_interval_usage_count: 25,
                  },
                ],
              }),
        { MINIMAX_CODING_API_KEY: "sk-cp-fixture" },
        fallbackRequests,
      ),
    );
    expect(fallbackRequests.map((request) => request.url.pathname)).toEqual([
      "/v1/token_plan/remains",
      "/v1/api/openplatform/coding_plan/remains",
    ]);

    const terminalRequests: Request[] = [];
    await expect(
      minimax.fetchUsage(
        context(
          () => response({}, 500),
          { MINIMAX_CODING_API_KEY: "sk-cp-fixture" },
          terminalRequests,
        ),
      ),
    ).rejects.toThrow("provider-unavailable: MiniMax API returned HTTP 500");
    expect(terminalRequests).toHaveLength(1);
  });
});
