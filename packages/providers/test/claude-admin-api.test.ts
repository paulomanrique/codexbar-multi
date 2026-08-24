import { describe, expect, it } from "vite-plus/test";

import {
  claudeAdminDailyRange,
  cleanClaudeAdminAPIKey,
  fetchClaudeAdminAPIUsage,
  normalizeClaudeAdminAPIKey,
  parseClaudeAdminAPIUsage,
} from "../src/providers/claude-admin-api.ts";
import { claude } from "../src/providers/claude.ts";
import type { ProviderContext, ProviderJSONResponse, ProviderResponse } from "../src/types.ts";

type Request = {
  readonly method: "GET" | "POST";
  readonly url: URL;
  readonly options?: Record<string, unknown>;
};

type Classified = Error & { readonly kind: string };

const classified =
  (kind: string) =>
  (message: string): Classified =>
    Object.assign(new Error(`${kind}: ${message}`), { kind });

const jsonResponse = (json: unknown, status = 200): ProviderJSONResponse => ({
  status,
  bodyText: JSON.stringify(json),
  json,
});

const textResponse = (bodyText: string, status = 200): ProviderResponse => ({
  status,
  bodyText,
});

const context = (
  handler: (request: Request) => ProviderResponse | ProviderJSONResponse,
  settings: Record<string, string> = {},
  now = "2023-11-17T00:00:00Z",
): ProviderContext => {
  const request = async (method: "GET" | "POST", url: string, options?: Record<string, unknown>) =>
    handler({ method, url: new URL(url), ...(options ? { options } : {}) });
  return {
    settings: { get: (key) => settings[key], getSecret: (key) => settings[key] },
    http: {
      get: (url, options) => request("GET", url, options),
      getJSON: async (url, options) => {
        const result = await request("GET", url, options);
        return {
          ...result,
          json: "json" in result ? result.json : JSON.parse(result.bodyText),
        };
      },
      postJSON: async (url, options) => {
        const result = await request("POST", url, options);
        return {
          ...result,
          json: "json" in result ? result.json : JSON.parse(result.bodyText),
        };
      },
    },
    browser: { cookieHeader: async () => "" },
    env: {},
    date: {
      now: () => new Date(now),
      nowMillis: () => Date.parse(now),
      iso: (value) => new Date(value).toISOString(),
      unixSeconds: (value) => new Date(value * 1_000).toISOString(),
      unixMillis: (value) => new Date(value).toISOString(),
      nextDailyReset: () => "",
    },
    format: {
      number: (value, options) =>
        new Intl.NumberFormat("en-US", options as Intl.NumberFormatOptions).format(value),
      usd: (value) =>
        new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value),
      monthDay: () => "",
    },
    pct: (used, limit) => (used / limit) * 100,
    amountFromPercent: (percent, limit) => (percent / 100) * limit,
    fail: {
      authenticationExpired: classified("authentication-expired"),
      missingCredential: classified("missing-credential"),
      permissionDenied: classified("permission-denied"),
      rateLimited: classified("rate-limited"),
      providerUnavailable: classified("provider-unavailable"),
      parseFailure: classified("parse-failure"),
      networkFailure: classified("network-failure"),
      apiFailure: classified("api-failure"),
    },
  };
};

const costsFixture = {
  data: [
    {
      starting_at: "2023-11-14T00:00:00Z",
      ending_at: "2023-11-15T00:00:00Z",
      results: [
        {
          currency: "USD",
          amount: "12345.00",
          description: "Claude Sonnet 4 Usage - Input Tokens",
          cost_type: "tokens",
        },
        {
          currency: "USD",
          amount: "2500.00",
          description: "Web Search Usage",
          cost_type: "web_search",
        },
      ],
    },
    {
      starting_at: "2023-11-15T00:00:00Z",
      ending_at: "2023-11-16T00:00:00Z",
      results: [
        {
          currency: "USD",
          amount: "5000",
          description: "Claude Haiku Usage - Output Tokens",
          cost_type: "tokens",
        },
      ],
    },
    {
      starting_at: "not-a-date",
      ending_at: "2023-11-17T00:00:00Z",
      results: [{ amount: "900000", description: "Invalid date" }],
    },
    {
      starting_at: "2099-01-01T00:00:00Z",
      ending_at: "2099-01-02T00:00:00Z",
      results: [{ amount: "900000", description: "Future" }],
    },
  ],
  has_more: false,
  next_page: null,
};

const messagesFixture = {
  data: [
    {
      starting_at: "2023-11-14T00:00:00Z",
      ending_at: "2023-11-15T00:00:00Z",
      results: [
        {
          uncached_input_tokens: 1500,
          cache_creation: {
            ephemeral_1h_input_tokens: 1000,
            ephemeral_5m_input_tokens: 500,
          },
          cache_read_input_tokens: 200,
          output_tokens: 500,
          model: "claude-sonnet-4-20250514",
        },
        {
          uncached_input_tokens: 100,
          output_tokens: 50,
          model: "claude-opus-4-20250514",
        },
      ],
    },
    {
      starting_at: "2023-11-15T00:00:00Z",
      ending_at: "2023-11-16T00:00:00Z",
      results: [
        {
          uncached_input_tokens: 200,
          cache_read_input_tokens: 300,
          output_tokens: 100,
          model: "claude-sonnet-4-20250514",
        },
      ],
    },
    {
      starting_at: "2099-01-01T00:00:00Z",
      ending_at: "2099-01-02T00:00:00Z",
      results: [{ uncached_input_tokens: 999999, model: "future" }],
    },
  ],
  has_more: false,
  next_page: null,
};

describe("Claude Admin API parity", () => {
  it("normalizes only Anthropic Admin API keys before OAuth/web routing", () => {
    expect(cleanClaudeAdminAPIKey(" ' arbitrary-admin-secret ' ")).toBe("arbitrary-admin-secret");
    expect(normalizeClaudeAdminAPIKey("Bearer sk-ant-admin-fixture")).toBe("sk-ant-admin-fixture");
    expect(normalizeClaudeAdminAPIKey(" sk-ant-admin-fixture ")).toBe("sk-ant-admin-fixture");
    expect(normalizeClaudeAdminAPIKey("sk-ant-oat-oauth")).toBeUndefined();
    expect(normalizeClaudeAdminAPIKey("Cookie: sessionKey=sk-ant-admin-fixture")).toBeUndefined();
    expect(normalizeClaudeAdminAPIKey("sk-ant-admin-fixture=value")).toBeUndefined();
  });

  it("prefers the primary Admin key and accepts the alternate ambient key", async () => {
    for (const [settings, expected] of [
      [
        {
          ANTHROPIC_ADMIN_KEY: "sk-ant-admin-primary",
          ANTHROPIC_ADMIN_API_KEY: "sk-ant-admin-alternate",
        },
        "sk-ant-admin-primary",
      ],
      [{ ANTHROPIC_ADMIN_API_KEY: "'opaque-admin-key'" }, "opaque-admin-key"],
    ] as const) {
      const seenKeys: string[] = [];
      await claude.fetchUsage(
        context((request) => {
          const headers = request.options?.headers as Record<string, string> | undefined;
          if (headers?.["x-api-key"] !== undefined) seenKeys.push(headers["x-api-key"]);
          return jsonResponse({ data: [], has_more: false, next_page: null });
        }, settings),
      );
      expect(seenKeys).toEqual([expected, expected]);
    }
  });

  it("parses Anthropic cost and messages usage into the Swift fixture totals", () => {
    const snapshot = parseClaudeAdminAPIUsage(
      costsFixture,
      messagesFixture,
      context(() => jsonResponse({})),
    );

    expect(snapshot).toMatchObject({
      providerCost: { used: 198.45, limit: 0, currencyCode: "USD", period: "Last 30 days" },
      identity: { providerId: "claude", loginMethod: "Admin API" },
    });
    expect(snapshot).not.toHaveProperty("primary");
    expect(snapshot).not.toHaveProperty("secondary");
    expect(snapshot.details[0]?.rows).toEqual([
      { label: "Today spend", value: "$0.00" },
      { label: "7d spend", value: "$198.45" },
      { label: "30d spend", value: "$198.45" },
      { label: "Today tokens", value: "0" },
      { label: "30d tokens", value: "4,450" },
      { label: "Cache read", value: "500" },
      { label: "Top model", value: "claude-sonnet-4-20250514" },
    ]);
    expect(snapshot.details[0]?.chart?.points).toEqual([
      { label: "2023-11-14", value: 148.45 },
      { label: "2023-11-15", value: 50 },
    ]);
    expect(snapshot.details[1]?.rows[0]).toEqual({
      label: "Claude Sonnet 4 Usage - Input Tokens",
      value: "$123.45",
    });
  });

  it("uses the fixed Admin API request shape and never sends organization ID", async () => {
    const calls: Request[] = [];
    await fetchClaudeAdminAPIUsage(
      context(
        (request) => {
          calls.push(request);
          return request.url.pathname.endsWith("/cost_report")
            ? jsonResponse(costsFixture)
            : jsonResponse(messagesFixture);
        },
        { CLAUDE_ORGANIZATION_ID: "org-should-not-send" },
        "2026-08-24T12:34:56Z",
      ),
      "Bearer sk-ant-admin-secret",
    );

    expect(claudeAdminDailyRange(new Date("2026-08-24T12:34:56Z"))).toEqual({
      startingAt: "2026-07-25T00:00:00Z",
      endingAt: "2026-08-25T00:00:00Z",
    });
    expect(calls.map((call) => call.url.origin + call.url.pathname)).toEqual([
      "https://api.anthropic.com/v1/organizations/cost_report",
      "https://api.anthropic.com/v1/organizations/usage_report/messages",
    ]);
    expect(calls.map((call) => call.url.searchParams.get("group_by[]"))).toEqual([
      "description",
      "model",
    ]);
    for (const call of calls) {
      expect(call.method).toBe("GET");
      expect(call.url.searchParams.get("starting_at")).toBe("2026-07-25T00:00:00Z");
      expect(call.url.searchParams.get("ending_at")).toBe("2026-08-25T00:00:00Z");
      expect(call.url.searchParams.get("bucket_width")).toBe("1d");
      expect(call.url.searchParams.get("limit")).toBe("31");
      expect(call.url.href).not.toContain("org-should-not-send");
      expect(call.options?.headers).toEqual({
        "x-api-key": "Bearer sk-ant-admin-secret",
        "anthropic-version": "2023-06-01",
        Accept: "application/json",
        "User-Agent": "CodexBar/1.0",
      });
    }
  });

  it("drops dates outside Swift ISO8601 internet-date parsing", () => {
    const snapshot = parseClaudeAdminAPIUsage(
      {
        data: [
          {
            starting_at: "2023-02-30T00:00:00Z",
            ending_at: "2023-03-01T00:00:00Z",
            results: [{ amount: "100", description: "Invalid calendar date" }],
          },
          {
            starting_at: "2023-11-14 00:00:00Z",
            ending_at: "2023-11-15T00:00:00Z",
            results: [{ amount: "100", description: "Invalid separator" }],
          },
        ],
      },
      { data: [] },
      context(() => jsonResponse({})),
    );
    expect(snapshot.providerCost?.used).toBe(0);
    expect(snapshot.details[0]?.chart).toBeUndefined();
  });

  it.each([
    [401, "authentication-expired"],
    [403, "permission-denied"],
    [429, "rate-limited"],
    [500, "api-failure"],
  ] as const)("classifies Admin API HTTP %i as %s", async (status, kind) => {
    await expect(
      fetchClaudeAdminAPIUsage(
        context(() => jsonResponse({}, status)),
        "sk-ant-admin-secret",
      ),
    ).rejects.toMatchObject({ kind });
  });

  it("fails malformed Admin API shapes as parse-failure", () => {
    expect(() =>
      parseClaudeAdminAPIUsage(
        { data: {} },
        messagesFixture,
        context(() => jsonResponse({})),
      ),
    ).toThrow("parse-failure");
  });

  it("matches a configured Claude web organization exactly and fails closed when absent", async () => {
    const calls: Request[] = [];
    const snapshot = await claude.fetchUsage(
      context(
        (request) => {
          calls.push(request);
          if (request.url.pathname === "/api/organizations") {
            return jsonResponse([
              { uuid: "org-first", name: "First" },
              { uuid: "org-selected", name: "Selected" },
            ]);
          }
          return jsonResponse({
            five_hour: { utilization: 10 },
            seven_day: { utilization: 20 },
          });
        },
        {
          CLAUDE_COOKIE_HEADER: "sessionKey=selected-cookie",
          CLAUDE_ORGANIZATION_ID: " org-selected ",
        },
      ),
    );
    expect(calls.map((call) => call.url.pathname)).toEqual([
      "/api/organizations",
      "/api/organizations/org-selected/usage",
    ]);
    expect(snapshot.identity).toMatchObject({
      providerId: "claude",
      accountOrganization: "Selected",
      loginMethod: "Cookie",
    });

    await expect(
      claude.fetchUsage(
        context(
          (request) =>
            request.url.pathname === "/api/organizations"
              ? jsonResponse([{ uuid: "org-first", name: "First" }])
              : textResponse("not used"),
          { CLAUDE_COOKIE_HEADER: "sessionKey=selected-cookie", CLAUDE_ORGANIZATION_ID: "missing" },
        ),
      ),
    ).rejects.toMatchObject({ kind: "permission-denied" });
  });
});
