import { describe, expect, it } from "vite-plus/test";

import { notion } from "../src/providers/notion.ts";
import { zoommate } from "../src/providers/zoommate.ts";
import type { ProviderContext, ProviderResponse } from "../src/types.ts";

type Request = {
  readonly method: "GET" | "POST";
  readonly url: URL;
  readonly options?: Record<string, unknown>;
};
const fail = (kind: string) => (message: string) => new Error(`${kind}: ${message}`);
const response = (json: unknown, status = 200): ProviderResponse => ({
  status,
  bodyText: JSON.stringify(json),
});
const context = (
  handler: (request: Request) => ProviderResponse,
  settings: Record<string, string>,
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
    format: {
      number: (value) => String(value),
      usd: (value) => `$${value}`,
      monthDay: (value) => value.toISOString().slice(5, 10),
    },
    pct: (used, total) => (used / total) * 100,
    amountFromPercent: (percent, total) => (percent / 100) * total,
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
};
describe("ZoomMate and Notion Swift-derived parity", () => {
  it("keeps provider ids and cookie capability contracts", () => {
    expect([zoommate, notion].map((provider) => provider.descriptor.id)).toEqual([
      "zoommate",
      "notion",
    ]);
    expect(zoommate.descriptor.cookieDomains).toContain("ai.zoom.us");
    expect(notion.descriptor.cookieDomains).toContain("app.notion.com");
  });
  it("mints ZoomMate bearer from a session then maps credit status", async () => {
    const calls: Request[] = [];
    const raw = await zoommate.fetchUsage(
      context(
        (request) => {
          calls.push(request);
          return request.url.pathname.includes("/login/")
            ? response({ data: { nak: "jwt", user_profile: { email: "user@example.com" } } })
            : response({
                data: {
                  credit_status: {
                    budget_cap: 100,
                    used_credit: 20,
                    cycle_end_date: 1_800_000_000_000,
                  },
                },
              });
        },
        { ZOOMMATE_COOKIE: "sid=fixture" },
      ),
    );
    expect(calls).toHaveLength(2);
    expect(calls[1]?.options).toMatchObject({
      headers: {
        Authorization: "Bearer jwt",
        Cookie: "sid=fixture",
        Origin: "https://zoommate.zoom.us",
      },
    });
    expect(raw).toMatchObject({
      primary: { usedPercent: 20, resetDescription: "Credits" },
      identity: { accountEmail: "user@example.com", loginMethod: "Cookie" },
    });
  });
  it("maps Notion spaces selection to rolling and billing quota snapshots", async () => {
    const raw = await notion.fetchUsage(
      context(
        (request) =>
          request.url.pathname.endsWith("getSpaces")
            ? response({
                user: {
                  notion_user: {
                    user: { value: { value: { id: "user", email: "person@example.com" } } },
                  },
                  space: {
                    free: {
                      value: { value: { id: "free", name: "Personal", subscription_tier: "free" } },
                    },
                    business: {
                      value: {
                        value: { id: "business", name: "Acme", subscription_tier: "business" },
                      },
                    },
                  },
                },
              })
            : response({
                status: "within_limit",
                window: { window: "6h", used: 42.5, limit: 100 },
                resetsInSeconds: 12_600,
                billingPeriodWindow: { used: 18, limit: 100, periodEndMs: 1_788_000_000_000 },
              }),
        { NOTION_COOKIE: "token_v2=fixture" },
      ),
    );
    expect(raw).toMatchObject({
      primary: { usedPercent: 42.5, windowMinutes: 360 },
      secondary: { usedPercent: 18, windowMinutes: 43_200, resetsAt: "2026-08-29T10:40:00.000Z" },
      identity: {
        accountEmail: "person@example.com",
        accountOrganization: "Acme",
        loginMethod: "Business",
        accountId: "user",
      },
    });
  });
});
