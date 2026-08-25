import { describe, expect, it } from "vite-plus/test";
import { sub2api } from "../src/providers/sub2api.ts";
import type { ProviderContext, ProviderResponse } from "../src/types.ts";

type Request = {
  readonly url: URL;
  readonly options?: Record<string, unknown>;
};

const failure = (kind: string) => (message: string) => new Error(`${kind}: ${message}`);
const response = (body: unknown, status = 200): ProviderResponse => ({
  status,
  bodyText: JSON.stringify(body),
});

const context = (
  fixture: (request: Request) => ProviderResponse | Promise<ProviderResponse>,
  settings: Readonly<Record<string, string>>,
  requests: Request[] = [],
): ProviderContext => ({
  settings: { get: (key) => settings[key], getSecret: (key) => settings[key] },
  http: {
    get: async (url, options) => {
      const request = { url: new URL(url), ...(options === undefined ? {} : { options }) };
      requests.push(request);
      return fixture(request);
    },
    getJSON: async () => {
      throw new Error("not used");
    },
    postJSON: async () => {
      throw new Error("not used");
    },
  },
  browser: { cookieHeader: async () => "" },
  env: { timeZone: "America/Sao_Paulo" },
  date: {
    now: () => new Date("2026-08-24T12:00:00Z"),
    nowMillis: () => Date.parse("2026-08-24T12:00:00Z"),
    iso: (value) => new Date(value).toISOString(),
    unixSeconds: (value) => new Date(value * 1_000).toISOString(),
    unixMillis: (value) => new Date(value).toISOString(),
    nextDailyReset: () => "2026-08-25T03:00:00.000Z",
  },
  format: {
    number: (value, options) => new Intl.NumberFormat("en-US", options).format(value),
    usd: (value) => `$${value.toFixed(2)}`,
    monthDay: (value) => value.toISOString().slice(5, 10),
  },
  pct: (used, limit) => (limit > 0 ? Math.max(0, Math.min(100, (used / limit) * 100)) : 100),
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
});

const settings = {
  SUB2API_API_KEY: "fixture-key",
  SUB2API_BASE_URL: "https://sub2api.example.test",
};

describe("Sub2API Swift/plugin parity", () => {
  it("ports subscription, rate-limit, usage detail and identity snapshots", async () => {
    const snapshot = await sub2api.fetchUsage(
      context(
        () =>
          response({
            isValid: true,
            planName: "Pro",
            balance: 12.5,
            unit: "USD",
            subscription: {
              daily_usage_usd: 2,
              daily_limit_usd: 10,
              weekly_usage_usd: 5,
              weekly_limit_usd: 20,
              monthly_usage_usd: 8,
              monthly_limit_usd: 40,
              expires_at: "2026-09-01T00:00:00Z",
            },
            rate_limits: [
              {
                window: "5h",
                limit: 100,
                used: 25,
                remaining: 75,
                reset_at: "2026-08-24T15:00:00Z",
              },
            ],
            usage: {
              today: { requests: 3, total_tokens: 100, actual_cost: 0.5 },
              total: { requests: 9, total_tokens: 500, actual_cost: 2.25 },
            },
          }),
        settings,
      ),
    );

    expect(snapshot).toEqual({
      primary: {
        usedPercent: 20,
        windowMinutes: 1440,
        resetDescription: "$2.00 / $10.00",
      },
      secondary: {
        usedPercent: 25,
        windowMinutes: 10080,
        resetDescription: "$5.00 / $20.00",
      },
      tertiary: {
        usedPercent: 20,
        windowMinutes: 43200,
        resetDescription: "$8.00 / $40.00",
      },
      extraWindows: [
        {
          id: "5h",
          title: "5 hour limit",
          window: {
            usedPercent: 25,
            windowMinutes: 300,
            resetsAt: "2026-08-24T15:00:00.000Z",
            resetDescription: "$25.00 / $100.00",
          },
        },
      ],
      subscriptionExpiresAt: "2026-09-01T00:00:00.000Z",
      identity: { organization: "Pro", loginMethod: "Pro" },
      details: [
        {
          title: "Usage summary",
          rows: [
            { label: "Balance", value: "$12.50" },
            { label: "Today requests", value: "3" },
            { label: "Today tokens", value: "100", secondaryValue: "$0.50" },
            { label: "All time requests", value: "9" },
            { label: "All time tokens", value: "500", secondaryValue: "$2.25" },
          ],
        },
      ],
      dataConfidence: "exact",
    });
  });

  it("normalizes credentials, loopback base URLs, paths, timezone and auth", async () => {
    const requests: Request[] = [];
    await sub2api.fetchUsage(
      context(
        () => response({ quota: { limit: 10, used: 4, remaining: 6, unit: "credits" } }),
        {
          SUB2API_API_KEY: "  'selected-key'  ",
          SUB2API_BASE_URL: '  "http://127.0.0.1:8080/custom/v1/"  ',
        },
        requests,
      ),
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url.href).toBe(
      "http://127.0.0.1:8080/custom/v1/usage?days=30&timezone=America%2FSao_Paulo",
    );
    expect(requests[0]?.options).toMatchObject({
      headers: { Authorization: "Bearer selected-key" },
      timeoutSeconds: 15,
    });
  });

  it("uses quota as primary when a subscription is absent", async () => {
    const snapshot = await sub2api.fetchUsage(
      context(
        () => response({ quota: { limit: 80, used: 20, remaining: 60, unit: "credits" } }),
        settings,
      ),
    );
    expect(snapshot.primary).toEqual({
      usedPercent: 25,
      resetDescription: "20.00 credits / 80.00 credits",
    });
    expect(snapshot.secondary).toBeNull();
    expect(snapshot.tertiary).toBeNull();
  });

  it.each([
    [401, "authentication-expired"],
    [403, "authentication-expired"],
    [429, "rate-limited"],
    [500, "provider-unavailable"],
    [418, "api-failure"],
  ] as const)("classifies HTTP %s like the bundled plugin", async (statusCode, kind) => {
    await expect(
      sub2api.fetchUsage(context(() => response({}, statusCode), settings)),
    ).rejects.toThrow(`${kind}:`);
  });

  it("classifies invalid groups, parser drift and raw transport failures", async () => {
    await expect(
      sub2api.fetchUsage(context(() => response({ isValid: false }), settings)),
    ).rejects.toThrow("authentication-expired:");
    await expect(
      sub2api.fetchUsage(
        context(() => response({ rate_limits: [{ window: "5h", limit: "100" }] }), settings),
      ),
    ).rejects.toThrow("parse-failure:");
    await expect(
      sub2api.fetchUsage(
        context(() => {
          throw new Error("offline");
        }, settings),
      ),
    ).rejects.toThrow("network-failure:");
  });

  it("preserves AbortError instead of reclassifying cancellation", async () => {
    const abort = new DOMException("cancelled", "AbortError");
    await expect(
      sub2api.fetchUsage(
        context(() => {
          throw abort;
        }, settings),
      ),
    ).rejects.toBe(abort);
  });

  it.each([
    [{ SUB2API_API_KEY: "fixture-key" }, "missing-credential"],
    [
      { SUB2API_API_KEY: "fixture-key", SUB2API_BASE_URL: "http://public.example.test" },
      "missing-credential",
    ],
    [
      { SUB2API_API_KEY: "fixture-key", SUB2API_BASE_URL: "https://user:pass@example.test" },
      "missing-credential",
    ],
    [
      { SUB2API_API_KEY: "fixture-key", SUB2API_BASE_URL: "https://example.test?query=1" },
      "missing-credential",
    ],
    [
      { SUB2API_API_KEY: "fixture-key", SUB2API_BASE_URL: "https://example.test#fragment" },
      "missing-credential",
    ],
  ] as const)("rejects missing or unsafe settings before transport", async (input, kind) => {
    const requests: Request[] = [];
    await expect(sub2api.fetchUsage(context(() => response({}), input, requests))).rejects.toThrow(
      `${kind}:`,
    );
    expect(requests).toHaveLength(0);
  });
});
