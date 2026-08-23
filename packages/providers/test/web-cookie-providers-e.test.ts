import { describe, expect, it } from "vite-plus/test";
import { commandcode } from "../src/providers/commandcode.ts";
import { longcat } from "../src/providers/longcat.ts";
import { stepfun } from "../src/providers/stepfun.ts";
import type { ProviderContext, ProviderResponse } from "../src/types.ts";
type Req = { method: "GET" | "POST"; url: URL; options?: Record<string, unknown> };
const error = (kind: string) => (message: string) => new Error(`${kind}: ${message}`);
function ctx(
  fixture: (request: Req) => ProviderResponse,
  settings: Record<string, string>,
): ProviderContext {
  const request = async (method: Req["method"], url: string, options?: Record<string, unknown>) =>
    fixture({ method, url: new URL(url), ...(options ? { options } : {}) });
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
    browser: { cookieHeader: async () => "" },
    env: {},
    date: {
      now: () => new Date("2026-08-20T12:00:00Z"),
      nowMillis: () => Date.parse("2026-08-20T12:00:00Z"),
      iso: (value) => new Date(value).toISOString(),
      unixSeconds: (value) => new Date(value * 1000).toISOString(),
      unixMillis: (value) => new Date(value).toISOString(),
      nextDailyReset: () => "",
    },
    format: {
      number: (value) => new Intl.NumberFormat("en-US").format(value),
      usd: (value) => `$${value.toFixed(2)}`,
      monthDay: (value) => value.toISOString(),
    },
    pct: (used, limit) => (used / limit) * 100,
    amountFromPercent: (percent, total) => (percent / 100) * total,
    fail: {
      authenticationExpired: error("authentication-expired"),
      missingCredential: error("missing-credential"),
      permissionDenied: error("permission-denied"),
      rateLimited: error("rate-limited"),
      providerUnavailable: error("provider-unavailable"),
      parseFailure: error("parse-failure"),
      networkFailure: error("network-failure"),
      apiFailure: error("api-failure"),
    },
  };
}
const reply = (value: unknown, status = 200): ProviderResponse => ({
  status,
  bodyText: JSON.stringify(value),
});
describe("Swift-derived CommandCode, StepFun and LongCat parity", () => {
  it("preserves IDs and web strategies", () =>
    expect([commandcode, stepfun, longcat].map((p) => [p.descriptor.id, p.id])).toEqual([
      ["commandcode", "commandcode.web"],
      ["stepfun", "stepfun.web"],
      ["longcat", "longcat.web"],
    ]));
  it("maps CommandCode plan total, rolling quotas and session cookie", async () => {
    const result = await commandcode.fetchUsage(
      ctx(
        (request) =>
          request.url.pathname.endsWith("credits")
            ? reply({
                credits: { monthlyCredits: 20, purchasedCredits: 5 },
                windowLimits: { fiveHour: { cap: 10, used: 2 }, weekly: { cap: 100, used: 25 } },
              })
            : reply({
                success: true,
                data: {
                  planId: "individual-pro",
                  status: "active",
                  currentPeriodEnd: "2026-09-01T00:00:00Z",
                },
              }),
        { COMMANDCODE_COOKIE: "session" },
      ),
    );
    expect(result).toMatchObject({
      primary: { usedPercent: 20 },
      secondary: { usedPercent: 25 },
      tertiary: { usedPercent: expect.closeTo(33.333333, 3), windowMinutes: 43200 },
      identity: { loginMethod: "Pro · $10.00 of $30.00 · + $5.00 credits" },
    });
  });
  it("maps the versioned CommandCode Pro plan to eighty dollars", async () => {
    const result = await commandcode.fetchUsage(
      ctx(
        (request) =>
          request.url.pathname.endsWith("credits")
            ? reply({ credits: { monthlyCredits: 8.7784, purchasedCredits: 0 } })
            : reply({
                success: true,
                data: {
                  planId: "individual-pro-v1",
                  status: "active",
                  currentPeriodEnd: "2026-09-01T00:00:00Z",
                },
              }),
        { COMMANDCODE_COOKIE: "session" },
      ),
    );
    expect(result.identity).toEqual({ loginMethod: "Pro · $71.22 of $80.00" });
    expect(result.tertiary).toMatchObject({ usedPercent: expect.closeTo(89.027, 3) });
  });
  it("maps StepFun rolling rate windows and plan status", async () => {
    const result = await stepfun.fetchUsage(
      ctx(
        (request) =>
          request.url.pathname.includes("RateLimit")
            ? reply({
                status: 1,
                five_hour_usage_left_rate: 0.8,
                weekly_usage_left_rate: 0.6,
                five_hour_usage_reset_time: "1777528800",
                weekly_usage_reset_time: "1777899600",
              })
            : reply({ subscription: { name: "Pro" } }),
        { STEPFUN_TOKEN: "token" },
      ),
    );
    expect(result).toMatchObject({
      primary: { windowMinutes: 300 },
      secondary: { usedPercent: 40, windowMinutes: 10080 },
      identity: { loginMethod: "Pro" },
    });
    expect((result.primary as { usedPercent: number }).usedPercent).toBeCloseTo(20, 8);
  });
  it("aggregates StepFun credit buckets and lets live rolling windows override a stale family ID", async () => {
    const credit = await stepfun.fetchUsage(
      ctx(
        (request) =>
          request.url.pathname.includes("RateLimit")
            ? reply({
                status: 1,
                plan_family: 2,
                five_hour_usage_reset_time: "0",
                weekly_usage_reset_time: "0",
                plan_credit_rate_limit: {
                  subscription_credit_reset_time: "1786288293",
                  credit_buckets: [
                    { credit_total: "1000", credit_residual: "750" },
                    { credit_total: "3000", credit_residual: "1500" },
                  ],
                },
              })
            : reply({ subscription: { name: "Token Plan" } }),
        { STEPFUN_TOKEN: "token" },
      ),
    );
    expect(credit).toMatchObject({
      primary: {
        usedPercent: 43.75,
        windowMinutes: 43200,
        resetsAt: "2026-08-09T15:11:33.000Z",
      },
      identity: { loginMethod: "Token Plan" },
    });

    const rolling = await stepfun.fetchUsage(
      ctx(
        (request) =>
          request.url.pathname.includes("RateLimit")
            ? reply({
                status: 1,
                plan_family: 2,
                five_hour_usage_left_rate: 0.8,
                weekly_usage_left_rate: 0.6,
                five_hour_usage_reset_time: "1777528800",
                weekly_usage_reset_time: "1777899600",
                plan_credit_rate_limit: { subscription_credit_left_rate: 0.5 },
              })
            : reply({ subscription: { name: "Coding Plan" } }),
        { STEPFUN_TOKEN: "token" },
      ),
    );
    expect(rolling).toMatchObject({
      primary: { usedPercent: expect.closeTo(20, 8), windowMinutes: 300 },
      secondary: { usedPercent: 40, windowMinutes: 10080 },
    });
  });
  it("uses LongCat active token packs before legacy usage and exposes fuel expiry", async () => {
    const result = await longcat.fetchUsage(
      ctx(
        (request) =>
          request.url.pathname.includes("user-current")
            ? reply({ code: 0, data: { name: "Fixture" } })
            : request.url.pathname.includes("token-packs")
              ? reply({
                  code: 0,
                  data: { currentLot: { status: "ACTIVE", totalToken: 1000, consumedToken: 250 } },
                })
              : reply({
                  code: 0,
                  data: {
                    totalQuota: 500,
                    list: [{ availableToken: 300, expireTime: "2026-09-01T00:00:00Z" }],
                  },
                }),
        { LONGCAT_MANUAL_COOKIE: "session=ok" },
      ),
    );
    expect(result).toEqual({
      primary: { usedPercent: 25, resetDescription: "250/1000" },
      secondary: {
        usedPercent: 40,
        resetsAt: "2026-09-01T00:00:00.000Z",
        resetDescription: "Fuel pack: 300/500",
      },
      identity: { organization: "Fixture" },
    });
  });
});
