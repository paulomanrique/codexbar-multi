import { describe, expect, it } from "vite-plus/test";

import { antigravity, parseAntigravityQuotaSummary } from "../src/providers/antigravity.ts";
import { claude, parseClaudeCLIUsage, parseClaudeUsage } from "../src/providers/claude.ts";
import type { ProviderContext, ProviderResponse } from "../src/types.ts";

type Request = {
  readonly method: "GET" | "POST";
  readonly url: URL;
  readonly options?: Record<string, unknown>;
};
const failure = (kind: string) => (message: string) => new Error(`${kind}: ${message}`);
const response = (json: unknown, status = 200): ProviderResponse => ({
  status,
  bodyText: JSON.stringify(json),
});
const context = (
  handler: (request: Request) => ProviderResponse,
  settings: Record<string, string> = {},
): ProviderContext => {
  const request = async (method: "GET" | "POST", url: string, options?: Record<string, unknown>) =>
    handler({ method, url: new URL(url), ...(options ? { options } : {}) });
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
      nextDailyReset: () => "",
    },
    format: { number: String, usd: (value) => `$${value}`, monthDay: () => "" },
    pct: (used, limit) => (used / limit) * 100,
    amountFromPercent: (percent, limit) => (percent / 100) * limit,
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
};

describe("Claude and Antigravity Swift-derived parity", () => {
  it("retains the upstream provider IDs and capability boundary", () => {
    expect([claude, antigravity].map((provider) => provider.descriptor.id)).toEqual([
      "claude",
      "antigravity",
    ]);
    expect(claude.descriptor.cookieDomains).toEqual(["claude.ai"]);
    expect(antigravity.descriptor.endpoints).toContain("https://cloudcode-pa.googleapis.com");
  });

  it("maps the Claude CLI fixture's session, weekly and scoped weekly windows", () => {
    const raw = parseClaudeCLIUsage(
      JSON.stringify({
        ok: true,
        account_email: "user@example.com",
        login_method: "Claude Max",
        session_5h: { pct_used: 7, resets: "11am (Europe/Vienna)" },
        week_all_models: { pct_used: 21, resets: "Nov 21 at 5am (Europe/Vienna)" },
        week_sonnet: { pct_used: 3, resets: "Nov 21 at 5am (Europe/Vienna)" },
      }),
      context(() => response({})),
    );
    expect(raw).toMatchObject({
      primary: { usedPercent: 7, windowMinutes: 300, resetDescription: "11am (Europe/Vienna)" },
      secondary: { usedPercent: 21, windowMinutes: 10_080 },
      tertiary: { usedPercent: 3, windowMinutes: 10_080 },
      identity: { accountEmail: "user@example.com", loginMethod: "Claude Max" },
    });
  });

  it("preserves Claude OAuth beta request and normalizes minor-unit extra usage", async () => {
    const calls: Request[] = [];
    const raw = await claude.fetchUsage(
      context(
        (request) => {
          calls.push(request);
          return response({
            five_hour: { utilization: 30, resets_at: "2026-08-20T15:00:00Z" },
            seven_day: { utilization: 42, resets_at: "2026-08-27T12:00:00Z" },
            extra_usage: { used_credits: 1234, monthly_limit: 5000, currency: "USD" },
          });
        },
        { CLAUDE_OAUTH_ACCESS_TOKEN: "fixture" },
      ),
    );
    expect(calls[0]?.options).toMatchObject({
      headers: { Authorization: "Bearer fixture", "anthropic-beta": "oauth-2025-04-20" },
    });
    expect(raw).toMatchObject({
      primary: { usedPercent: 30, resetsAt: "2026-08-20T15:00:00.000Z" },
      secondary: { usedPercent: 42 },
      providerCost: { used: 12.34, limit: 50, currencyCode: "USD" },
    });
  });

  it("uses the Antigravity remote quota fallback after models access is denied", async () => {
    const calls: Request[] = [];
    const raw = await antigravity.fetchUsage(
      context(
        (request) => {
          calls.push(request);
          if (request.url.pathname.endsWith("loadCodeAssist"))
            return response({ currentTier: { name: "pro" }, cloudaicompanionProject: "project-1" });
          if (request.url.pathname.endsWith("fetchAvailableModels"))
            return response({ error: "denied" }, 403);
          return response({
            buckets: [
              { modelId: "gemini", remainingFraction: 0.8, resetTime: "2026-08-21T00:00:00Z" },
              { modelId: "claude", remainingFraction: 0.25, resetTime: "2026-08-22T00:00:00Z" },
            ],
          });
        },
        { ANTIGRAVITY_OAUTH_ACCESS_TOKEN: "fixture" },
      ),
    );
    expect(calls.map((call) => call.url.pathname)).toEqual([
      "/v1internal:loadCodeAssist",
      "/v1internal:fetchAvailableModels",
      "/v1internal:retrieveUserQuota",
    ]);
    expect(calls[1]?.options).toMatchObject({
      headers: { Authorization: "Bearer fixture" },
      body: { project: "project-1" },
    });
    expect(raw).toMatchObject({
      primary: { usedPercent: 75 },
      extraRateWindows: [
        { id: "antigravity-quota-summary-gemini", window: { usedPercent: 19.999999999999996 } },
        { id: "antigravity-quota-summary-claude", window: { usedPercent: 75 } },
      ],
      identity: { loginMethod: "pro" },
    });
  });

  it("ports the local quota-summary parser without exposing process or socket APIs", () => {
    expect(
      parseAntigravityQuotaSummary(
        {
          response: {
            groups: [
              {
                displayName: "Gemini",
                buckets: [
                  {
                    bucketId: "gemini-3",
                    displayName: "Gemini 3",
                    remaining: { remainingFraction: 0.6 },
                  },
                ],
              },
            ],
          },
        },
        context(() => response({})),
      ),
    ).toMatchObject({
      primary: { usedPercent: 40 },
      extraRateWindows: [{ id: "antigravity-quota-summary-gemini-3", title: "Gemini: Gemini 3" }],
    });
  });

  it("keeps classified missing-credential and parse failures", async () => {
    await expect(antigravity.fetchUsage(context(() => response({})))).rejects.toThrow(
      "missing-credential",
    );
    expect(() =>
      parseClaudeUsage(
        {},
        context(() => response({})),
      ),
    ).toThrow("parse-failure");
  });
});
