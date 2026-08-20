import { describe, expect, it } from "vite-plus/test";

import { mapProviderSnapshot } from "../src/snapshot-mapper.ts";
import { deepgram } from "../src/providers/deepgram.ts";
import { manus } from "../src/providers/manus.ts";
import { perplexity } from "../src/providers/perplexity.ts";
import { qoder } from "../src/providers/qoder.ts";
import type { ProviderContext, ProviderResponse } from "../src/types.ts";

const now = new Date("2026-08-20T12:00:00.000Z");

type Request = {
  readonly method: "GET" | "POST";
  readonly url: URL;
  readonly options?: Record<string, unknown>;
};

type Fixture = (request: Request) => ProviderResponse;

const fail = (kind: string) => (message: string) => new Error(`${kind}: ${message}`);

function context(
  fixture: Fixture,
  options: {
    readonly settings?: Readonly<Record<string, string>>;
    readonly cookie?: string;
    readonly requests?: Request[];
  } = {},
): ProviderContext {
  const settings = options.settings ?? {};
  const request = async (
    method: Request["method"],
    url: string,
    requestOptions?: Record<string, unknown>,
  ) => {
    const recorded: Request = {
      method,
      url: new URL(url),
      ...(requestOptions === undefined ? {} : { options: requestOptions }),
    };
    options.requests?.push(recorded);
    return fixture(recorded);
  };

  return {
    settings: {
      get: (key) => settings[key],
      getSecret: (key) => settings[key],
    },
    http: {
      get: (url, requestOptions) => request("GET", url, requestOptions),
      getJSON: async (url, requestOptions) => {
        const response = await request("GET", url, requestOptions);
        return { ...response, json: JSON.parse(response.bodyText) as unknown };
      },
      postJSON: async (url, requestOptions) => {
        const response = await request("POST", url, requestOptions);
        return { ...response, json: JSON.parse(response.bodyText) as unknown };
      },
    },
    browser: {
      cookieHeader: async () => options.cookie ?? "",
    },
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
      number: (value, formatOptions) =>
        new Intl.NumberFormat("en-US", formatOptions as Intl.NumberFormatOptions).format(value),
      usd: (value) =>
        new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value),
      monthDay: (value) =>
        new Intl.DateTimeFormat("en-US", {
          month: "short",
          day: "numeric",
          timeZone: "UTC",
        }).format(value),
    },
    pct: (used, limit) => (used / limit) * 100,
    amountFromPercent: (usedPercent, limit) => (usedPercent / 100) * limit,
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

function json(body: unknown, status = 200): ProviderResponse {
  return { status, bodyText: JSON.stringify(body) };
}

describe("Swift-derived provider extension parity", () => {
  it("keeps the four provider descriptors and strategies aligned with the upstream IDs", () => {
    expect([qoder, manus, perplexity, deepgram].map((provider) => provider.descriptor.id)).toEqual([
      "qoder",
      "manus",
      "perplexity",
      "deepgram",
    ]);
    expect([qoder, manus, perplexity, deepgram].map((provider) => provider.id)).toEqual([
      "qoder.web",
      "manus.web",
      "perplexity.web",
      "deepgram.api",
    ]);
  });

  it("matches the Qoder shared-quota oracle and preserves fallback request headers", async () => {
    const requests: Request[] = [];
    const raw = await qoder.fetchUsage(
      context(
        (request) =>
          request.url.hostname === "qoder.com"
            ? json({}, 401)
            : json({
                total_quota: {
                  quota_summary: {
                    used_value: 1_500,
                    limit_value: 1_500,
                    remaining_value: 0,
                    usage_percentage: 100,
                  },
                },
                shared_quota: {
                  quota_summary: {
                    used_value: 200,
                    limit_value: 1_000,
                    remaining_value: 800,
                  },
                },
                next_reset_at: "2027-01-15T00:00:00Z",
              }),
        { cookie: "sid=fixture", requests },
      ),
    );

    expect(requests.map(({ url }) => url.hostname)).toEqual(["qoder.com", "qoder.com.cn"]);
    expect(requests[1]?.options).toMatchObject({
      headers: {
        Cookie: "sid=fixture",
        Origin: "https://qoder.com.cn",
        Referer: "https://qoder.com.cn/account/usage",
        "X-Requested-With": "XMLHttpRequest",
        "Bx-V": "2.5.35",
      },
    });
    expect(raw).toEqual({
      primary: {
        usedPercent: 68,
        resetsAt: "2027-01-15T00:00:00.000Z",
        resetDescription: "1,700 / 2,500 credits",
      },
    });
    expect(mapProviderSnapshot(raw, "qoder", now)).toMatchObject({
      primary: raw.primary,
      updatedAt: now.toISOString(),
      dataConfidence: "unknown",
    });
  });

  it("accepts the Qoder camelCase quota fixture and fails when the summary is absent", async () => {
    const raw = await qoder.fetchUsage(
      context(() =>
        json({
          totalQuota: {
            quotaSummary: { usedValue: 125, limitValue: 500, usagePercentage: 25 },
          },
          nextResetAt: 1_725_148_800_000,
        }),
      ),
    );
    expect(raw).toEqual({
      primary: {
        usedPercent: 25,
        resetsAt: "2024-09-01T00:00:00.000Z",
        resetDescription: "125 / 500 credits",
      },
    });
    await expect(
      qoder.fetchUsage(
        context(() =>
          json({
            status: "active",
          }),
        ),
      ),
    ).rejects.toThrow("Qoder response is missing quota summary");
  });

  it("matches the Manus cookie, authorization and credit-window oracle", async () => {
    const requests: Request[] = [];
    const raw = await manus.fetchUsage(
      context(
        () =>
          json({
            totalCredits: 1_200,
            freeCredits: 200,
            periodicCredits: 300,
            refreshCredits: 40,
            maxRefreshCredits: 100,
            proMonthlyCredits: 1_000,
            eventCredits: 0,
            addonCredits: 0,
            nextRefreshTime: "2027-01-15T00:00:00Z",
            refreshInterval: "daily",
          }),
        { cookie: "foo=bar; Session_ID=fixture-session; baz=qux", requests },
      ),
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.url.toString()).toBe(
      "https://api.manus.im/user.v1.UserService/GetAvailableCredits",
    );
    expect(requests[0]?.options).toMatchObject({
      body: {},
      headers: {
        Authorization: "Bearer fixture-session",
        Origin: "https://manus.im",
        Referer: "https://manus.im/",
        "Connect-Protocol-Version": "1",
      },
    });
    expect(raw).toEqual({
      primary: {
        usedPercent: 70,
        resetDescription: "Total 1,200 • Free 200",
      },
      secondary: {
        usedPercent: 60,
        resetsAt: "2027-01-15T00:00:00.000Z",
        resetDescription: "Daily: 40 / 100",
      },
      identity: { loginMethod: "Balance: 1,200 credits" },
    });
    expect(mapProviderSnapshot(raw, "manus", now)).toMatchObject({
      primary: { usedPercent: 70, resetDescription: "Total 1,200 • Free 200" },
      secondary: { usedPercent: 60, resetsAt: "2027-01-15T00:00:00.000Z" },
      identity: { providerId: "manus", loginMethod: "Balance: 1,200 credits" },
    });
  });

  it("matches the Perplexity recurring/purchased/promo waterfall and cookie headers", async () => {
    const requests: Request[] = [];
    const raw = await perplexity.fetchUsage(
      context(
        () =>
          json({
            balance_cents: 0,
            renewal_date_ts: 1_743_000_000,
            current_period_purchased_cents: 3_000,
            credit_grants: [
              { type: "recurring", amount_cents: 5_000 },
              { type: "promotional", amount_cents: 4_000, expires_at_ts: 4_102_444_800 },
            ],
            total_usage_cents: 9_000,
          }),
        { cookie: "__Secure-authjs.session-token=fixture", requests },
      ),
    );

    expect(requests[0]?.url.toString()).toBe(
      "https://www.perplexity.ai/rest/billing/credits?version=2.18&source=default",
    );
    expect(requests[0]?.options).toMatchObject({
      headers: {
        Cookie: "__Secure-authjs.session-token=fixture",
        Origin: "https://www.perplexity.ai",
        Referer: "https://www.perplexity.ai/account/usage",
      },
    });
    expect(raw).toMatchObject({
      primary: {
        usedPercent: 100,
        resetsAt: "2025-03-26T14:40:00.000Z",
        resetDescription: "5000/5000 credits",
      },
      secondary: {
        usedPercent: 25,
        resetDescription: "1000/4000 bonus · exp. Jan 1",
      },
      tertiary: { usedPercent: 100, resetDescription: "3000/3000 credits" },
      identity: { loginMethod: "Max" },
    });
    expect(mapProviderSnapshot(raw, "perplexity", now)).toMatchObject({
      primary: raw.primary,
      secondary: raw.secondary,
      tertiary: raw.tertiary,
      identity: { providerId: "perplexity", loginMethod: "Max" },
    });
  });

  it("matches the Deepgram multi-project details oracle and validates classified failures", async () => {
    const requests: Request[] = [];
    const raw = await deepgram.fetchUsage(
      context(
        (request) => {
          switch (request.url.pathname) {
            case "/v1/projects":
              return json({
                projects: [
                  { project_id: "project-a", name: "Alpha" },
                  { project_id: "project-b", name: "Beta" },
                ],
              });
            case "/v1/projects/project-a/usage/breakdown":
              return json({
                start: "2025-01-16",
                end: "2025-01-23",
                results: [
                  {
                    hours: 1.5,
                    total_hours: 2,
                    tokens_in: 1_200,
                    tokens_out: 340,
                    requests: 373_381,
                  },
                ],
              });
            case "/v1/projects/project-b/usage/breakdown":
              return json({
                start: "2025-01-17",
                end: "2025-01-24",
                results: [
                  { hours: 2.25, total_hours: 3.5, agent_hours: 41.33564388888889, requests: 19 },
                ],
              });
            default:
              return json({}, 404);
          }
        },
        { settings: { DEEPGRAM_API_KEY: "fixture-key" }, requests },
      ),
    );

    expect(requests.map(({ url }) => url.pathname)).toEqual([
      "/v1/projects",
      "/v1/projects/project-a/usage/breakdown",
      "/v1/projects/project-b/usage/breakdown",
    ]);
    expect(raw).toEqual({
      identity: { loginMethod: "2 projects" },
      details: [
        {
          title: "Usage summary",
          rows: [
            { label: "Requests", value: "373,400" },
            { label: "Audio", value: "3.8 hours", secondaryValue: "5.5 billable hours" },
            { label: "Agent hours", value: "41.3" },
            { label: "Tokens", value: "1,540" },
            { label: "Period", value: "2025-01-16 to 2025-01-24" },
          ],
        },
      ],
    });
    expect(mapProviderSnapshot(raw, "deepgram", now)).toMatchObject({
      identity: { providerId: "deepgram", loginMethod: "2 projects" },
      details: raw.details,
    });

    for (const [status, kind] of [
      [401, "authentication-expired"],
      [403, "permission-denied"],
      [429, "rate-limited"],
      [500, "provider-unavailable"],
      [400, "api-failure"],
    ] as const) {
      await expect(
        deepgram.fetchUsage(
          context(() => ({ status, bodyText: "not-json" }), {
            settings: { DEEPGRAM_PROJECT_ID: "project-a" },
          }),
        ),
      ).rejects.toThrow(`${kind}:`);
    }

    await expect(
      deepgram.fetchUsage(
        context(() => ({ status: 200, bodyText: "not-json" }), {
          settings: { DEEPGRAM_PROJECT_ID: "project-a" },
        }),
      ),
    ).rejects.toThrow("parse-failure: Deepgram parse error");
  });
});
