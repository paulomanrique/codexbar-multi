import { describe, expect, it } from "vite-plus/test";

import { aiand } from "../src/providers/aiand.ts";
import { codebuff } from "../src/providers/codebuff.ts";
import { elevenlabs } from "../src/providers/elevenlabs.ts";
import { llmproxy } from "../src/providers/llmproxy.ts";
import { neuralwatt } from "../src/providers/neuralwatt.ts";
import type { ProviderContext, ProviderResponse } from "../src/types.ts";

const now = new Date("2026-08-20T12:00:00.000Z");
type Request = {
  readonly method: string;
  readonly url: URL;
  readonly options?: Record<string, unknown>;
};
type Fixture = (request: Request) => ProviderResponse;

const errorFactory = (kind: string) => (message: string) => new Error(`${kind}: ${message}`);

function context(
  fixture: Fixture,
  settings: Readonly<Record<string, string>> = {},
  requests: Request[] = [],
): ProviderContext {
  const request = async (method: string, url: string, options?: Record<string, unknown>) => {
    const recorded = { method, url: new URL(url), ...(options === undefined ? {} : { options }) };
    requests.push(recorded);
    return fixture(recorded);
  };
  return {
    settings: { get: (key) => settings[key], getSecret: (key) => settings[key] },
    http: {
      get: (url, options) => request("GET", url, options),
      getJSON: async (url, options) => {
        const response = await request("GET", url, options);
        return { ...response, json: JSON.parse(response.bodyText) as unknown };
      },
      postJSON: async (url, options) => {
        const response = await request("POST", url, options);
        return { ...response, json: JSON.parse(response.bodyText) as unknown };
      },
    },
    browser: { cookieHeader: async () => "" },
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
      number: (value) => new Intl.NumberFormat("en-US").format(value),
      usd: (value) => `$${value.toFixed(2)}`,
      monthDay: (value) => value.toISOString().slice(5, 10),
    },
    pct: (used, limit) => (limit > 0 ? (used / limit) * 100 : 100),
    amountFromPercent: (usedPercent, limit) => (usedPercent / 100) * limit,
    fail: {
      authenticationExpired: errorFactory("authentication-expired"),
      missingCredential: errorFactory("missing-credential"),
      permissionDenied: errorFactory("permission-denied"),
      rateLimited: errorFactory("rate-limited"),
      providerUnavailable: errorFactory("provider-unavailable"),
      parseFailure: errorFactory("parse-failure"),
      networkFailure: errorFactory("network-failure"),
      apiFailure: errorFactory("api-failure"),
    },
  };
}

const json = (body: unknown, status = 200): ProviderResponse => ({
  status,
  bodyText: JSON.stringify(body),
});

describe("Swift-derived HTTP provider parity wave three", () => {
  it("keeps descriptor and strategy IDs stable", () => {
    expect([codebuff, elevenlabs, aiand, llmproxy, neuralwatt].map((p) => p.descriptor.id)).toEqual(
      ["codebuff", "elevenlabs", "aiand", "llmproxy", "neuralwatt"],
    );
    expect([codebuff, elevenlabs, aiand, llmproxy, neuralwatt].map((p) => p.id)).toEqual([
      "codebuff.api",
      "elevenlabs.api",
      "aiand.api",
      "llmproxy.api",
      "neuralwatt.api",
    ]);
  });

  it("maps Codebuff credits, subscription weekly quota, email and auto top-up", async () => {
    const requests: Request[] = [];
    const snapshot = await codebuff.fetchUsage(
      context(
        (request) =>
          request.url.pathname === "/api/v1/usage"
            ? json({ usage: 25, quota: 100, remainingBalance: 75, autoTopupEnabled: true })
            : json({
                email: "fixture@example.com",
                subscription: { displayName: "Pro", status: "active" },
                rateLimit: { weeklyUsed: 2100, weeklyLimit: 7000 },
              }),
        { CODEBUFF_API_KEY: "fixture-key" },
        requests,
      ),
    );
    expect(requests.map((request) => request.url.pathname)).toEqual([
      "/api/v1/usage",
      "/api/user/subscription",
    ]);
    expect(requests.map((request) => request.method)).toEqual(["POST", "GET"]);
    expect(requests[0]?.options).toMatchObject({ body: { fingerprintId: "codexbar-usage" } });
    expect(snapshot).toEqual({
      identity: {
        loginMethod: "Pro · 75 remaining · auto top-up",
        email: "fixture@example.com",
      },
      primary: { usedPercent: 25 },
      secondary: { usedPercent: 30, windowMinutes: 10080 },
    });
  });

  it("infers Codebuff total from used plus remaining and shows exhausted degenerate quota", async () => {
    const inferred = await codebuff.fetchUsage(
      context(() => json({ usage: 40, remainingBalance: 60 }), { CODEBUFF_API_KEY: "key" }),
    );
    expect(inferred.primary).toEqual({ usedPercent: 40 });
    const remainingOnly = await codebuff.fetchUsage(
      context(() => json({ remainingBalance: 17 }), { CODEBUFF_API_KEY: "key" }),
    );
    expect(remainingOnly.primary).toEqual({ usedPercent: 100 });
  });

  it("keeps Codebuff primary usage when optional subscription enrichment fails", async () => {
    const snapshot = await codebuff.fetchUsage(
      context(
        (request) => {
          if (request.url.pathname === "/api/v1/usage")
            return json({ usage: 25, quota: 100, remainingBalance: 75, autoTopupEnabled: true });
          throw new Error("subscription timed out");
        },
        { CODEBUFF_API_KEY: "key" },
      ),
    );
    expect(snapshot).toEqual({
      primary: { usedPercent: 25 },
      identity: { loginMethod: "75 remaining · auto top-up" },
    });
  });

  it("matches ElevenLabs reset, extra voice windows, status suffix and XI_API_KEY alias", async () => {
    const requests: Request[] = [];
    const snapshot = await elevenlabs.fetchUsage(
      context(
        () =>
          json({
            tier: "creator",
            character_count: 25_000,
            character_limit: 100_000,
            voice_slots_used: 2,
            voice_limit: 10,
            professional_voice_slots_used: 1,
            professional_voice_limit: 2,
            status: "paused",
            next_character_count_reset_unix: 1_738_356_858,
          }),
        { XI_API_KEY: "xi-test" },
        requests,
      ),
    );
    expect(requests[0]?.options).toMatchObject({ headers: { "xi-api-key": "xi-test" } });
    expect(snapshot).toEqual({
      primary: {
        usedPercent: 25,
        resetDescription: "25,000 / 100,000 credits",
        resetsAt: "2025-01-31T20:54:18.000Z",
      },
      identity: { loginMethod: "Creator · paused" },
      extraRateWindows: [
        {
          id: "voice-slots",
          title: "Voice slots",
          window: { usedPercent: 20, resetDescription: "2 / 10" },
        },
        {
          id: "professional-voices",
          title: "Professional voices",
          window: { usedPercent: 50, resetDescription: "1 / 2" },
        },
      ],
    });
  });

  it("preserves ElevenLabs canonical precedence, cleanup and endpoint composition", async () => {
    for (const [endpoint, expectedPath] of [
      [" 'eleven.example.test/custom' ", "/custom/v1/user/subscription"],
      [' "https://eleven.example.test/custom/v1/" ', "/custom/v1/user/subscription"],
    ] as const) {
      const requests: Request[] = [];
      await elevenlabs.fetchUsage(
        context(
          () => json({ character_count: 1, character_limit: 10 }),
          {
            ELEVENLABS_API_KEY: ' "canonical-key" ',
            XI_API_KEY: "alias-key",
            ELEVENLABS_API_URL: endpoint,
          },
          requests,
        ),
      );
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url.origin).toBe("https://eleven.example.test");
      expect(requests[0]?.url.pathname).toBe(expectedPath);
      expect(requests[0]?.options).toMatchObject({
        headers: { "xi-api-key": "canonical-key", Accept: "application/json" },
      });
    }
  });

  it.each([
    "http://attacker.test",
    "https://user:pass@eleven.test",
    "https://eleven.test%2f.attacker.test",
  ])("rejects an unsafe ElevenLabs endpoint before transport: %s", async (endpoint) => {
    const requests: Request[] = [];
    await expect(
      elevenlabs.fetchUsage(
        context(
          () => json({ character_count: 1, character_limit: 10 }),
          { ELEVENLABS_API_KEY: "fixture-key", ELEVENLABS_API_URL: endpoint },
          requests,
        ),
      ),
    ).rejects.toThrow("api-failure: ElevenLabs endpoint override");
    expect(requests).toHaveLength(0);
  });

  it.each([
    [401, "missing-credential"],
    [403, "missing-credential"],
    [429, "api-failure"],
    [500, "api-failure"],
    [201, "api-failure"],
  ] as const)("classifies ElevenLabs HTTP %s as %s", async (status, kind) => {
    await expect(
      elevenlabs.fetchUsage(
        context(() => json({ character_count: 1, character_limit: 10 }, status), {
          ELEVENLABS_API_KEY: "fixture-key",
        }),
      ),
    ).rejects.toThrow(`${kind}:`);
  });

  it("sums ai& decimal spend exactly, chooses newest currency and rejects malformed logs", async () => {
    const snapshot = await aiand.fetchUsage(
      context(
        () =>
          json({
            data: [
              { cost: "0.1", currency: "usd" },
              { cost: "0.2", currency: "USD" },
            ],
            has_more: false,
          }),
        { AIAND_API_KEY: "fixture-key" },
      ),
    );
    expect(snapshot).toEqual({
      cost: { used: 0.3, limit: 0, currency: "USD", period: "Last 30 days" },
      dataConfidence: "exact",
    });
    await expect(
      aiand.fetchUsage(context(() => json({ object: "list" }), { AIAND_API_KEY: "fixture-key" })),
    ).rejects.toThrow("parse-failure:");
  });

  it("matches ai& pagination order, cursor encoding and the ten-page partial cap", async () => {
    const requests: Request[] = [];
    const completed = await aiand.fetchUsage(
      context(
        (request) =>
          request.url.search.includes("after=")
            ? json({ data: [{ cost: "1.00", currency: "jpy" }], has_more: false })
            : json({
                data: [{ cost: "2.00", currency: "jpy" }],
                has_more: true,
                next_after: "2026-07-17 10:24:30.094374+00",
                next_after_id: "912bf992-0000-4000-8000-000000000002",
              }),
        { AIAND_API_KEY: "fixture-key" },
        requests,
      ),
    );
    expect(completed).toEqual({
      cost: { used: 3, limit: 0, currency: "JPY", period: "Last 30 days" },
      dataConfidence: "exact",
    });
    expect(requests.map((request) => request.url.href)).toEqual([
      "https://api.aiand.com/logs?range=30days&limit=100",
      "https://api.aiand.com/logs?range=30days&limit=100&after=2026-07-17%2010:24:30.094374%2B00&after_id=912bf992-0000-4000-8000-000000000002",
    ]);
    expect(requests[0]?.options).toMatchObject({
      headers: { Authorization: "Bearer fixture-key", Accept: "application/json" },
    });
    expect(requests[0]?.url.href).not.toContain("fixture-key");

    const cappedRequests: Request[] = [];
    const capped = await aiand.fetchUsage(
      context(
        () =>
          json({
            data: [{ cost: "1.00", currency: "jpy" }],
            has_more: true,
            next_after: "",
            next_after_id: "",
          }),
        { AIAND_API_KEY: "fixture-key" },
        cappedRequests,
      ),
    );
    expect(cappedRequests).toHaveLength(10);
    expect(capped).toEqual({
      cost: { used: 10, limit: 0, currency: "JPY", period: "Last 30 days (partial)" },
      dataConfidence: "estimated",
    });
  });

  it("marks ai& pagination partial unless both cursors are present", async () => {
    for (const page of [
      {
        data: [{ cost: "2.5", currency: "jpy" }],
        has_more: true,
        next_after: null,
        next_after_id: "id",
      },
      {
        data: [{ cost: "2.5", currency: "jpy" }],
        has_more: true,
        next_after: "cursor",
        next_after_id: null,
      },
    ]) {
      const requests: Request[] = [];
      const snapshot = await aiand.fetchUsage(
        context(() => json(page), { AIAND_API_KEY: "fixture-key" }, requests),
      );
      expect(requests).toHaveLength(1);
      expect(snapshot).toEqual({
        cost: { used: 2.5, limit: 0, currency: "JPY", period: "Last 30 days (partial)" },
        dataConfidence: "estimated",
      });
    }
  });

  it("cleans ai& credentials, prefers the secure value and omits empty spend", async () => {
    const requests: Request[] = [];
    const base = context(
      () => json({ data: [{ cost: null, currency: "jpy" }], has_more: false }),
      {},
      requests,
    );
    const snapshot = await aiand.fetchUsage({
      ...base,
      settings: {
        get: () => "plain-key",
        getSecret: () => "  'secure-key'  ",
      },
    });
    expect(requests[0]?.options).toMatchObject({
      headers: { Authorization: "Bearer secure-key" },
    });
    expect(snapshot).toEqual({ dataConfidence: "exact" });

    for (const invalid of ["", "   ", "'", '"', "''", '  ""  ']) {
      await expect(
        aiand.fetchUsage(
          context(() => json({ data: [], has_more: false }), { AIAND_API_KEY: invalid }),
        ),
      ).rejects.toThrow("missing-credential:");
    }
  });

  it.each([
    [401, "authentication-expired"],
    [402, "permission-denied"],
    [429, "rate-limited"],
    [500, "api-failure"],
  ] as const)("classifies ai& HTTP %s as %s without response leakage", async (status, kind) => {
    let failure = "";
    try {
      await aiand.fetchUsage(
        context(() => json({ error: "fixture-key", detail: "response-secret" }, status), {
          AIAND_API_KEY: "fixture-key",
        }),
      );
    } catch (error) {
      failure = String(error);
    }
    expect(failure).toContain(`${kind}:`);
    expect(failure).not.toContain("fixture-key");
    expect(failure).not.toContain("response-secret");
    if (status === 500) expect(failure).toContain("500");
  });

  it("accepts every ai& 2xx and rejects Codable-incompatible field types", async () => {
    await expect(
      aiand.fetchUsage(
        context(() => json({ data: [], has_more: false }, 299), {
          AIAND_API_KEY: "fixture-key",
        }),
      ),
    ).resolves.toEqual({ dataConfidence: "exact" });

    for (const payload of [
      null,
      { data: "not-an-array" },
      { data: ["not-an-object"] },
      { data: [{ cost: 1, currency: "jpy" }] },
      { data: [{ cost: "1", currency: 1 }] },
      { data: [], has_more: "true" },
      { data: [], next_after: 1 },
      { data: [], next_after_id: 1 },
    ]) {
      await expect(
        aiand.fetchUsage(context(() => json(payload), { AIAND_API_KEY: "fixture-key" })),
      ).rejects.toThrow("parse-failure:");
    }
  });

  it("aggregates LLM Proxy providers when summary is absent and keeps top three sorted", async () => {
    const snapshot = await llmproxy.fetchUsage(
      context(
        () =>
          json({
            providers: {
              small: {
                credential_count: 1,
                active_count: 1,
                exhausted_count: 0,
                total_requests: 2,
                tokens: { output: 3 },
                approx_cost: 1.5,
                quota_groups: [{ remaining_percent: 80 }],
              },
              large: {
                credential_count: 3,
                active_count: 2,
                exhausted_count: 1,
                total_requests: 10,
                tokens: { input_cached: 1, input_uncached: 2, output: 3 },
                approx_cost: 2,
                quota_groups: [{ remaining_percent: 42, reset_time: "2026-09-01T00:00:00Z" }],
              },
            },
          }),
        { LLM_PROXY_API_KEY: "fixture-key", LLM_PROXY_BASE_URL: "https://proxy.example.com" },
      ),
    );
    expect(snapshot).toEqual({
      primary: { usedPercent: 58, resetsAt: "2026-09-01T00:00:00.000Z" },
      secondary: { usedPercent: 0, resetDescription: "12 requests" },
      tertiary: { usedPercent: 0, resetDescription: "9 tokens" },
      extraRateWindows: [
        {
          id: "large",
          title: "large",
          window: { usedPercent: 0, resetDescription: "10 req · 6 tok · $2.00" },
        },
        {
          id: "small",
          title: "small",
          window: { usedPercent: 0, resetDescription: "2 req · 3 tok · $1.50" },
        },
      ],
      identity: { organization: "3/4 active keys", loginMethod: "quota-stats" },
      cost: {
        used: 3.5,
        limit: 0,
        currency: "USD",
        period: "Approx. spend",
        resetsAt: "2026-09-01T00:00:00.000Z",
      },
    });
  });

  it("falls back field-by-field when an LLM Proxy summary is partial", async () => {
    const snapshot = await llmproxy.fetchUsage(
      context(
        () =>
          json({
            summary: { total_requests: 7 },
            providers: {
              openai: {
                credential_count: 1,
                active_count: 1,
                total_requests: 2,
                tokens: { output: 4 },
                approx_cost: 1.25,
              },
            },
          }),
        { LLM_PROXY_API_KEY: "fixture-key", LLM_PROXY_BASE_URL: "https://proxy.example.com" },
      ),
    );
    expect(snapshot.secondary).toEqual({ usedPercent: 0, resetDescription: "7 requests" });
    expect(snapshot.tertiary).toEqual({ usedPercent: 0, resetDescription: "4 tokens" });
    expect(snapshot.cost).toEqual({
      used: 1.25,
      limit: 0,
      currency: "USD",
      period: "Approx. spend",
    });
  });

  it("clamps malformed LLM Proxy remaining percentages and omits a zero aggregate cost", async () => {
    const snapshot = await llmproxy.fetchUsage(
      context(
        () =>
          json({
            providers: {
              low: {
                total_requests: 1,
                approx_cost: 0,
                quota_groups: [{ remaining_percent: -50 }],
              },
            },
          }),
        { LLM_PROXY_API_KEY: "fixture-key", LLM_PROXY_BASE_URL: "https://proxy.example.com" },
      ),
    );
    expect(snapshot.primary).toEqual({ usedPercent: 100 });
    expect(snapshot.cost).toBeUndefined();
  });

  it("normalizes LLM Proxy credentials and private-network endpoint paths", async () => {
    const requests: Request[] = [];
    await llmproxy.fetchUsage(
      context(
        () => json({ providers: {} }),
        {
          LLM_PROXY_API_KEY: "  'fixture-key'  ",
          LLM_PROXY_BASE_URL: '  "http://192.168.1.20:8080/custom/v1/"  ',
        },
        requests,
      ),
    );
    expect(requests[0]?.url.href).toBe("http://192.168.1.20:8080/custom/v1/quota-stats");
    expect(requests[0]?.options).toMatchObject({
      headers: { Authorization: "Bearer fixture-key", Accept: "application/json" },
    });
  });

  it.each([
    "http://public.example.test",
    "https://user:pass@proxy.example.test",
    "https://proxy.example.test%2f.attacker.test",
  ])("rejects unsafe LLM Proxy endpoint %s before transport", async (endpoint) => {
    const requests: Request[] = [];
    await expect(
      llmproxy.fetchUsage(
        context(
          () => json({ providers: {} }),
          { LLM_PROXY_API_KEY: "fixture-key", LLM_PROXY_BASE_URL: endpoint },
          requests,
        ),
      ),
    ).rejects.toThrow("api-failure:");
    expect(requests).toHaveLength(0);
  });

  it.each([401, 403, 429, 500])(
    "classifies LLM Proxy HTTP %s as the Swift generic API error",
    async (statusCode) => {
      await expect(
        llmproxy.fetchUsage(
          context(() => json({ detail: "fixture-key rejected" }, statusCode), {
            LLM_PROXY_API_KEY: "fixture-key",
            LLM_PROXY_BASE_URL: "https://proxy.example.test",
          }),
        ),
      ).rejects.toThrow("api-failure:");
    },
  );

  it("rejects LLM Proxy numeric strings and malformed provider objects like Swift Codable", async () => {
    await expect(
      llmproxy.fetchUsage(
        context(() => json({ providers: { openai: { total_requests: "12" } } }), {
          LLM_PROXY_API_KEY: "key",
          LLM_PROXY_BASE_URL: "https://proxy.example.test",
        }),
      ),
    ).rejects.toThrow("parse-failure:");
    await expect(
      llmproxy.fetchUsage(
        context(() => json({ providers: { openai: "invalid" } }), {
          LLM_PROXY_API_KEY: "key",
          LLM_PROXY_BASE_URL: "https://proxy.example.test",
        }),
      ),
    ).rejects.toThrow("parse-failure:");
  });

  it("drops an entire malformed LLM Proxy quota-group collection like Swift Codable", async () => {
    const snapshot = await llmproxy.fetchUsage(
      context(
        () =>
          json({
            providers: {
              openai: {
                quota_groups: [
                  { remaining_percent: 42, reset_time: "2026-09-01T00:00:00Z" },
                  { remaining_percent: "bad", reset_time: "2026-08-30T00:00:00Z" },
                ],
              },
            },
          }),
        { LLM_PROXY_API_KEY: "key", LLM_PROXY_BASE_URL: "https://proxy.example.test" },
      ),
    );
    expect(snapshot.primary).toBeUndefined();
    expect(snapshot.cost).toBeUndefined();
  });

  it("keeps LLM Proxy quota usage while ignoring a malformed reset date", async () => {
    const snapshot = await llmproxy.fetchUsage(
      context(
        () =>
          json({
            providers: {
              openai: {
                quota_groups: [{ remaining_percent: 42, reset_time: "not-a-date" }],
              },
            },
          }),
        { LLM_PROXY_API_KEY: "key", LLM_PROXY_BASE_URL: "https://proxy.example.test" },
      ),
    );
    expect(snapshot.primary).toEqual({ usedPercent: 58, resetsAt: undefined });
  });

  it("maps Neuralwatt prepaid balance separately from subscription kWh and key allowance", async () => {
    const snapshot = await neuralwatt.fetchUsage(
      context(
        () =>
          json({
            balance: {
              credits_remaining_usd: 32.6774,
              total_credits_usd: 52.34,
              credits_used_usd: 19.6626,
              accounting_method: "energy",
            },
            subscription: {
              plan: "standard",
              current_period_start: "2026-04-11T05:05:25Z",
              current_period_end: "2026-05-11T05:05:25Z",
              kwh_included: 20,
              kwh_used: 13.9023,
            },
            key: {
              allowance: { limit_usd: 50, period: "monthly", spent_usd: 12.5, blocked: false },
            },
          }),
        { NEURALWATT_API_KEY: "fixture-key" },
      ),
    );
    expect(snapshot).toEqual({
      identity: { loginMethod: "Standard plan" },
      cost: { used: 32.6774, limit: 0, currency: "USD", period: "Neuralwatt prepaid balance" },
      primary: {
        usedPercent: 69.5115,
        windowMinutes: 43200,
        resetDescription: "13.90 / 20 kWh",
        resetsAt: "2026-05-11T05:05:25.000Z",
      },
      extraRateWindows: [
        { id: "key-allowance", title: "Key Monthly", window: { usedPercent: 25 } },
      ],
      subscriptionRenewsAt: "2026-05-11T05:05:25.000Z",
      dataConfidence: "exact",
    });
    const blocked = await neuralwatt.fetchUsage(
      context(
        () =>
          json({
            balance: { credits_remaining_usd: 3 },
            key: { allowance: { blocked: true, period: "monthly" } },
          }),
        { NEURALWATT_API_KEY: "fixture-key" },
      ),
    );
    expect(blocked.extraRateWindows).toEqual([
      { id: "key-allowance", title: "Key Monthly", window: { usedPercent: 100 } },
    ]);
  });

  it("normalizes Neuralwatt credentials and endpoint composition like Swift", async () => {
    const requests: Request[] = [];
    await neuralwatt.fetchUsage(
      context(
        () => json({ balance: { credits_remaining_usd: 3 } }),
        {
          NEURALWATT_API_KEY: "  'fixture-key'  ",
          NEURALWATT_API_URL: '  "neural.example.test/custom/v1/"  ',
        },
        requests,
      ),
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url.href).toBe("https://neural.example.test/custom/v1/quota");
    expect(requests[0]?.options).toMatchObject({
      headers: { Authorization: "Bearer fixture-key", Accept: "application/json" },
    });

    const defaultRequests: Request[] = [];
    await neuralwatt.fetchUsage(
      context(
        () => json({ balance: { credits_remaining_usd: 1 } }),
        { NEURALWATT_API_KEY: "fixture-key" },
        defaultRequests,
      ),
    );
    expect(defaultRequests[0]?.url.href).toBe("https://api.neuralwatt.com/v1/quota");
  });

  it.each([
    "http://neural.example.test",
    "https://user:pass@neural.example.test",
    "https://neural.example.test%2f.attacker.test",
  ])("rejects unsafe Neuralwatt endpoint %s before transport", async (endpoint) => {
    const requests: Request[] = [];
    await expect(
      neuralwatt.fetchUsage(
        context(
          () => json({ balance: { credits_remaining_usd: 1 } }),
          { NEURALWATT_API_KEY: "fixture-key", NEURALWATT_API_URL: endpoint },
          requests,
        ),
      ),
    ).rejects.toThrow("api-failure:");
    expect(requests).toHaveLength(0);
  });

  it.each([
    [401, "missing-credential"],
    [403, "missing-credential"],
    [429, "api-failure"],
    [500, "api-failure"],
    [201, "api-failure"],
  ] as const)("classifies Neuralwatt HTTP %s like the Swift oracle", async (statusCode, kind) => {
    await expect(
      neuralwatt.fetchUsage(
        context(() => json({}, statusCode), { NEURALWATT_API_KEY: "fixture-key" }),
      ),
    ).rejects.toThrow(`${kind}:`);
  });

  it("classifies Neuralwatt transport failures and omits incomplete key allowances", async () => {
    await expect(
      neuralwatt.fetchUsage(
        context(
          () => {
            throw new Error("offline");
          },
          { NEURALWATT_API_KEY: "fixture-key" },
        ),
      ),
    ).rejects.toThrow("network-failure:");

    const snapshot = await neuralwatt.fetchUsage(
      context(
        () =>
          json({
            balance: { credits_remaining_usd: 3, accounting_method: "energy" },
            key: { allowance: { limit_usd: 50, period: "monthly", blocked: false } },
            subscription: { auto_renew: false, current_period_end: "2026-05-11T05:05:25Z" },
          }),
        { NEURALWATT_API_KEY: "fixture-key" },
      ),
    );
    expect(snapshot.extraRateWindows).toBeUndefined();
    expect(snapshot.subscriptionRenewsAt).toBeUndefined();
    expect(snapshot.identity).toEqual({ loginMethod: "Energy" });
  });
});
