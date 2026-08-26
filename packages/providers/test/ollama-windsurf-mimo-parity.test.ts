import { describe, expect, it } from "vite-plus/test";

import { mimo } from "../src/providers/mimo.ts";
import { normalizeOllamaTokenAccountHeader, ollama } from "../src/providers/ollama.ts";
import { windsurf } from "../src/providers/windsurf.ts";
import type { ProviderContext, ProviderResponse } from "../src/types.ts";

type Request = {
  readonly method: "GET" | "POST";
  readonly url: URL;
  readonly options?: Record<string, unknown>;
};
const fail = (kind: string) => (message: string) => new Error(`${kind}: ${message}`);
const json = (value: unknown, status = 200): ProviderResponse => ({
  status,
  bodyText: JSON.stringify(value),
});
const context = (
  callback: (request: Request) => ProviderResponse,
  settings: Record<string, string> = {},
): ProviderContext => {
  const request = async (method: "GET" | "POST", url: string, options?: Record<string, unknown>) =>
    callback({ method, url: new URL(url), ...(options ? { options } : {}) });
  return {
    settings: { get: (key) => settings[key], getSecret: (key) => settings[key] },
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
    browser: { cookieHeader: async () => "" },
    env: {},
    date: {
      now: () => new Date("2026-08-20T12:00:00Z"),
      nowMillis: () => Date.parse("2026-08-20T12:00:00Z"),
      iso: (value) => new Date(value).toISOString(),
      unixSeconds: (value) => new Date(value * 1_000).toISOString(),
      unixMillis: (value) => new Date(value).toISOString(),
      nextDailyReset: () => "2026-08-21T00:00:00Z",
    },
    format: {
      number: (value, options) =>
        new Intl.NumberFormat("en-US", options as Intl.NumberFormatOptions).format(value),
      usd: (value) => `$${value.toFixed(2)}`,
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

describe("Ollama, Windsurf, and MiMo Swift-derived provider parity", () => {
  it("keeps IDs and declarative browser capabilities", () => {
    expect([ollama, windsurf, mimo].map((provider) => provider.descriptor.id)).toEqual([
      "ollama",
      "windsurf",
      "mimo",
    ]);
    for (const provider of [ollama, windsurf, mimo])
      expect(provider.descriptor.capabilities).toEqual(["browser-cookies"]);
    expect(ollama.strategies?.map(({ id, kind }) => [id, kind])).toEqual([
      ["ollama.web", "web"],
      ["ollama.api", "api"],
    ]);
  });
  it.each([
    ["opaque-session", "__Secure-session=opaque-session"],
    [" \n opaque-session== \t", "__Secure-session=opaque-session=="],
    ["opaque-session==", "__Secure-session=opaque-session=="],
    ["foo=bar", "__Secure-session=foo=bar"],
    ["__secure-session=abc", "__Secure-session=abc"],
    ["session=abc", "session=abc"],
    ["ollama_session=abc", "ollama_session=abc"],
    ["__Host-ollama_session=abc", "__Host-ollama_session=abc"],
    ["wos-session=abc; theme=dark", "wos-session=abc; theme=dark"],
    [
      "__Secure-next-auth.session-token.0=zero; __Secure-next-auth.session-token.1=one",
      "__Secure-next-auth.session-token.0=zero; __Secure-next-auth.session-token.1=one",
    ],
    [
      "next-auth.session-token.0=zero; next-auth.session-token.1=one",
      "next-auth.session-token.0=zero; next-auth.session-token.1=one",
    ],
    ["theme=dark; locale=en", "theme=dark; locale=en"],
    ["Cookie: __Secure-session=abc", "__Secure-session=abc"],
    ["Cookie: opaque-value", "__Secure-session=opaque-value"],
    ["curl https://ollama.com -H 'Cookie: __Secure-session=abc'", "__Secure-session=abc"],
    ["curl https://ollama.com -H Cookie:__Secure-session=abc", "__Secure-session=abc"],
    ["curl https://ollama.com --cookie '__Secure-session=abc'", "__Secure-session=abc"],
    ["curl https://ollama.com -b'__Secure-session=abc'", "__Secure-session=abc"],
  ] as const)("normalizes Ollama token account material %s", (material, expected) => {
    expect(normalizeOllamaTokenAccountHeader(material)).toBe(expected);
  });
  it.each(["", " \t\n ", "abc\r\nInjected: yes", "curl https://ollama.com/settings"])(
    "rejects invalid Ollama token material %s",
    (material) => expect(normalizeOllamaTokenAccountHeader(material)).toBeUndefined(),
  );
  it("parses Ollama settings HTML session and weekly windows", async () => {
    const raw = await ollama.fetchUsage(
      context(
        () => ({
          status: 200,
          bodyText:
            '<span>Cloud Usage</span><span>free</span><div id="header-email">user@example.com</div><span>Session usage</span><span>0.1% used</span><div data-time="2026-08-20T14:00:00Z"></div><span>Weekly usage</span><span>0.7% used</span><div data-time="2026-08-25T00:00:00Z"></div>',
        }),
        { OLLAMA_COOKIE: "__Secure-session=fixture" },
      ),
    );
    expect(raw).toMatchObject({
      primary: { usedPercent: 0.1, windowMinutes: 300 },
      secondary: { usedPercent: 0.7, windowMinutes: 10_080 },
      identity: { loginMethod: "free", accountEmail: "user@example.com" },
    });
  });
  it("validates the Ollama API key with POST before reading tags", async () => {
    const requests: Request[] = [];
    const base = context(
      (request) => {
        requests.push(request);
        return request.url.pathname.endsWith("/web_search")
          ? { status: 400, bodyText: "validation reached" }
          : json({ models: [{ name: "fixture" }] });
      },
      { OLLAMA_API_KEY: " 'api-key' " },
    );
    const raw = await ollama.fetchUsage({
      ...base,
      sourceMode: "api",
      browser: {
        cookieHeader: async () => {
          throw new Error("explicit API mode must not read browser cookies");
        },
      },
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      method: "POST",
      options: {
        body: { query: "" },
        timeoutSeconds: 20,
        headers: {
          Authorization: "Bearer api-key",
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": "CodexBar/1.0",
        },
      },
    });
    expect(requests[1]).toMatchObject({
      method: "GET",
      options: { timeoutSeconds: 20 },
    });
    expect(raw).toEqual({ identity: { loginMethod: "API key" } });
  });
  it.each([401, 403] as const)(
    "classifies Ollama validation HTTP %i as expired auth",
    async (code) => {
      const strategy = ollama.strategies?.find(({ id }) => id === "ollama.api");
      await expect(
        strategy!.fetchUsage(
          context(() => ({ status: code, bodyText: "rejected" }), {
            OLLAMA_API_KEY: "api-key",
          }),
        ),
      ).rejects.toThrow("authentication-expired:");
    },
  );
  it("classifies other Ollama validation failures as network errors", async () => {
    const strategy = ollama.strategies?.find(({ id }) => id === "ollama.api");
    await expect(
      strategy!.fetchUsage(
        context(() => ({ status: 500, bodyText: "unavailable" }), {
          OLLAMA_API_KEY: "api-key",
        }),
      ),
    ).rejects.toThrow("network-failure:");
  });
  it.each([
    [401, "authentication-expired"],
    [403, "authentication-expired"],
    [500, "network-failure"],
  ] as const)("classifies Ollama tags HTTP %i as %s", async (code, kind) => {
    const strategy = ollama.strategies?.find(({ id }) => id === "ollama.api");
    await expect(
      strategy!.fetchUsage(
        context(
          (request) =>
            request.url.pathname.endsWith("/web_search")
              ? { status: 200, bodyText: "accepted" }
              : json({}, code),
          { OLLAMA_API_KEY: "api-key" },
        ),
      ),
    ).rejects.toThrow(`${kind}:`);
  });
  it("rejects Ollama tags payloads without a models array", async () => {
    const strategy = ollama.strategies?.find(({ id }) => id === "ollama.api");
    await expect(
      strategy!.fetchUsage(
        context(
          (request) =>
            request.url.pathname.endsWith("/web_search")
              ? { status: 400, bodyText: "accepted" }
              : json({ models: "invalid" }),
          { OLLAMA_API_KEY: "api-key" },
        ),
      ),
    ).rejects.toThrow("parse-failure:");
  });
  it("preserves Windsurf session headers and daily/weekly response mapping", async () => {
    let request: Request | undefined;
    const raw = await windsurf.fetchUsage(
      context(
        (candidate) => {
          request = candidate;
          return json({
            planStatus: {
              planInfo: { planName: "Pro" },
              dailyQuotaRemainingPercent: 64,
              weeklyQuotaRemainingPercent: 80,
              dailyQuotaResetAtUnix: 1_800_000_000,
              weeklyQuotaResetAtUnix: 1_800_100_000,
            },
          });
        },
        {
          WINDSURF_SESSION: JSON.stringify({
            devin_session_token: "session",
            devin_auth1_token: "auth",
            devin_account_id: "account",
            devin_primary_org_id: "org",
          }),
        },
      ),
    );
    expect(request?.options).toMatchObject({
      headers: {
        "x-devin-session-token": "session",
        "x-devin-auth1-token": "auth",
        "x-devin-account-id": "account",
        "x-devin-primary-org-id": "org",
        "Connect-Protocol-Version": "1",
      },
    });
    expect(raw).toMatchObject({
      primary: { usedPercent: 36 },
      secondary: { usedPercent: 20 },
      identity: { loginMethod: "Pro" },
    });
  });
  it("combines MiMo balance and optional token-plan data", async () => {
    const raw = await mimo.fetchUsage(
      context(
        (request) =>
          request.url.pathname.endsWith("/balance")
            ? json({
                code: 0,
                data: { balance: "25.51", cashBalance: "20", giftBalance: "5.51", currency: "USD" },
              })
            : request.url.pathname.endsWith("/detail")
              ? json({
                  code: 0,
                  data: { planCode: "standard", currentPeriodEnd: "2026-09-01 00:00:00" },
                })
              : json({
                  code: 0,
                  data: {
                    monthUsage: { percent: 0.1, items: [{ used: 10, limit: 100, percent: 0.1 }] },
                  },
                }),
        { MIMO_COOKIE: "api-platform_serviceToken=token; userId=user" },
      ),
    );
    expect(raw).toMatchObject({
      primary: { usedPercent: 10, resetDescription: "10 / 100 Credits" },
      details: [{ rows: [{ label: "Balance", value: "$25.51 (Paid: $20.00 / Granted: $5.51)" }] }],
      identity: { loginMethod: "Standard" },
    });
  });
});
