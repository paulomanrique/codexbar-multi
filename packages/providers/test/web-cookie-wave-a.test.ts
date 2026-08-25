import { describe, expect, it } from "vite-plus/test";

import { cursor } from "../src/providers/cursor.ts";
import { opencode } from "../src/providers/opencode.ts";
import { opencodego } from "../src/providers/opencodego.ts";
import { openCodeRequestCookieHeader } from "../src/providers/open-code-cookie.ts";
import type { ProviderContext, ProviderResponse } from "../src/types.ts";

type Request = {
  readonly method: "GET" | "POST";
  readonly url: URL;
  readonly options?: Record<string, unknown>;
};
const now = new Date("2026-08-20T12:00:00.000Z");
const failure = (kind: string) => (message: string) => new Error(`${kind}: ${message}`);
const response = (bodyText: string, status = 200): ProviderResponse => ({ status, bodyText });
const json = (value: unknown, status = 200): ProviderResponse =>
  response(JSON.stringify(value), status);
function context(
  handler: (request: Request) => ProviderResponse,
  secrets: Record<string, string> = {},
): ProviderContext {
  const request = async (method: "GET" | "POST", url: string, options?: Record<string, unknown>) =>
    handler({ method, url: new URL(url), ...(options ? { options } : {}) });
  return {
    settings: { get: (key) => secrets[key], getSecret: (key) => secrets[key] },
    http: {
      get: (url, options) => request("GET", url, options),
      post: (url, options) => request("POST", url, options),
      getJSON: async (url, options) => {
        const result = await request("GET", url, options);
        return { ...result, json: JSON.parse(result.bodyText) as unknown };
      },
      postJSON: async (url, options) => {
        const result = await request("POST", url, options);
        return { ...result, json: JSON.parse(result.bodyText) as unknown };
      },
    },
    browser: { cookieHeader: async () => "auth=fixture; provider=google" },
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
  it.each([
    [
      "provider=google; auth=session123; theme=dark; __Host-auth=host456",
      "auth=session123; __Host-auth=host456",
    ],
    ["Cookie: auth=one; auth=two", "auth=one; auth=two"],
    ["curl https://opencode.ai -H 'Cookie: __Host-auth=host; theme=dark'", "__Host-auth=host"],
    ["Auth=x; AUTH=y; __host-auth=z", undefined],
    ["account-token", undefined],
    ["auth=value\u0000suffix", undefined],
    [`auth=value; ignored=${"x".repeat(1024 * 1024)}`, undefined],
  ] as const)("normalizes the OpenCode request cookie %s", (raw, expected) => {
    expect(openCodeRequestCookieHeader(raw)).toBe(expected);
  });

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
        return json({
          customerID: "cus_fixture",
          monthlyUsage: 1_250_000_000,
          monthlyLimit: 50,
          balance: 750_000_000,
          subscription: null,
        });
      }),
    );
    expect(snapshot).toEqual({
      primary: { usedPercent: 25, windowMinutes: 43200 },
      providerCost: { used: 12.5, limit: 50, currencyCode: "USD", period: "Monthly", balance: 7.5 },
    });
  });

  it("retries a malformed OpenCode subscription with the Swift-compatible POST", async () => {
    const calls: Request[] = [];
    const snapshot = await opencode.fetchUsage(
      context(
        (request) => {
          calls.push(request);
          if (request.method === "GET") return json({ ok: true });
          expect(request.url.href).toBe("https://opencode.ai/_server");
          expect(request.options).toMatchObject({
            body: ["wrk_fixture"],
            headers: { "Content-Type": "application/json" },
          });
          return json({
            rollingUsage: { usagePercent: 22, resetInSec: 300 },
            weeklyUsage: { usagePercent: 44, resetInSec: 3600 },
          });
        },
        { OPENCODE_WORKSPACE_ID: "wrk_fixture" },
      ),
    );
    expect(calls.map(({ method }) => method)).toEqual(["GET", "POST"]);
    expect(snapshot).toMatchObject({
      primary: { usedPercent: 22 },
      secondary: { usedPercent: 44 },
    });
  });

  it("uses billing after an eligible OpenCode subscription API error", async () => {
    const calls: Request[] = [];
    const snapshot = await opencode.fetchUsage(
      context(
        (request) => {
          calls.push(request);
          return calls.length === 1
            ? response('{"detail":"subscription unavailable"}', 500)
            : json({
                customerID: "cus_fixture",
                monthlyUsage: 1_500_000_000,
                monthlyLimit: 20,
                balance: 1_250_000_000,
                subscription: null,
              });
        },
        { OPENCODE_WORKSPACE_ID: "wrk_fixture" },
      ),
    );
    expect(calls.map(({ method }) => method)).toEqual(["GET", "GET"]);
    expect(snapshot.providerCost).toMatchObject({ used: 15, limit: 20, balance: 12.5 });
  });

  it("uses billing after the OpenCode subscription POST also fails", async () => {
    const calls: Request[] = [];
    const snapshot = await opencode.fetchUsage(
      context(
        (request) => {
          calls.push(request);
          if (calls.length === 1) return json({ ok: true });
          if (request.method === "POST") return response("server function failed", 500);
          return json({
            customerID: "cus_fixture",
            monthlyUsage: 1_500_000_000,
            monthlyLimit: 20,
            balance: 1_250_000_000,
            subscription: null,
          });
        },
        { OPENCODE_WORKSPACE_ID: "wrk_fixture" },
      ),
    );
    expect(calls.map(({ method }) => method)).toEqual(["GET", "POST", "GET"]);
    expect(snapshot.providerCost).toMatchObject({ used: 15, limit: 20, balance: 12.5 });
  });

  it("preserves the subscription failure when billing still has a subscription", async () => {
    let calls = 0;
    await expect(
      opencode.fetchUsage(
        context(
          () => {
            calls += 1;
            return calls === 1
              ? response("subscription failed", 500)
              : json({
                  customerID: "cus_fixture",
                  subscription: { id: "sub_fixture" },
                  monthlyUsage: 1_500_000_000,
                  monthlyLimit: 20,
                });
          },
          { OPENCODE_WORKSPACE_ID: "wrk_fixture" },
        ),
      ),
    ).rejects.toThrow("api-failure");
    expect(calls).toBe(2);
  });

  it("surfaces expired authentication from the OpenCode billing fallback", async () => {
    let calls = 0;
    await expect(
      opencode.fetchUsage(
        context(
          () => {
            calls += 1;
            return calls === 1 ? response("null") : response("Please sign in", 200);
          },
          { OPENCODE_WORKSPACE_ID: "wrk_fixture" },
        ),
      ),
    ).rejects.toThrow("authentication-expired");
    expect(calls).toBe(2);
  });

  it.each([401, 403])("keeps OpenCode HTTP %s terminal without billing", async (status) => {
    let calls = 0;
    await expect(
      opencode.fetchUsage(
        context(
          () => {
            calls += 1;
            return response("unauthorized", status);
          },
          { OPENCODE_WORKSPACE_ID: "wrk_fixture" },
        ),
      ),
    ).rejects.toThrow("authentication-expired");
    expect(calls).toBe(1);
  });

  it("keeps an OpenCode subscription transport failure terminal without billing", async () => {
    let calls = 0;
    const transportFailure = new Error("offline");
    await expect(
      opencode.fetchUsage(
        context(
          () => {
            calls += 1;
            throw transportFailure;
          },
          { OPENCODE_WORKSPACE_ID: "wrk_fixture" },
        ),
      ),
    ).rejects.toBe(transportFailure);
    expect(calls).toBe(1);
  });

  it("filters the manual OpenCode cookie again at the request boundary", async () => {
    const cookies: string[] = [];
    await opencode.fetchUsage(
      context(
        (request) => {
          cookies.push(
            ((request.options?.headers ?? {}) as Record<string, string>).Cookie ?? "missing",
          );
          return json({
            rollingUsage: { usagePercent: 10, resetInSec: 300 },
            weeklyUsage: { usagePercent: 20, resetInSec: 600 },
          });
        },
        {
          OPENCODE_COOKIE: "provider=google; auth=selected; theme=dark; __Host-auth=selected-host",
          OPENCODE_WORKSPACE_ID: "wrk_fixture",
        },
      ),
    );
    expect(cookies).toEqual(["auth=selected; __Host-auth=selected-host"]);
  });

  it("rejects an invalid manual OpenCode cookie without consulting the browser", async () => {
    let requests = 0;
    const ctx = context(
      () => {
        requests += 1;
        return response("unexpected");
      },
      { OPENCODE_COOKIE: "provider=google; theme=dark", OPENCODE_WORKSPACE_ID: "wrk_fixture" },
    );
    let browserCalls = 0;
    await expect(
      opencode.fetchUsage({
        ...ctx,
        browser: {
          cookieHeader: async () => {
            browserCalls += 1;
            return "auth=ambient";
          },
        },
      }),
    ).rejects.toThrow("missing-credential");
    expect(browserCalls).toBe(0);
    expect(requests).toBe(0);
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

  it("falls back from a failed Auto API request to the existing cookie session", async () => {
    const calls: URL[] = [];
    const snapshot = await opencodego.fetchUsage({
      ...context(
        (request) => {
          calls.push(request.url);
          if (request.url.pathname === "/zen/go/v1/usage") return response("unavailable", 503);
          if (request.url.pathname.endsWith("/go"))
            return json({ rollingUsage: { usagePercent: 15, resetInSec: 600 } });
          if (request.url.searchParams.get("id")?.startsWith("c83"))
            return json({ zenBalanceUSD: 7 });
          throw new Error(`unexpected request ${request.url}`);
        },
        {
          OPENCODE_API_KEY: "go-fixture",
          OPENCODEGO_WORKSPACE_ID: "wrk_fixture",
        },
      ),
      sourceMode: "auto",
    });

    expect(calls.map((call) => call.pathname)).toEqual([
      "/zen/go/v1/usage",
      "/workspace/wrk_fixture/go",
      "/_server",
    ]);
    expect(snapshot).toEqual({
      primary: { usedPercent: 15, windowMinutes: 300, resetsAt: "2026-08-20T12:10:00.000Z" },
      providerCost: { used: 7, limit: 0, currencyCode: "USD", period: "Zen balance" },
    });
  });

  it("does not turn an aborted Auto API request into a cookie request", async () => {
    const cancelled = Object.assign(new Error("cancelled"), { name: "AbortError" });
    let calls = 0;
    await expect(
      opencodego.fetchUsage({
        ...context(
          () => {
            calls += 1;
            throw cancelled;
          },
          { OPENCODE_API_KEY: "go-fixture" },
        ),
        sourceMode: "auto",
      }),
    ).rejects.toBe(cancelled);
    expect(calls).toBe(1);
  });
});
