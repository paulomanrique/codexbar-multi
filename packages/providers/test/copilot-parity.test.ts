import { describe, expect, it } from "vite-plus/test";

import {
  extraRateWindowsFromBudgets,
  extractFetchNonce,
  extractGitHubWebIdentity,
  fetchCopilotBudgetWindows,
  parseBudget,
  parseBudgetAmount,
  parseBudgetResponse,
  webIdentityMatches,
  normalizedBillingIdentifier,
} from "../src/providers/copilot-budgets.ts";
import {
  apiHost,
  budgetCookieHeaderOverride,
  copilot,
  normalizeCookieHeader,
} from "../src/providers/copilot.ts";
import {
  makeRateWindow,
  mapCopilotUsage,
  parseCopilotUsageModel,
  parseQuotaResetDate,
} from "../src/providers/copilot-usage.ts";
import type { ProviderContext, ProviderResponse } from "../src/types.ts";

type Request = {
  readonly method: "GET" | "POST";
  readonly url: URL;
  readonly options?: Record<string, unknown>;
};

const now = new Date("2026-08-20T12:00:00.000Z");
const failure = (kind: string) => (message: string) => new Error(`${kind}: ${message}`);
const jsonResponse = (body: unknown, status = 200): ProviderResponse => ({
  status,
  bodyText: JSON.stringify(body),
});
const textResponse = (bodyText: string, status = 200): ProviderResponse => ({ status, bodyText });

const usagePayload = {
  copilot_plan: "pro",
  quota_snapshots: {
    premium_interactions: {
      entitlement: 300,
      remaining: 240,
      percent_remaining: 80,
      quota_id: "premium",
    },
  },
};

type CookieHeader = string | Readonly<Record<string, string>>;

function context(
  fixture: (request: Request) => ProviderResponse,
  settings: Readonly<Record<string, string>> = {},
  requests: Request[] = [],
  cookieHeader: CookieHeader = "user_session=matching",
  cookieLookups: string[] = [],
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
    browser: {
      cookieHeader: async (domain) => {
        cookieLookups.push(domain);
        if (typeof cookieHeader === "string") {
          if (cookieHeader === "") throw new Error(`unexpected cookie import for ${domain}`);
          return cookieHeader;
        }
        if (!Object.hasOwn(cookieHeader, domain)) {
          throw new Error(`undeclared cookie domain ${domain}`);
        }
        return cookieHeader[domain] ?? "";
      },
    },
    env: { timeZone: "UTC" },
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

const tokenSettings = { COPILOT_API_TOKEN: "oauth-token" };

describe("Swift-derived Copilot usage parser", () => {
  it("decodes quota snapshots and capitalizes the plan", () => {
    const model = parseCopilotUsageModel({
      copilot_plan: "free",
      assigned_date: "2025-01-01",
      quota_reset_date: "2025-02-01",
      quota_snapshots: {
        premium_interactions: {
          entitlement: 500,
          remaining: 450,
          percent_remaining: 90,
          quota_id: "premium_interactions",
        },
        chat: { entitlement: 300, remaining: 150, percent_remaining: 50, quota_id: "chat" },
      },
    });
    expect(model.premium?.remaining).toBe(450);
    expect(model.chat?.remaining).toBe(150);
    expect(model.copilotPlan).toBe("free");
  });

  it("keeps chat-only snapshots in the chat lane", () => {
    const model = parseCopilotUsageModel({
      copilot_plan: "free",
      quota_snapshots: {
        chat: { entitlement: 200, remaining: 75, percent_remaining: 37.5, quota_id: "chat" },
      },
    });
    expect(model.premium).toBeUndefined();
    expect(model.chat?.quotaId).toBe("chat");
    expect(model.chat?.entitlement).toBe(200);
  });

  it("builds monthly fallback only when both monthly and limited values exist", () => {
    expect(
      parseCopilotUsageModel({
        copilot_plan: "free",
        monthly_quotas: { chat: 500, completions: 300 },
      }).chat,
    ).toBeUndefined();
    const mixed = parseCopilotUsageModel({
      copilot_plan: "free",
      monthly_quotas: { chat: 500, completions: 300 },
      limited_user_quotas: { completions: 60 },
    });
    expect(mixed.premium?.quotaId).toBe("completions");
    expect(mixed.premium?.percentRemaining).toBe(20);
    expect(mixed.chat).toBeUndefined();
  });

  it("merges a partial direct snapshot with monthly completions", () => {
    const model = parseCopilotUsageModel({
      copilot_plan: "free",
      quota_snapshots: {
        chat: { entitlement: 200, remaining: 75, percent_remaining: 37.5, quota_id: "chat" },
      },
      monthly_quotas: { chat: 500, completions: 300 },
      limited_user_quotas: { chat: 125, completions: 60 },
    });
    expect(model.chat?.entitlement).toBe(200);
    expect(model.premium?.quotaId).toBe("completions");
    expect(model.premium?.remaining).toBe(60);
  });

  it("maps unknown quota keys onto the chat fallback lane", () => {
    const model = parseCopilotUsageModel({
      copilot_plan: "free",
      quota_snapshots: {
        mystery_bucket: {
          entitlement: 100,
          remaining: 40,
          percent_remaining: 40,
          quota_id: "mystery_bucket",
        },
      },
    });
    expect(model.premium).toBeUndefined();
    expect(model.chat?.quotaId).toBe("mystery_bucket");
  });

  it("ignores a placeholder known snapshot when selecting an unknown key", () => {
    const model = parseCopilotUsageModel({
      copilot_plan: "free",
      quota_snapshots: {
        premium_interactions: {},
        mystery_bucket: {
          entitlement: 100,
          remaining: 40,
          percent_remaining: 40,
          quota_id: "mystery_bucket",
        },
      },
    });
    expect(model.premium).toBeUndefined();
    expect(model.chat?.quotaId).toBe("mystery_bucket");
    expect(model.chat?.hasPercentRemaining).toBe(true);
  });

  it("derives percent remaining and over-quota used percent", () => {
    const derived = parseCopilotUsageModel({
      copilot_plan: "free",
      quota_snapshots: { chat: { entitlement: 120, remaining: 30, quota_id: "chat" } },
    });
    expect(derived.chat?.percentRemaining).toBe(25);
    const over = parseCopilotUsageModel({
      copilot_plan: "paid",
      quota_snapshots: {
        premium_interactions: {
          entitlement: 500,
          remaining: -75,
          percent_remaining: -15,
          quota_id: "premium_interactions",
        },
      },
    });
    const window = makeRateWindow(over.premium, undefined);
    expect(window?.usedPercent).toBe(115);
    expect(window?.resetDescription).toBe("115% used");
    const fromRemaining = parseCopilotUsageModel({
      copilot_plan: "paid",
      quota_snapshots: { chat: { entitlement: 500, remaining: -75, quota_id: "chat" } },
    });
    expect(fromRemaining.chat?.percentRemaining).toBe(-15);
  });

  it("does not invent a percent when entitlement or remaining is missing", () => {
    expect(
      parseCopilotUsageModel({
        copilot_plan: "free",
        quota_snapshots: { chat: { remaining: 30, quota_id: "chat" } },
      }).chat?.hasPercentRemaining,
    ).toBe(false);
    expect(
      parseCopilotUsageModel({
        copilot_plan: "free",
        quota_snapshots: { chat: { entitlement: 120, quota_id: "chat" } },
      }).chat?.hasPercentRemaining,
    ).toBe(false);
  });

  it("falls back to monthly when the direct snapshot cannot compute percent", () => {
    const model = parseCopilotUsageModel({
      copilot_plan: "free",
      quota_snapshots: { chat: { entitlement: 120, quota_id: "chat" } },
      monthly_quotas: { chat: 400 },
      limited_user_quotas: { chat: 100 },
    });
    expect(model.chat?.entitlement).toBe(400);
    expect(model.chat?.percentRemaining).toBe(25);
  });

  it("skips a zero monthly denominator", () => {
    const model = parseCopilotUsageModel({
      copilot_plan: "free",
      monthly_quotas: { chat: 0 },
      limited_user_quotas: { chat: 0 },
    });
    expect(model.premium).toBeUndefined();
    expect(model.chat).toBeUndefined();
  });

  it("drops business token-billing placeholders without credits", () => {
    const model = parseCopilotUsageModel({
      copilot_plan: "business",
      token_based_billing: true,
      quota_snapshots: {
        premium_interactions: {
          entitlement: 0,
          remaining: 0,
          percent_remaining: 100,
          quota_id: "premium_interactions",
        },
        chat: { entitlement: 0, remaining: 0, percent_remaining: 100, quota_id: "chat" },
        completions: {
          entitlement: 0,
          remaining: 0,
          percent_remaining: 100,
          quota_id: "completions",
        },
      },
    });
    expect(model.tokenBasedBilling).toBe(true);
    expect(model.premium).toBeUndefined();
    expect(model.chat).toBeUndefined();
  });

  it("keeps unlimited chat and does not treat it as a placeholder", () => {
    const model = parseCopilotUsageModel({
      copilot_plan: "individual",
      quota_snapshots: {
        premium_interactions: {
          entitlement: 200,
          remaining: 191,
          percent_remaining: 95.5,
          quota_id: "premium_interactions",
        },
        chat_messages: {
          entitlement: 0,
          remaining: 0,
          quota_id: "chat_messages",
          unlimited: true,
        },
      },
    });
    expect(model.premium?.quotaId).toBe("premium_interactions");
    expect(model.chat?.quotaId).toBe("chat_messages");
    expect(model.chat?.unlimited).toBe(true);
    expect(makeRateWindow(model.chat, undefined)).toBeUndefined();
  });

  it("unlimited quota overrides a placeholder percent remaining", () => {
    const chat = parseCopilotUsageModel({
      copilot_plan: "individual",
      quota_snapshots: {
        chat: {
          entitlement: 0,
          remaining: 0,
          percent_remaining: 0,
          quota_id: "chat",
          unlimited: true,
        },
      },
    }).chat;
    expect(chat?.percentRemaining).toBe(100);
    expect(makeRateWindow(chat, undefined)).toBeUndefined();
  });

  it("keeps a credit counter on placeholders and monthly fallbacks", () => {
    const placeholder = parseCopilotUsageModel({
      copilot_plan: "business",
      token_based_billing: true,
      quota_snapshots: {
        premium_interactions: {
          entitlement: 0,
          remaining: 0,
          percent_remaining: 100,
          quota_id: "premium_interactions",
          credits_used: 31,
        },
      },
    });
    expect(placeholder.premium?.creditsUsed).toBe(31);
    expect(makeRateWindow(placeholder.premium, undefined)).toBeUndefined();

    const fallback = parseCopilotUsageModel({
      copilot_plan: "business",
      token_based_billing: true,
      monthly_quotas: { completions: 300 },
      limited_user_quotas: { completions: 75 },
      quota_snapshots: {
        premium_interactions: {
          entitlement: 0,
          remaining: 0,
          percent_remaining: 100,
          quota_id: "premium_interactions",
          credits_used: 31,
        },
      },
    });
    expect(fallback.premium?.creditsUsed).toBe(31);
    expect(fallback.premium?.quotaId).toBe("completions");
    expect(makeRateWindow(fallback.premium, undefined)?.usedPercent).toBe(75);
  });

  it("keeps a fully consumed positive entitlement as 100% used", () => {
    const model = parseCopilotUsageModel({
      copilot_plan: "individual",
      quota_snapshots: {
        premium_interactions: {
          entitlement: 500,
          remaining: 0,
          percent_remaining: 0,
          quota_id: "premium_interactions",
        },
      },
    });
    expect(makeRateWindow(model.premium, undefined)?.usedPercent).toBe(100);
  });

  it("keeps percent-only quota snapshots", () => {
    const model = parseCopilotUsageModel({
      copilot_plan: "business",
      quota_snapshots: { chat: { percent_remaining: 40, quota_id: "chat" } },
    });
    expect(makeRateWindow(model.chat, undefined)?.usedPercent).toBe(60);
  });

  it("parses date-only and ISO quota reset timestamps", () => {
    const ctx = context(() => jsonResponse({}));
    expect(parseQuotaResetDate(ctx, "2026-07-01")).toBe("2026-07-01T00:00:00.000Z");
    expect(parseQuotaResetDate(ctx, "2026-07-01T08:30:45Z")).toBe("2026-07-01T08:30:45.000Z");
    expect(parseQuotaResetDate(ctx, "2026-07-01T08:30:45.123Z")).toBe("2026-07-01T08:30:45.123Z");
    expect(parseQuotaResetDate(ctx, " ")).toBeUndefined();
  });
});

describe("Swift-derived Copilot budget extras", () => {
  it("normalizes documented Copilot billing names", () => {
    expect(normalizedBillingIdentifier("Copilot")).toBe("copilot");
    expect(normalizedBillingIdentifier("Copilot Premium Request")).toBe("copilot_premium_request");
    expect(normalizedBillingIdentifier("Copilot Agent Premium Request")).toBe(
      "copilot_agent_premium_request",
    );
    expect(normalizedBillingIdentifier("Spark Premium Request")).toBe("spark_premium_request");
    expect(normalizedBillingIdentifier("Premium requests")).toBe("copilot_premium_request");
    expect(normalizedBillingIdentifier("Bundled premium request budget")).toBe(
      "copilot_premium_request",
    );
    expect(normalizedBillingIdentifier("Copilot cloud agent premium requests")).toBe(
      "copilot_agent_premium_request",
    );
    expect(normalizedBillingIdentifier("coding_agent_premium_request")).toBe(
      "copilot_agent_premium_request",
    );
  });

  it("maps positive Copilot budgets to extra rate windows and drops zero amounts", () => {
    const windows = extraRateWindowsFromBudgets(
      [
        {
          id: "product-budget",
          budgetProductSkus: ["copilot"],
          budgetAmount: 100,
          currentAmount: 15,
        },
        {
          id: "agent-budget",
          budgetProductSkus: ["copilot_agent_premium_request"],
          budgetAmount: 20,
          currentAmount: 5,
        },
        {
          id: "zero-budget",
          budgetProductSkus: ["spark_premium_request"],
          budgetAmount: 0,
          currentAmount: 0,
        },
      ],
      context(() => jsonResponse({})),
    );
    expect(windows.map((window) => window.id)).toEqual([
      "copilot-budget-product-budget",
      "copilot-budget-agent-budget",
    ]);
    expect(windows.map((window) => window.title)).toEqual([
      "Budget - Copilot",
      "Budget - Copilot Agent Premium Requests",
    ]);
    expect(windows[0]?.window.usedPercent).toBe(15);
    expect(windows[1]?.window.usedPercent).toBe(25);
    expect(windows.every((window) => window.window.resetsAt !== undefined)).toBe(true);
  });

  it("decodes the GitHub web budget payload shape", () => {
    const response = parseBudgetResponse({
      payload: {
        budgets: [
          {
            uuid: "budget-1",
            targetName: "Example",
            pricingTargetType: "BundlePricing",
            pricingTargetId: "premium_requests",
            targetAmount: 30.0,
            currentAmount: 0.0,
          },
        ],
        has_next_page: false,
      },
    });
    expect(response.hasNextPage).toBe(false);
    expect(response.budgets[0]?.id).toBe("budget-1");
    expect(response.budgets[0]?.budgetEntityName).toBe("Example");
    const windows = extraRateWindowsFromBudgets(
      response.budgets,
      context(() => jsonResponse({})),
    );
    expect(windows.map((window) => window.title)).toEqual(["Budget - All Premium Request SKUs"]);
    expect(windows[0]?.window.usedPercent).toBe(0);
  });

  it("ignores malformed embedded minus amounts", () => {
    expect(parseBudgetAmount("1-5")).toBeUndefined();
    expect(parseBudgetAmount("-$15.00")).toBe(-15);
    expect(parseBudgetAmount("$5.00")).toBe(5);
    const response = parseBudgetResponse({
      budgets: [
        {
          uuid: "budget-1",
          pricingTargetId: "premium_requests",
          targetAmount: "1-5",
          currentAmount: "$5.00",
        },
        {
          uuid: "budget-2",
          pricingTargetId: "premium_requests",
          targetAmount: "-$15.00",
          currentAmount: "$5.00",
        },
      ],
    });
    expect(response.budgets.map((budget) => budget.budgetAmount)).toEqual([0, -15]);
    expect(
      extraRateWindowsFromBudgets(
        response.budgets,
        context(() => jsonResponse({})),
      ),
    ).toEqual([]);
  });

  it("extracts GitHub fetch nonce and web identity from HTML", () => {
    expect(extractFetchNonce('<meta name="x-fetch-nonce" content="v2:abc-123">')).toBe(
      "v2:abc-123",
    );
    const identity = extractGitHubWebIdentity(`
      <meta name="octolytics-actor-id" content="123">
      <meta content = "octocat" name = "user-login">
    `);
    expect(identity).toEqual({ id: "123", login: "octocat" });
    expect(webIdentityMatches(identity, "github:user:123")).toBe(true);
    expect(webIdentityMatches(identity, "OctoCat")).toBe(true);
    expect(webIdentityMatches(identity, "github:user:456")).toBe(false);
  });

  it("routes manual budget cookies and does not fall back from an invalid Cookie: prefix", () => {
    expect(budgetCookieHeaderOverride("auto", "user_session=stale")).toBeUndefined();
    expect(budgetCookieHeaderOverride("manual", "  user_session=manual  ")).toBe(
      "user_session=manual",
    );
    expect(budgetCookieHeaderOverride("manual", "  ")).toBeUndefined();
    expect(budgetCookieHeaderOverride("manual", "Cookie:")).toBeUndefined();
    expect(normalizeCookieHeader("Cookie: user_session=manual")).toBe("user_session=manual");
  });
});

describe("Swift-derived Copilot fetch", () => {
  it("declares GitHub API, budgets, cookie domains, and a fail-closed API strategy", () => {
    expect(copilot.descriptor.id).toBe("copilot");
    expect(copilot.id).toBe("copilot.api");
    expect(copilot.descriptor.endpoints).toEqual([
      "https://api.github.com",
      "https://github.com",
      {
        setting: "COPILOT_ENTERPRISE_HOST",
        policy: "https",
        subdomainPrefixes: ["api"],
      },
    ]);
    expect(copilot.descriptor.cookieDomains).toEqual(["github.com", "www.github.com"]);
    expect(copilot.descriptor.capabilities).toEqual(["browser-cookies"]);
    expect(copilot.fallbackOn).toBeUndefined();
    expect(apiHost(undefined)).toBe("api.github.com");
    expect(apiHost("https://octocorp.ghe.com/login")).toBe("api.octocorp.ghe.com");
    expect(apiHost("https://octocorp.ghe.com:8443/login")).toBe("api.octocorp.ghe.com:8443");
  });

  it("sends CopilotUsageFetcher headers to the internal user endpoint", async () => {
    const requests: Request[] = [];
    await copilot.fetchUsage(
      context(() => jsonResponse(usagePayload), tokenSettings, requests, ""),
    );
    expect(requests[0]?.url.href).toBe("https://api.github.com/copilot_internal/user");
    expect(requests[0]?.options).toMatchObject({
      headers: {
        Authorization: "token oauth-token",
        Accept: "application/json",
        "Editor-Version": "vscode/1.96.2",
        "Editor-Plugin-Version": "copilot-chat/0.26.7",
        "User-Agent": "GitHubCopilotChat/0.26.7",
        "X-Github-Api-Version": "2025-04-01",
      },
    });
    expect(requests).toHaveLength(1);
  });

  it("uses the enterprise API host and port", async () => {
    const requests: Request[] = [];
    await copilot.fetchUsage(
      context(
        () => jsonResponse(usagePayload),
        { ...tokenSettings, COPILOT_ENTERPRISE_HOST: "https://octocorp.ghe.com:8443/login" },
        requests,
        "",
      ),
    );
    expect(requests[0]?.url.href).toBe("https://api.octocorp.ghe.com:8443/copilot_internal/user");
  });

  it("rejects an invalid enterprise host before fetching", async () => {
    await expect(
      copilot.fetchUsage(
        context(() => jsonResponse(usagePayload), {
          ...tokenSettings,
          COPILOT_ENTERPRISE_HOST: "foo bar",
        }),
      ),
    ).rejects.toThrow("api-failure: Copilot enterprise host is invalid.");
  });

  it("classifies 401 and 403 as authentication-expired, not permission-denied", async () => {
    await expect(
      copilot.fetchUsage(context(() => jsonResponse({}, 401), tokenSettings, [], "")),
    ).rejects.toThrow("authentication-expired: Copilot rejected the GitHub OAuth token.");
    await expect(
      copilot.fetchUsage(context(() => jsonResponse({}, 403), tokenSettings, [], "")),
    ).rejects.toThrow("authentication-expired: Copilot rejected the GitHub OAuth token.");
  });

  it("fails closed on malformed usage JSON and missing metered windows", async () => {
    await expect(
      copilot.fetchUsage(context(() => textResponse("{"), tokenSettings, [], "")),
    ).rejects.toThrow("parse-failure: Copilot response was not valid JSON.");
    await expect(
      copilot.fetchUsage(
        context(
          () => jsonResponse({ copilot_plan: "free", quota_snapshots: {} }),
          tokenSettings,
          [],
          "",
        ),
      ),
    ).rejects.toThrow("parse-failure: Copilot response has no metered quota window.");
    await expect(copilot.fetchUsage(context(() => jsonResponse({}), {}, [], ""))).rejects.toThrow(
      "missing-credential: GitHub OAuth token is not configured.",
    );
  });

  it("maps chat-only quota into the secondary lane with credits", () => {
    const snapshot = mapCopilotUsage(
      context(() => jsonResponse({})),
      {
        copilot_plan: "business",
        quota_reset_date: "2026-08-31",
        quota_snapshots: {
          chat: { entitlement: 100, remaining: 25, percent_remaining: 25, credits_used: 75 },
        },
      },
    );
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

  it("returns plan identity without fake zero usage for token-billing placeholders", async () => {
    const snapshot = await copilot.fetchUsage(
      context(
        () =>
          jsonResponse({
            token_based_billing: true,
            copilot_plan: "business",
            quota_reset_date: "2026-09-01",
            quota_snapshots: {
              premium_interactions: {
                entitlement: 0,
                remaining: 0,
                percent_remaining: 100,
                quota_id: "premium_interactions",
                credits_used: 31,
              },
              chat: {
                entitlement: 0,
                remaining: 0,
                percent_remaining: 100,
                quota_id: "chat",
                credits_used: 0,
              },
            },
          }),
        tokenSettings,
        [],
        "",
      ),
    );
    expect(snapshot.primary).toBeUndefined();
    expect(snapshot.secondary).toBeUndefined();
    expect(snapshot.details).toEqual([
      {
        title: "Credits",
        rows: [{ label: "Credits used", value: "31", secondaryValue: "Quota reset" }],
      },
    ]);
    expect(snapshot.identity).toEqual({ loginMethod: "Business" });
  });

  it("omits explicitly unlimited-only chat without failing", async () => {
    const snapshot = await copilot.fetchUsage(
      context(
        () =>
          jsonResponse({
            copilot_plan: "individual",
            quota_reset_date: "2026-07-01",
            quota_snapshots: {
              chat_messages: {
                entitlement: 0,
                remaining: 0,
                quota_id: "chat_messages",
                unlimited: true,
              },
            },
          }),
        tokenSettings,
        [],
        "",
      ),
    );
    expect(snapshot.primary).toBeUndefined();
    expect(snapshot.secondary).toBeUndefined();
    expect(snapshot.identity).toEqual({ loginMethod: "Individual" });
  });

  it("keeps finite premium quota and omits unlimited chat", async () => {
    const snapshot = await copilot.fetchUsage(
      context(
        () =>
          jsonResponse({
            copilot_plan: "individual",
            quota_reset_date: "2026-08-01T00:00:00Z",
            quota_snapshots: {
              premium_interactions: {
                entitlement: 200,
                remaining: 156.2,
                percent_remaining: 78.1,
                quota_id: "premium_interactions",
              },
              chat_messages: {
                entitlement: 0,
                remaining: 0,
                quota_id: "chat_messages",
                unlimited: true,
              },
            },
          }),
        tokenSettings,
        [],
        "",
      ),
    );
    expect(snapshot.primary).toMatchObject({
      usedPercent: expect.closeTo(21.9, 5),
      resetsAt: "2026-08-01T00:00:00.000Z",
    });
    expect(snapshot.secondary).toBeUndefined();
  });

  it("uses a finite monthly chat quota when the direct chat quota is unlimited", async () => {
    const snapshot = await copilot.fetchUsage(
      context(
        () =>
          jsonResponse({
            copilot_plan: "individual",
            quota_snapshots: {
              chat_messages: {
                entitlement: 0,
                remaining: 0,
                quota_id: "chat_messages",
                unlimited: true,
              },
            },
            monthly_quotas: { chat: 100 },
            limited_user_quotas: { chat: 60 },
          }),
        tokenSettings,
        [],
        "",
      ),
    );
    expect(snapshot.primary).toBeUndefined();
    expect(snapshot.secondary).toEqual({ usedPercent: 40 });
  });
});

describe("Swift-derived Copilot budget fetch orchestration", () => {
  const matchingHTML = `
    <meta name="x-fetch-nonce" content="nonce">
    <meta name="octolytics-actor-id" content="123">
    <meta name="user-login" content="octocat">
  `;
  const mismatchedHTML = `
    <meta name="x-fetch-nonce" content="nonce">
    <meta name="octolytics-actor-id" content="456">
    <meta name="user-login" content="otheruser">
  `;
  const budgetJSON = {
    budgets: [
      {
        uuid: "budget-1",
        pricingTargetId: "premium_requests",
        targetAmount: 100.0,
        currentAmount: 40.0,
      },
    ],
    has_next_page: false,
  };

  const extrasSettings = {
    ...tokenSettings,
    COPILOT_BUDGET_EXTRAS_ENABLED: "true",
    COPILOT_BUDGET_COOKIE_SOURCE: "manual",
    COPILOT_BUDGET_COOKIE_HEADER: "user_session=matching",
  };

  const fixtureFor = (html: string, page?: unknown, user = { id: 123, login: "octocat" }) => {
    return (request: Request): ProviderResponse => {
      if (request.url.pathname === "/copilot_internal/user") return jsonResponse(usagePayload);
      if (request.url.pathname === "/user") return jsonResponse(user);
      if (request.url.pathname === "/settings/billing/budgets" && request.url.search === "") {
        return textResponse(html);
      }
      if (
        request.url.pathname === "/settings/billing/budgets" &&
        request.url.search.includes("page=")
      ) {
        if (page instanceof Error) throw page;
        if (typeof page === "string") return textResponse(page);
        return jsonResponse(page ?? budgetJSON);
      }
      throw new Error(`unexpected request ${request.url.href}`);
    };
  };

  it("appends budget windows when the manual cookie matches the token identity", async () => {
    const requests: Request[] = [];
    const snapshot = await copilot.fetchUsage(
      context(fixtureFor(matchingHTML), extrasSettings, requests),
    );
    expect(snapshot.primary).toEqual({ usedPercent: 20 });
    expect(snapshot.extraRateWindows).toEqual([
      {
        id: "copilot-budget-budget-1",
        title: "Budget - All Premium Request SKUs",
        window: {
          usedPercent: 40,
          resetsAt: extraRateWindowsFromBudgets(
            [parseBudget(budgetJSON.budgets[0])!],
            context(() => jsonResponse({})),
          )[0]?.window.resetsAt,
        },
      },
    ]);
    expect(
      requests.map((request) => `${request.url.host}${request.url.pathname}${request.url.search}`),
    ).toEqual([
      "api.github.com/copilot_internal/user",
      "api.github.com/user",
      "github.com/settings/billing/budgets",
      "github.com/settings/billing/budgets?page=1&page_size=10&scope=customer",
    ]);
    const pageRequest = requests[3];
    const headers = pageRequest?.options?.headers as Record<string, string> | undefined;
    expect(headers?.["Content-Type"]).toBeUndefined();
    expect(headers).toMatchObject({
      Cookie: "user_session=matching",
      Accept: "application/json",
      Referer: "https://github.com/settings/billing/budgets",
      "X-Requested-With": "XMLHttpRequest",
      "GitHub-Verified-Fetch": "true",
      "X-Fetch-Nonce": "nonce",
      "User-Agent": "CodexBar",
    });
  });

  it("leaves usage unchanged when the GitHub web identity does not match", async () => {
    const requests: Request[] = [];
    const snapshot = await copilot.fetchUsage(
      context(fixtureFor(mismatchedHTML, { budgets: [] }), extrasSettings, requests),
    );
    expect(snapshot.primary).toEqual({ usedPercent: 20 });
    expect(snapshot.extraRateWindows).toBeUndefined();
    expect(requests.some((request) => request.url.search.includes("page="))).toBe(false);
  });

  it("does not fetch budget JSON when the HTML identity is missing", async () => {
    const requests: Request[] = [];
    const snapshot = await copilot.fetchUsage(
      context(
        fixtureFor('<meta name="x-fetch-nonce" content="nonce">', { budgets: [] }),
        extrasSettings,
        requests,
      ),
    );
    expect(snapshot.extraRateWindows).toBeUndefined();
    expect(requests.some((request) => request.url.search.includes("page="))).toBe(false);
  });

  it("does not fail the usage snapshot when budget JSON is malformed", async () => {
    const snapshot = await copilot.fetchUsage(
      context(fixtureFor(matchingHTML, "{"), extrasSettings),
    );
    expect(snapshot.primary).toEqual({ usedPercent: 20 });
    expect(snapshot.extraRateWindows).toBeUndefined();
  });

  it("does not fail the usage snapshot when the budget page returns HTTP 500", async () => {
    const snapshot = await copilot.fetchUsage(
      context((request) => {
        if (request.url.pathname === "/copilot_internal/user") return jsonResponse(usagePayload);
        if (request.url.pathname === "/user") return jsonResponse({ id: 123, login: "octocat" });
        return textResponse("{}", 500);
      }, extrasSettings),
    );
    expect(snapshot.primary).toEqual({ usedPercent: 20 });
    expect(snapshot.extraRateWindows).toBeUndefined();
  });

  it("rethrows cancellation from budget enrichment", async () => {
    const cancelled = new Error("cancelled");
    cancelled.name = "AbortError";
    await expect(
      copilot.fetchUsage(context(fixtureFor(matchingHTML, cancelled), extrasSettings)),
    ).rejects.toThrow("cancelled");
  });

  it("does not import browser cookies when a manual header is empty or Cookie:", async () => {
    const requests: Request[] = [];
    const snapshot = await copilot.fetchUsage(
      context(
        (request) => {
          if (request.url.pathname === "/copilot_internal/user") return jsonResponse(usagePayload);
          throw new Error(`unexpected request ${request.url.href}`);
        },
        {
          ...tokenSettings,
          COPILOT_BUDGET_EXTRAS_ENABLED: "true",
          COPILOT_BUDGET_COOKIE_SOURCE: "manual",
          COPILOT_BUDGET_COOKIE_HEADER: "Cookie:",
        },
        requests,
        "",
      ),
    );
    expect(snapshot.primary).toEqual({ usedPercent: 20 });
    expect(requests).toHaveLength(1);
  });

  it("ignores a stale manual header in auto cookie mode", async () => {
    const requests: Request[] = [];
    await copilot.fetchUsage(
      context(
        fixtureFor(matchingHTML),
        {
          ...tokenSettings,
          COPILOT_BUDGET_EXTRAS_ENABLED: "true",
          COPILOT_BUDGET_COOKIE_SOURCE: "auto",
          COPILOT_BUDGET_COOKIE_HEADER: "user_session=stale",
        },
        requests,
        "user_session=matching",
      ),
    );
    const htmlRequest = requests.find(
      (request) =>
        request.url.pathname === "/settings/billing/budgets" && request.url.search === "",
    );
    const headers = htmlRequest?.options?.headers as Record<string, string> | undefined;
    expect(headers?.Cookie).toBe("user_session=matching");
  });

  const autoCookieSettings = {
    ...tokenSettings,
    COPILOT_BUDGET_EXTRAS_ENABLED: "true",
    COPILOT_BUDGET_COOKIE_SOURCE: "auto",
  };
  const undeclaredCookieJar = {
    "gist.github.com": "user_session=gist-leak",
    "api.github.com": "user_session=api-leak",
    "github.blog": "user_session=blog-leak",
    "docs.github.com": "user_session=docs-leak",
  };
  const budgetCookie = (request: Request): string | undefined =>
    (request.options?.headers as Record<string, string> | undefined)?.Cookie;
  const budgetPageNumbers = (requests: readonly Request[]): readonly string[] =>
    requests
      .filter(
        (request) =>
          request.url.pathname === "/settings/billing/budgets" &&
          request.url.search.includes("page="),
      )
      .map((request) => request.url.searchParams.get("page") ?? "");

  it("queries github.com first and never asks undeclared cookie domains", async () => {
    const requests: Request[] = [];
    const cookieLookups: string[] = [];
    const snapshot = await copilot.fetchUsage(
      context(
        fixtureFor(matchingHTML),
        autoCookieSettings,
        requests,
        {
          "github.com": "user_session=matching",
          "www.github.com": "user_session=www-unused",
          ...undeclaredCookieJar,
        },
        cookieLookups,
      ),
    );
    expect(cookieLookups).toEqual(["github.com"]);
    expect(snapshot.extraRateWindows).toHaveLength(1);
    expect(requests.map((request) => budgetCookie(request)).filter(Boolean)).toEqual([
      "user_session=matching",
      "user_session=matching",
    ]);
    expect(
      requests.some(
        (request) => request.url.host !== "api.github.com" && request.url.host !== "github.com",
      ),
    ).toBe(false);
  });

  it("falls back to www.github.com cookies only after github.com is empty", async () => {
    const requests: Request[] = [];
    const cookieLookups: string[] = [];
    const snapshot = await copilot.fetchUsage(
      context(
        fixtureFor(matchingHTML),
        autoCookieSettings,
        requests,
        {
          "github.com": "",
          "www.github.com": "user_session=matching",
          ...undeclaredCookieJar,
        },
        cookieLookups,
      ),
    );
    expect(cookieLookups).toEqual(["github.com", "www.github.com"]);
    const htmlRequest = requests.find(
      (request) =>
        request.url.pathname === "/settings/billing/budgets" && request.url.search === "",
    );
    if (htmlRequest === undefined) throw new Error("expected budget HTML request");
    expect(budgetCookie(htmlRequest)).toBe("user_session=matching");
    expect(snapshot.extraRateWindows).toHaveLength(1);
    expect(requests.every((request) => budgetCookie(request) !== "user_session=gist-leak")).toBe(
      true,
    );
  });

  it("does not leak undeclared-domain cookies when both GitHub hosts are empty", async () => {
    const requests: Request[] = [];
    const cookieLookups: string[] = [];
    const snapshot = await copilot.fetchUsage(
      context(
        (request) => {
          if (request.url.pathname === "/copilot_internal/user") return jsonResponse(usagePayload);
          throw new Error(`unexpected request ${request.url.href}`);
        },
        autoCookieSettings,
        requests,
        {
          "github.com": "  ",
          "www.github.com": "",
          ...undeclaredCookieJar,
        },
        cookieLookups,
      ),
    );
    expect(cookieLookups).toEqual(["github.com", "www.github.com"]);
    expect(snapshot.primary).toEqual({ usedPercent: 20 });
    expect(snapshot.extraRateWindows).toBeUndefined();
    expect(requests).toHaveLength(1);
  });

  it("paginates budget JSON while hasNextPage is true and stops when it is not", async () => {
    const requests: Request[] = [];
    const snapshot = await copilot.fetchUsage(
      context(
        (request) => {
          if (request.url.pathname === "/copilot_internal/user") return jsonResponse(usagePayload);
          if (request.url.pathname === "/user") return jsonResponse({ id: 123, login: "octocat" });
          if (request.url.pathname === "/settings/billing/budgets" && request.url.search === "") {
            return textResponse(matchingHTML);
          }
          const page = Number(request.url.searchParams.get("page"));
          if (request.url.pathname === "/settings/billing/budgets" && Number.isFinite(page)) {
            return jsonResponse({
              budgets: [
                {
                  uuid: `budget-${page}`,
                  pricingTargetId: "premium_requests",
                  targetAmount: 100,
                  currentAmount: page * 10,
                },
              ],
              has_next_page: page < 3,
            });
          }
          throw new Error(`unexpected request ${request.url.href}`);
        },
        extrasSettings,
        requests,
      ),
    );
    expect(budgetPageNumbers(requests)).toEqual(["1", "2", "3"]);
    expect(snapshot.extraRateWindows).toMatchObject([
      { id: "copilot-budget-budget-1" },
      { id: "copilot-budget-budget-2" },
      { id: "copilot-budget-budget-3" },
    ]);
  });

  it("stops budget pagination at 20 pages even when hasNextPage stays true", async () => {
    const requests: Request[] = [];
    const pageCap = 20;
    const windows = await fetchCopilotBudgetWindows(
      context(
        (request) => {
          if (request.url.pathname === "/settings/billing/budgets" && request.url.search === "") {
            return textResponse(matchingHTML);
          }
          const page = Number(request.url.searchParams.get("page"));
          if (request.url.pathname === "/settings/billing/budgets" && Number.isFinite(page)) {
            if (page > pageCap) throw new Error(`page cap exceeded: ${page}`);
            return jsonResponse({
              budgets: [
                {
                  uuid: `budget-${page}`,
                  pricingTargetId: "premium_requests",
                  targetAmount: 100,
                  currentAmount: 1,
                },
              ],
              has_next_page: true,
            });
          }
          throw new Error(`unexpected request ${request.url.href}`);
        },
        extrasSettings,
        requests,
      ),
      "user_session=matching",
      "github:user:123",
    );
    const pages = budgetPageNumbers(requests);
    expect(pages).toEqual(Array.from({ length: pageCap }, (_, index) => String(index + 1)));
    expect(windows).toHaveLength(pageCap);
    expect(windows.at(-1)?.id).toBe("copilot-budget-budget-20");
    const pageRequests = requests.filter(
      (request) =>
        request.url.pathname === "/settings/billing/budgets" &&
        request.url.search.includes("page="),
    );
    expect(
      pageRequests.every(
        (request) =>
          request.url.searchParams.get("page_size") === "10" &&
          request.url.searchParams.get("scope") === "customer",
      ),
    ).toBe(true);
  });
});
