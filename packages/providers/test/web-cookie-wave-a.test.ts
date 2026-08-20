import { describe, expect, it } from "vite-plus/test";

import { cursor } from "../src/providers/cursor.ts";
import { opencode } from "../src/providers/opencode.ts";
import { opencodego } from "../src/providers/opencodego.ts";
import type { ProviderContext, ProviderResponse } from "../src/types.ts";

type Request = { readonly url: URL; readonly options?: Record<string, unknown> };
const now = new Date("2026-08-20T12:00:00.000Z");
const failure = (kind: string) => (message: string) => new Error(`${kind}: ${message}`);
const response = (bodyText: string, status = 200): ProviderResponse => ({ status, bodyText });
const json = (value: unknown, status = 200): ProviderResponse =>
  response(JSON.stringify(value), status);
function context(
  handler: (request: Request) => ProviderResponse,
  secrets: Record<string, string> = {},
): ProviderContext {
  const request = async (url: string, options?: Record<string, unknown>) =>
    handler({ url: new URL(url), ...(options ? { options } : {}) });
  return {
    settings: { get: (key) => secrets[key], getSecret: (key) => secrets[key] },
    http: {
      get: request,
      getJSON: async (url, options) => {
        const result = await request(url, options);
        return { ...result, json: JSON.parse(result.bodyText) as unknown };
      },
      postJSON: async (url, options) => {
        const result = await request(url, options);
        return { ...result, json: JSON.parse(result.bodyText) as unknown };
      },
    },
    browser: { cookieHeader: async () => "session=fixture" },
    env: {},
    date: {
      now: () => now,
      nowMillis: () => now.getTime(),
      iso: (value) => new Date(value).toISOString(),
      unixSeconds: (value) => new Date(value * 1000).toISOString(),
      unixMillis: (value) => new Date(value).toISOString(),
      nextDailyReset: () => "2026-08-21T00:00:00.000Z",
    },
    format: {
      number: (value) => String(value),
      usd: (value) => `$${value}`,
      monthDay: () => "Aug 20",
    },
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
}

describe("Swift-derived Cursor, OpenCode, and OpenCode Go web parity", () => {
  it("keeps the upstream provider and web strategy IDs", () => {
    expect(
      [cursor, opencode, opencodego].map((provider) => [provider.descriptor.id, provider.id]),
    ).toEqual([
      ["cursor", "cursor.web"],
      ["opencode", "opencode.web"],
      ["opencodego", "opencodego.web"],
    ]);
  });

  it("maps Cursor plan lanes, on-demand cost and optional account identity", async () => {
    const snapshot = await cursor.fetchUsage(
      context((request) => {
        if (request.url.pathname === "/api/auth/me")
          return json({ email: "user@example.com", name: "Fixture", sub: "auth0|fixture" });
        return json({
          billingCycleStart: "2026-08-01T00:00:00.000Z",
          billingCycleEnd: "2026-09-01T00:00:00.000Z",
          membershipType: "pro",
          individualUsage: {
            plan: {
              used: 1500,
              limit: 5000,
              autoPercentUsed: 20,
              apiPercentUsed: 40,
              totalPercentUsed: 30,
            },
            onDemand: { used: 500, limit: 10000 },
          },
        });
      }),
    );
    expect(snapshot).toMatchObject({
      primary: {
        usedPercent: 30,
        windowMinutes: 44640,
        resetsAt: "2026-09-01T00:00:00.000Z",
      },
      secondary: { usedPercent: 20, windowMinutes: 44640 },
      tertiary: { usedPercent: 40, windowMinutes: 44640 },
      providerCost: { used: 5, limit: 100, period: "Monthly" },
      identity: {
        email: "user@example.com",
        accountID: "auth0|fixture",
        loginMethod: "Cursor Pro",
      },
    });
  });

  it("rejects Cursor authentication failure before parsing", async () => {
    await expect(cursor.fetchUsage(context(() => response("{}", 401)))).rejects.toThrow(
      "authentication-expired",
    );
  });

  it("fetches the OpenCode workspace and maps subscription windows", async () => {
    const calls: URL[] = [];
    const snapshot = await opencode.fetchUsage(
      context((request) => {
        calls.push(request.url);
        if (request.url.searchParams.get("id")?.startsWith("def"))
          return response('{"id":"wrk_fixture"}');
        return json({
          rollingUsage: { usagePercent: 12.5, resetInSec: 600 },
          weeklyUsage: { usagePercent: 40, resetInSec: 7200 },
        });
      }),
    );
    expect(calls).toHaveLength(2);
    expect(calls[1]?.searchParams.get("args")).toBe('["wrk_fixture"]');
    expect(snapshot).toMatchObject({
      primary: { usedPercent: 12.5, windowMinutes: 300, resetsAt: "2026-08-20T12:10:00.000Z" },
      secondary: { usedPercent: 40, windowMinutes: 10080, resetsAt: "2026-08-20T14:00:00.000Z" },
    });
  });

  it("uses OpenCode billing only when subscription windows are unavailable", async () => {
    const snapshot = await opencode.fetchUsage(
      context((request) => {
        if (request.url.searchParams.get("id")?.startsWith("def"))
          return response('id: "wrk_fixture"');
        if (request.url.searchParams.get("id")?.startsWith("7abe")) return response("null");
        return json({ monthlyUsageUSD: 12.5, monthlyLimitUSD: 50, balanceUSD: 7.5 });
      }),
    );
    expect(snapshot).toEqual({
      primary: { usedPercent: 25, windowMinutes: 43200 },
      providerCost: { used: 12.5, limit: 50, currencyCode: "USD", period: "Monthly", balance: 7.5 },
    });
  });

  it("maps OpenCode Go web quota plus optional Zen balance", async () => {
    const snapshot = await opencodego.fetchUsage(
      context((request) => {
        if (request.url.searchParams.get("id")?.startsWith("def"))
          return response('id: "wrk_fixture"');
        if (request.url.searchParams.get("id")?.startsWith("c83"))
          return json({ zenBalanceUSD: 8 });
        if (request.url.pathname.endsWith("/go"))
          return json({
            rollingUsage: { usagePercent: 10, resetInSec: 300 },
            weeklyUsage: { usagePercent: 25, resetInSec: 3600 },
            monthlyUsage: { usagePercent: 50, resetInSec: 86400 },
          });
        throw new Error(`unexpected request ${request.url}`);
      }),
    );
    expect(snapshot).toEqual({
      primary: { usedPercent: 10, windowMinutes: 300, resetsAt: "2026-08-20T12:05:00.000Z" },
      secondary: { usedPercent: 25, windowMinutes: 10080, resetsAt: "2026-08-20T13:00:00.000Z" },
      tertiary: { usedPercent: 50, windowMinutes: 43200, resetsAt: "2026-08-21T12:00:00.000Z" },
      providerCost: { used: 8, limit: 0, currencyCode: "USD", period: "Zen balance" },
    });
  });

  it("prefers the quoted secure API key over web cookies and maps API windows", async () => {
    const calls: Request[] = [];
    const snapshot = await opencodego.fetchUsage(
      context(
        (request) => {
          calls.push(request);
          expect(request.url.href).toBe("https://opencode.ai/zen/go/v1/usage");
          expect(request.options).toMatchObject({
            headers: {
              Authorization: "Bearer go-fixture",
              Accept: "application/json",
              "User-Agent": "CodexBar",
            },
          });
          return json({
            usage: {
              rolling: { percent: 10, resetsAt: "2026-08-20T12:05:00.000Z" },
              weekly: { percent: 25, resetsAt: "2026-08-20T13:00:00.000Z" },
              monthly: { percent: 50, resetsAt: "2026-08-21T12:00:00.000Z" },
            },
          });
        },
        { OPENCODE_API_KEY: '  "go-fixture"  ' },
      ),
    );
    expect(calls).toHaveLength(1);
    expect(snapshot).toEqual({
      primary: { usedPercent: 10, windowMinutes: 300, resetsAt: "2026-08-20T12:05:00.000Z" },
      secondary: { usedPercent: 25, windowMinutes: 10080, resetsAt: "2026-08-20T13:00:00.000Z" },
      tertiary: { usedPercent: 50, windowMinutes: 43200, resetsAt: "2026-08-21T12:00:00.000Z" },
    });
  });

  it("classifies OpenCode Go API key rejection as expired authentication", async () => {
    await expect(
      opencodego.fetchUsage(
        context(() => response("unauthorized", 401), { OPENCODE_API_KEY: "go-fixture" }),
      ),
    ).rejects.toThrow("authentication-expired");
    await expect(
      opencodego.fetchUsage(
        context(() => response("forbidden", 403), { OPENCODE_API_KEY: "go-fixture" }),
      ),
    ).rejects.toThrow("authentication-expired");
  });
});
