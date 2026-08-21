import { describe, expect, it } from "vite-plus/test";

import {
  antigravity,
  antigravityQuotaSummaryHasUsableBucket,
  antigravityQuotaWindowMinutes,
  parseAntigravityQuotaSummary,
  parseAntigravityTokenClaims,
  parseAntigravityUserStatusIdentity,
  resolveAntigravityPlan,
} from "../src/providers/antigravity.ts";
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
const jwt = (payload: Record<string, unknown>): string => {
  const encoded = btoa(JSON.stringify(payload))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
  return `header.${encoded}.signature`;
};
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
      identity: {
        providerId: "claude",
        accountEmail: "user@example.com",
        loginMethod: "Claude Max",
      },
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
      identity: { providerId: "claude" },
    });
  });

  it("uses the Antigravity remote quota fallback after models access is denied", async () => {
    const calls: Request[] = [];
    const raw = await antigravity.fetchUsage(
      context(
        (request) => {
          calls.push(request);
          if (request.url.pathname.endsWith("loadCodeAssist"))
            return response({
              currentTier: { id: "free-tier", name: "pro" },
              cloudaicompanionProject: "project-1",
            });
          if (request.url.pathname.endsWith("fetchAvailableModels"))
            return response({ error: "denied" }, 403);
          return response({
            buckets: [
              { modelId: "gemini", remainingFraction: 0.8, resetTime: "2026-08-21T00:00:00Z" },
              { modelId: "claude", remainingFraction: 0.25, resetTime: "2026-08-22T00:00:00Z" },
            ],
          });
        },
        {
          ANTIGRAVITY_OAUTH_ACCESS_TOKEN: "fixture",
          ANTIGRAVITY_ID_TOKEN: jwt({ email: "owner@example.com", hd: "example.com" }),
          ANTIGRAVITY_ACCOUNT_EMAIL: "fallback@example.com",
        },
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
      identity: {
        providerId: "antigravity",
        accountEmail: "owner@example.com",
        loginMethod: "Workspace",
      },
    });
  });

  it("treats an empty manual local fixture as absent instead of shadowing OAuth", async () => {
    const calls: Request[] = [];
    await expect(
      antigravity.fetchUsage(
        context(
          (request) => {
            calls.push(request);
            if (request.url.pathname.endsWith("loadCodeAssist"))
              return response({ cloudaicompanionProject: "project" });
            return response({
              models: {
                gemini: {
                  displayName: "Gemini",
                  quotaInfo: { remainingFraction: 0.5 },
                },
              },
            });
          },
          {
            ANTIGRAVITY_LOCAL_QUOTA_JSON: "   ",
            ANTIGRAVITY_OAUTH_ACCESS_TOKEN: "fixture",
          },
        ),
      ),
    ).resolves.toMatchObject({ primary: { usedPercent: 50 } });
    expect(calls).toHaveLength(2);
  });

  it("ports Antigravity OAuth claims and plan-tier resolution fail-soft", () => {
    expect(parseAntigravityTokenClaims(jwt({ email: " person@example.com ", hd: "corp" }))).toEqual(
      { email: "person@example.com", hostedDomain: "corp" },
    );
    expect(parseAntigravityTokenClaims("not-a-jwt")).toEqual({});
    expect(resolveAntigravityPlan({ planInfo: { planType: "Ultra" } }, {})).toBe("Ultra");
    expect(resolveAntigravityPlan({ currentTier: { id: "standard-tier" } }, {})).toBe("Paid");
    expect(resolveAntigravityPlan({ currentTier: { id: "free-tier" } }, {})).toBe("Free");
    expect(
      resolveAntigravityPlan({ currentTier: { id: "free-tier" } }, { hostedDomain: "example.com" }),
    ).toBe("Workspace");
    expect(resolveAntigravityPlan({ currentTier: { id: "legacy-tier" } }, {})).toBe("Legacy");
  });

  it("ports local GetUserStatus identity precedence and merges it into quota usage", async () => {
    const userStatus = {
      userStatus: {
        email: " local@example.com ",
        userTier: { name: " Ultra " },
        planStatus: { planInfo: { planDisplayName: "Pro" } },
      },
    };
    expect(parseAntigravityUserStatusIdentity(userStatus)).toEqual({
      accountEmail: "local@example.com",
      loginMethod: "Ultra",
    });
    expect(
      parseAntigravityUserStatusIdentity({
        userStatus: { planStatus: { planInfo: { productName: "Workspace" } } },
      }),
    ).toEqual({ loginMethod: "Workspace" });

    const raw = await antigravity.fetchUsage(
      context(() => response({}), {
        ANTIGRAVITY_LOCAL_QUOTA_JSON: JSON.stringify({
          groups: [
            {
              displayName: "Gemini",
              buckets: [
                {
                  bucketId: "gemini-session",
                  displayName: "5-hour",
                  remainingFraction: 0.75,
                },
              ],
            },
          ],
        }),
        ANTIGRAVITY_LOCAL_USER_STATUS_JSON: JSON.stringify(userStatus),
      }),
    );
    expect(raw.identity).toEqual({
      providerId: "antigravity",
      accountEmail: "local@example.com",
      loginMethod: "Ultra",
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
                    bucketId: "gemini-other",
                    displayName: "Other",
                    remaining: { remainingFraction: 0.1 },
                  },
                  {
                    bucketId: "gemini-weekly",
                    displayName: "Weekly",
                    remaining: { case: "remainingFraction", value: 0.4 },
                  },
                  {
                    bucketId: "gemini-session",
                    displayName: "5-hour limit",
                    remaining: { remainingFraction: 0.6 },
                  },
                  {
                    bucketId: "gemini-disabled",
                    displayName: "Disabled",
                    remainingFraction: 0.01,
                    disabled: true,
                  },
                  {
                    bucketId: "gemini-unknown",
                    displayName: "Unknown",
                  },
                ],
              },
              {
                displayName: "Claude and GPT models",
                buckets: [
                  {
                    bucketId: "third-party-weekly",
                    displayName: "Weekly Limit",
                    remainingFraction: 0.75,
                    description: "resets later",
                  },
                ],
              },
            ],
          },
        },
        context(() => response({})),
      ),
    ).toMatchObject({
      primary: { usedPercent: 90 },
      secondary: { usedPercent: 25, windowMinutes: 10_080, resetDescription: "resets later" },
      extraRateWindows: [
        {
          id: "antigravity-quota-summary-gemini-session",
          title: "Gemini 5-hour",
          window: { windowMinutes: 300 },
        },
        {
          id: "antigravity-quota-summary-gemini-weekly",
          title: "Gemini weekly",
          window: { windowMinutes: 10_080 },
        },
        { id: "antigravity-quota-summary-gemini-other", title: "Gemini Other" },
        { id: "antigravity-quota-summary-gemini-disabled", usageKnown: false },
        { id: "antigravity-quota-summary-gemini-unknown", usageKnown: false },
        {
          id: "antigravity-quota-summary-third-party-weekly",
          title: "Claude/GPT weekly",
        },
      ],
      identity: { providerId: "antigravity" },
    });
  });

  it("admits the modern local summary only when Swift would find a usable bucket", async () => {
    expect(
      antigravityQuotaSummaryHasUsableBucket({
        groups: [
          {
            buckets: [
              { bucketId: "disabled", remainingFraction: 0.5, disabled: true },
              { bucketId: "unknown" },
            ],
          },
        ],
      }),
    ).toBe(false);
    expect(
      antigravityQuotaSummaryHasUsableBucket({
        groups: [{ buckets: [{ bucketId: "known", remaining: { remainingFraction: 0.5 } }] }],
      }),
    ).toBe(true);
    await expect(
      antigravity.fetchUsage(
        context(() => response({}), {
          ANTIGRAVITY_LOCAL_QUOTA_JSON: JSON.stringify({
            groups: [{ buckets: [{ bucketId: "unknown", disabled: false }] }],
          }),
        }),
      ),
    ).rejects.toThrow("parse-failure");
  });

  it("matches Swift quota cadence aliases and rejects unrelated model labels", () => {
    expect(antigravityQuotaWindowMinutes("gemini_5h", "Gemini")).toBe(300);
    expect(antigravityQuotaWindowMinutes("bucket", "Five-hour limit")).toBe(300);
    expect(antigravityQuotaWindowMinutes("claude-weekly", "Claude")).toBe(10_080);
    expect(antigravityQuotaWindowMinutes("gemini-3", "Gemini 3")).toBeUndefined();
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
