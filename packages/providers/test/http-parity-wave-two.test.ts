import { describe, expect, it } from "vite-plus/test";

import { deepinfra } from "../src/providers/deepinfra.ts";
import { deepseek } from "../src/providers/deepseek.ts";
import {
  fireworks,
  InvalidFireworksSummary,
  parseFireworksSummary,
  resolveFireworksAccountSlug,
  resolveFireworksAPIKey,
} from "../src/providers/fireworks.ts";
import { groq } from "../src/providers/groq.ts";
import { moonshot } from "../src/providers/moonshot.ts";
import type { ProviderContext, ProviderResponse } from "../src/types.ts";

const now = new Date("2026-08-20T12:00:00.000Z");

type Request = {
  readonly method: "GET" | "POST";
  readonly url: URL;
  readonly options?: Record<string, unknown>;
};

type Fixture = (request: Request) => ProviderResponse;

const failure = (kind: string) => (message: string) => new Error(`${kind}: ${message}`);

function context(
  fixture: Fixture,
  options: {
    readonly settings?: Readonly<Record<string, string>>;
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

function json(body: unknown, status = 200): ProviderResponse {
  return { status, bodyText: JSON.stringify(body) };
}

describe("Swift-derived HTTP provider parity wave two", () => {
  it("keeps the five descriptors and strategy IDs aligned with upstream", () => {
    expect(
      [fireworks, groq, moonshot, deepinfra, deepseek].map((provider) => provider.descriptor.id),
    ).toEqual(["fireworks", "groq", "moonshot", "deepinfra", "deepseek"]);
    expect([fireworks, groq, moonshot, deepinfra, deepseek].map((provider) => provider.id)).toEqual(
      ["fireworks.api", "groq.api", "moonshot.api", "deepinfra.api", "deepseek.api"],
    );
  });

  it("matches Fireworks rated line-item currency selection and bounded URL construction", async () => {
    const requests: Request[] = [];
    const snapshot = await fireworks.fetchUsage(
      context(
        () =>
          json({
            lineItems: [
              { totalCost: { currencyCode: "USD", nanos: 492_256_016, units: "0" } },
              { totalCost: { currencyCode: "USD", nanos: 33_292_280, units: "1" } },
              { totalCost: { currencyCode: "EUR", nanos: 900_000_000, units: "9" } },
            ],
            usageBuckets: [],
          }),
        {
          settings: {
            FIREWORKS_API_KEY: "  fixture-key  ",
            FIREWORKS_ACCOUNT_SLUG: "  x0mh0x  ",
          },
          requests,
        },
      ),
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url.pathname).toBe("/v1/accounts/x0mh0x/billing/summary");
    expect(requests[0]?.url.href).toBe(
      "https://api.fireworks.ai/v1/accounts/x0mh0x/billing/summary?startTime=2026-07-21T12:00:00Z&endTime=2026-08-20T12:00:00Z",
    );
    expect(requests[0]?.options).toMatchObject({
      headers: { Authorization: "Bearer fixture-key", Accept: "application/json" },
      timeoutSeconds: 15,
    });
    expect(snapshot).toEqual({
      cost: { used: 1.525548296, limit: 0, currency: "USD", period: "Last 30 days" },
    });
  });

  it("matches Fireworks alias precedence, quote cleaning and blank fallthrough", () => {
    const settings = (values: Readonly<Record<string, string>>) => ({
      get: (key: string) => values[key],
      getSecret: (key: string) => values[key],
    });
    expect(
      resolveFireworksAPIKey(
        settings({
          CODEXBAR_FIREWORKS_API_KEY: "  ",
          FIREWORKS_API_KEY: '"  primary  "',
          FIREWORKS_KEY: "legacy",
        }),
      ),
    ).toBe("primary");
    expect(
      resolveFireworksAPIKey(settings({ FIREWORKS_API_KEY: "''", FIREWORKS_KEY: "legacy" })),
    ).toBe("legacy");
    expect(
      resolveFireworksAccountSlug(
        settings({
          CODEXBAR_FIREWORKS_ACCOUNT_SLUG: "''",
          FIREWORKS_ACCOUNT_SLUG: " ' account-1 ' ",
        }),
      ),
    ).toBe("account-1");
  });

  it("requires an explicit safe Fireworks account slug without making a discovery request", async () => {
    const missingRequests: Request[] = [];
    await expect(
      fireworks.fetchUsage(
        context(() => json({}), {
          settings: { FIREWORKS_API_KEY: "fixture-key" },
          requests: missingRequests,
        }),
      ),
    ).rejects.toThrow("missing-credential: Missing Fireworks account slug");
    expect(missingRequests).toEqual([]);

    for (const slug of [
      ".",
      "..",
      "sp ace",
      "has/slash",
      "has?query",
      "has#fragment",
      "percent%2F",
      "coléon",
    ]) {
      const requests: Request[] = [];
      await expect(
        fireworks.fetchUsage(
          context(() => json({}), {
            settings: { FIREWORKS_API_KEY: "fixture-key", FIREWORKS_ACCOUNT_SLUG: slug },
            requests,
          }),
        ),
      ).rejects.toThrow(
        `missing-credential: Invalid Fireworks account slug '${slug}'. Please double-check the account slug in Settings.`,
      );
      expect(requests).toEqual([]);
    }
  });

  it("strictly validates Fireworks known fields and preserves an explicit empty snapshot", () => {
    expect(parseFireworksSummary({ lineItems: [], usageBuckets: [] })).toEqual({
      emptySnapshot: true,
    });
    expect(
      parseFireworksSummary({
        lineItems: [
          {},
          { totalCost: { currencyCode: "  ", nanos: 0, units: "1" } },
          { totalCost: { currencyCode: "USD", nanos: 0, units: "not-a-number" } },
          { totalCost: { currencyCode: "USD", nanos: 500_000_000, units: "0" } },
        ],
      }),
    ).toEqual({ cost: { used: 0.5, limit: 0, currency: "USD", period: "Last 30 days" } });
    for (const payload of [
      [],
      { lineItems: {} },
      { lineItems: [{ totalCost: "invalid" }] },
      { lineItems: [{ category: 1 }] },
      { usageBuckets: "invalid" },
      { usageBuckets: [{ lineItems: "invalid" }] },
    ]) {
      expect(() => parseFireworksSummary(payload)).toThrow(InvalidFireworksSummary);
    }
  });

  it("classifies every Fireworks non-200 status like the Swift fetcher without exposing its body", async () => {
    for (const [responseStatus, expectedMessage] of [
      [
        401,
        "authentication-expired: Fireworks rejected the API key. Create a new key at app.fireworks.ai and update Settings.",
      ],
      [
        403,
        "authentication-expired: Fireworks rejected the API key. Create a new key at app.fireworks.ai and update Settings.",
      ],
      [429, "rate-limited: Fireworks rate limit exceeded. Usage will refresh on the next cycle."],
      [201, "api-failure: Fireworks billing API returned HTTP 201."],
      [404, "api-failure: Fireworks billing API returned HTTP 404."],
      [500, "api-failure: Fireworks billing API returned HTTP 500."],
    ] as const) {
      const error = await fireworks
        .fetchUsage(
          context(() => json({ error: "secret-ish provider body" }, responseStatus), {
            settings: {
              FIREWORKS_API_KEY: "fixture-key",
              FIREWORKS_ACCOUNT_SLUG: "fixture-account",
            },
          }),
        )
        .catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(expectedMessage);
    }
  });

  it("classifies Fireworks transport and invalid-JSON failures without fallback", async () => {
    const settings = {
      FIREWORKS_API_KEY: "fixture-key",
      FIREWORKS_ACCOUNT_SLUG: "fixture-account",
    };
    await expect(
      fireworks.fetchUsage(
        context(
          () => {
            throw new Error("socket closed");
          },
          { settings },
        ),
      ),
    ).rejects.toThrow("network-failure: socket closed");
    await expect(
      fireworks.fetchUsage(context(() => ({ status: 200, bodyText: "{" }), { settings })),
    ).rejects.toThrow("parse-failure: Fireworks response was not valid JSON.");
  });

  it("matches Groq Prometheus query paths, mixed scalar values and rate windows", async () => {
    const requests: Request[] = [];
    const snapshot = await groq.fetchUsage(
      context(
        (request) => {
          const query = request.url.searchParams.get("query");
          const values = query?.includes("requests")
            ? [2.5, "1.5"]
            : query?.includes("tokens_in")
              ? [100, "50"]
              : query?.includes("tokens_out")
                ? [10]
                : [3];
          return json({
            status: "success",
            data: { result: values.map((value) => ({ value: [now.getTime() / 1_000, value] })) },
          });
        },
        { settings: { GROQ_API_KEY: "fixture-key" }, requests },
      ),
    );

    expect(requests).toHaveLength(4);
    expect(
      requests.every(({ url }) => url.pathname === "/v1/metrics/prometheus/api/v1/query"),
    ).toBe(true);
    expect(requests.map(({ url }) => url.href)).toEqual([
      "https://api.groq.com/v1/metrics/prometheus/api/v1/query?query=sum(model_project_id_status_code:requests:rate5m)",
      "https://api.groq.com/v1/metrics/prometheus/api/v1/query?query=sum(model_project_id:tokens_in:rate5m)",
      "https://api.groq.com/v1/metrics/prometheus/api/v1/query?query=sum(model_project_id:tokens_out:rate5m)",
      "https://api.groq.com/v1/metrics/prometheus/api/v1/query?query=sum(model_project_id:prompt_cache_hits:rate5m)",
    ]);
    expect(
      requests.every(
        ({ options }) =>
          options &&
          (options.headers as Record<string, unknown>).Authorization === "Bearer fixture-key",
      ),
    ).toBe(true);
    expect(snapshot).toEqual({
      primary: { usedPercent: 0, windowMinutes: 5, resetDescription: "240 req/min" },
      secondary: { usedPercent: 0, windowMinutes: 5, resetDescription: "9600 tok/min" },
      tertiary: { usedPercent: 0, windowMinutes: 5, resetDescription: "180 cache/min" },
      identity: { loginMethod: "Prometheus metrics" },
    });
  });

  it("matches Groq API key cleanup and canonical endpoint override", async () => {
    const requests: Request[] = [];
    await groq.fetchUsage(
      context(() => json({ status: "success", data: { result: [] } }), {
        settings: {
          GROQ_API_KEY: "  'fixture-key'  ",
          GROQ_API_URL: "groq.example.test/v1/",
        },
        requests,
      }),
    );

    expect(requests).toHaveLength(4);
    expect(requests.every(({ url }) => url.origin === "https://groq.example.test")).toBe(true);
    expect(
      requests.every(({ url }) => url.pathname === "/v1/metrics/prometheus/api/v1/query"),
    ).toBe(true);
    expect(
      requests.every(
        ({ options }) =>
          options &&
          (options.headers as Record<string, unknown>).Authorization === "Bearer fixture-key",
      ),
    ).toBe(true);
  });

  it("matches Swift decimal precision for fractional Groq rates", async () => {
    const snapshot = await groq.fetchUsage(
      context(
        (request) => {
          const query = request.url.searchParams.get("query");
          const value = query?.includes("requests")
            ? 2.5 / 60
            : query?.includes("tokens_in")
              ? 10 / 60
              : query?.includes("tokens_out")
                ? 0
                : 0.5 / 60;
          return json({
            status: "success",
            data: { result: [{ value: [now.getTime() / 1_000, value] }] },
          });
        },
        { settings: { GROQ_API_KEY: "fixture-key" } },
      ),
    );

    expect(snapshot).toMatchObject({
      primary: { resetDescription: "2.50 req/min" },
      secondary: { resetDescription: "10.0 tok/min" },
      tertiary: { resetDescription: "0.50 cache/min" },
    });
  });

  it.each([
    "http://attacker.test/v1",
    "https://user:pass@proxy.test/v1",
    "https://proxy.test%2f.attacker.test/v1",
    "https://bad host/v1",
  ])("rejects an unsafe Groq endpoint before transport: %s", async (endpoint) => {
    const requests: Request[] = [];
    await expect(
      groq.fetchUsage(
        context(() => json({ status: "success", data: { result: [] } }), {
          settings: { GROQ_API_KEY: "fixture-key", GROQ_API_URL: endpoint },
          requests,
        }),
      ),
    ).rejects.toThrow("api-failure: Groq endpoint override GROQ_API_URL");
    expect(requests).toHaveLength(0);
  });

  it.each([
    [401, "authentication-expired", "Groq metrics access denied: denied"],
    [403, "permission-denied", "Groq metrics access denied: denied"],
    [429, "api-failure", "Groq metrics API error: HTTP 429: denied"],
    [500, "api-failure", "Groq metrics API error: HTTP 500: denied"],
  ])("matches Groq metrics HTTP failure classification for %s", async (status, kind, message) => {
    await expect(
      groq.fetchUsage(
        context(() => ({ status, bodyText: " denied " }), {
          settings: { GROQ_API_KEY: "fixture-key" },
        }),
      ),
    ).rejects.toThrow(`${kind}: ${message}`);
  });

  it("matches Groq Prometheus error payloads as API failures", async () => {
    await expect(
      groq.fetchUsage(
        context(() => json({ status: "error", error: "query failed" }), {
          settings: { GROQ_API_KEY: "fixture-key" },
        }),
      ),
    ).rejects.toThrow("api-failure: Groq metrics API error: query failed");
  });

  it.each([
    [{ data: { result: [] } }, "status is missing"],
    [{ status: "success", data: { result: {} } }, "result must be an array"],
    [{ status: "success", data: { result: [null] } }, "result series must be an object"],
    [{ status: "success", data: { result: [{ value: true }] } }, "value must be an array"],
    [
      { status: "success", data: { result: [{ value: [now.getTime() / 1_000, {}] }] } },
      "value must contain strings or numbers",
    ],
  ])("matches Groq Prometheus malformed payload parse failure %#", async (payload, message) => {
    await expect(
      groq.fetchUsage(
        context(() => json(payload), {
          settings: { GROQ_API_KEY: "fixture-key" },
        }),
      ),
    ).rejects.toThrow(`parse-failure: Groq metrics parse error: ${message}`);
  });

  it("matches Moonshot region routing, balance formatting and required response fields", async () => {
    const requests: Request[] = [];
    const snapshot = await moonshot.fetchUsage(
      context(
        () =>
          json({
            code: 0,
            data: { available_balance: 49.58, voucher_balance: 50, cash_balance: -0.42 },
            scode: "0x0",
            status: true,
          }),
        { settings: { MOONSHOT_API_KEY: "  fixture-key  ", MOONSHOT_REGION: "china" }, requests },
      ),
    );

    expect(requests[0]?.url.toString()).toBe("https://api.moonshot.cn/v1/users/me/balance");
    expect(requests[0]?.options).toMatchObject({
      headers: { Authorization: "Bearer fixture-key", Accept: "application/json" },
      timeoutSeconds: 15,
    });
    expect(snapshot).toEqual({
      identity: { loginMethod: "Balance: $49.58 · $0.42 in deficit" },
    });

    await expect(
      moonshot.fetchUsage(
        context(
          () => json({ code: 0, data: { available_balance: 49.58 }, scode: "0x0", status: true }),
          {
            settings: { MOONSHOT_API_KEY: "fixture-key" },
          },
        ),
      ),
    ).rejects.toThrow("parse-failure:");
  });

  it("matches Moonshot setting aliases, quote rules and region-bound config precedence", async () => {
    const requests: Request[] = [];
    await moonshot.fetchUsage(
      context(
        () =>
          json({
            code: 0,
            data: { available_balance: 1, voucher_balance: 2, cash_balance: 3 },
            scode: "0x0",
            status: true,
          }),
        {
          settings: {
            MOONSHOT_API_KEY: "primary-token",
            MOONSHOT_KEY: "fallback-token",
            MOONSHOT_REGION: '"china"',
            CODEXBAR_MOONSHOT_API_KEY: "'config-token'",
            CODEXBAR_MOONSHOT_API_KEY_REGION: '"china"',
          },
          requests,
        },
      ),
    );
    expect(requests[0]?.url.hostname).toBe("api.moonshot.cn");
    expect(requests[0]?.options).toMatchObject({
      headers: { Authorization: "Bearer config-token" },
    });

    const swiftOrderedCleaning: Request[] = [];
    await moonshot.fetchUsage(
      context(
        () =>
          json({
            code: 0,
            data: { available_balance: 1, voucher_balance: 2, cash_balance: 3 },
            scode: "0x0",
            status: true,
          }),
        {
          settings: { MOONSHOT_KEY: "'fallback-token'", MOONSHOT_REGION: ' "china" ' },
          requests: swiftOrderedCleaning,
        },
      ),
    );
    expect(swiftOrderedCleaning[0]?.url.hostname).toBe("api.moonshot.ai");
    expect(swiftOrderedCleaning[0]?.options).toMatchObject({
      headers: { Authorization: "Bearer fallback-token" },
    });

    await expect(
      moonshot.fetchUsage(
        context(() => json({}), {
          settings: {
            CODEXBAR_MOONSHOT_API_KEY: "china-token",
            CODEXBAR_MOONSHOT_API_KEY_REGION: "china",
          },
        }),
      ),
    ).rejects.toThrow("missing-credential:");
  });

  it("preserves Moonshot API error details and strict required numeric fields", async () => {
    await expect(
      moonshot.fetchUsage(
        context(
          () =>
            json({
              code: 401,
              data: { available_balance: 0, voucher_balance: 0, cash_balance: 0 },
              scode: "unauthorized",
              status: false,
            }),
          { settings: { MOONSHOT_API_KEY: "fixture-key" } },
        ),
      ),
    ).rejects.toThrow("api-failure: code 401, scode unauthorized");

    await expect(
      moonshot.fetchUsage(
        context(
          () =>
            json({
              code: 0,
              data: { available_balance: "49.58", voucher_balance: 50, cash_balance: 12.34 },
              scode: "0x0",
              status: true,
            }),
          { settings: { MOONSHOT_API_KEY: "fixture-key" } },
        ),
      ),
    ).rejects.toThrow("parse-failure:");
  });

  it.each([201, 401, 403, 429, 500])(
    "matches Moonshot's exact HTTP 200 requirement for status %i without exposing the body",
    async (statusCode) => {
      await expect(
        moonshot.fetchUsage(
          context(
            () => ({
              status: statusCode,
              headers: {},
              bodyText: JSON.stringify({ secret: "must-not-appear" }),
            }),
            { settings: { MOONSHOT_API_KEY: "fixture-key" } },
          ),
        ),
      ).rejects.toThrow(`api-failure: Moonshot API returned HTTP ${statusCode}.`);

      await expect(
        moonshot.fetchUsage(
          context(
            () => ({
              status: statusCode,
              headers: {},
              bodyText: JSON.stringify({ secret: "must-not-appear" }),
            }),
            { settings: { MOONSHOT_API_KEY: "fixture-key" } },
          ),
        ),
      ).rejects.not.toThrow("must-not-appear");
    },
  );

  it("matches DeepInfra prepaid balance, monthly cents and suspended detail", async () => {
    const requests: Request[] = [];
    const snapshot = await deepinfra.fetchUsage(
      context(
        (request) =>
          request.url.pathname === "/payment/checklist"
            ? json({
                stripe_balance: -99.75,
                recent: 3.94,
                limit: 20,
                suspended: true,
                suspend_reason: "Payment review",
              })
            : json({ months: [{ period: "2026.07", total_cost: 394 }], initial_month: "2026.07" }),
        { settings: { DEEPINFRA_API_KEY: "  fixture-key  " }, requests },
      ),
    );

    expect(requests.map(({ url }) => `${url.pathname}?${url.searchParams.toString()}`)).toEqual([
      "/payment/checklist?compute_owed=true",
      "/payment/usage?from=current",
    ]);
    expect(
      requests.every(
        ({ options }) =>
          options &&
          (options.headers as Record<string, unknown>).Authorization === "Bearer fixture-key",
      ),
    ).toBe(true);
    expect(snapshot).toEqual({
      primary: {
        usedPercent: 100,
        resetDescription: "Suspended: Payment review · $95.81 available · $3.94 spent this month",
      },
      identity: {},
      cost: { used: 3.94, limit: 20, currency: "USD", period: "Billing cycle" },
    });

    await expect(
      deepinfra.fetchUsage(
        context(
          (request) =>
            request.url.pathname === "/payment/checklist" ? json({ stripe_balance: -1 }) : json({}),
          { settings: { DEEPINFRA_API_KEY: "fixture-key" } },
        ),
      ),
    ).rejects.toThrow("parse-failure:");
  });

  it("matches DeepInfra canonical-key precedence and legacy alias cleanup", async () => {
    for (const settings of [
      { DEEPINFRA_TOKEN: "  'alias-key'  " },
      { DEEPINFRA_API_KEY: '  "canonical-key"  ', DEEPINFRA_TOKEN: "alias-key" },
    ]) {
      const requests: Request[] = [];
      await deepinfra.fetchUsage(
        context(
          (request) =>
            request.url.pathname === "/payment/checklist"
              ? json({ stripe_balance: -1, recent: 0 })
              : json({ months: [] }),
          { settings, requests },
        ),
      );
      const expected = "DEEPINFRA_API_KEY" in settings ? "canonical-key" : "alias-key";
      expect(
        requests.every(
          ({ options }) =>
            options &&
            (options.headers as Record<string, unknown>).Authorization === `Bearer ${expected}`,
        ),
      ).toBe(true);
    }
  });

  it("matches DeepSeek currency preference and empty-balance semantics", async () => {
    const usd = await deepseek.fetchUsage(
      context(
        () =>
          json({
            is_available: true,
            balance_infos: [
              {
                currency: "CNY",
                total_balance: "100.00",
                granted_balance: "0.00",
                topped_up_balance: "100.00",
              },
              {
                currency: "USD",
                total_balance: "20.00",
                granted_balance: "5.00",
                topped_up_balance: "15.00",
              },
            ],
          }),
        { settings: { DEEPSEEK_API_KEY: "fixture-key" } },
      ),
    );
    expect(usd).toEqual({
      primary: { usedPercent: 0, resetDescription: "$20.00 (Paid: $15.00 / Granted: $5.00)" },
      identity: {},
    });

    const cny = await deepseek.fetchUsage(
      context(
        () =>
          json({
            is_available: true,
            balance_infos: [
              {
                currency: "USD",
                total_balance: "0.00",
                granted_balance: "0.00",
                topped_up_balance: "0.00",
              },
              {
                currency: "CNY",
                total_balance: "100.00",
                granted_balance: "0.00",
                topped_up_balance: "100.00",
              },
            ],
          }),
        { settings: { DEEPSEEK_API_KEY: "fixture-key" } },
      ),
    );
    expect(cny).toEqual({
      primary: { usedPercent: 0, resetDescription: "¥100.00 (Paid: ¥100.00 / Granted: ¥0.00)" },
      identity: {},
    });

    const unavailable = await deepseek.fetchUsage(
      context(
        () =>
          json({
            is_available: false,
            balance_infos: [
              {
                currency: "USD",
                total_balance: "20.00",
                granted_balance: "5.00",
                topped_up_balance: "15.00",
              },
            ],
          }),
        {
          settings: { DEEPSEEK_API_KEY: "fixture-key" },
        },
      ),
    );
    expect(unavailable).toEqual({
      primary: { usedPercent: 100, resetDescription: "Balance unavailable for API calls" },
      identity: {},
    });

    const empty = await deepseek.fetchUsage(
      context(() => json({ is_available: true, balance_infos: [] }), {
        settings: { DEEPSEEK_API_KEY: "fixture-key" },
      }),
    );
    expect(empty).toEqual({
      primary: {
        usedPercent: 100,
        resetDescription: "$0.00 — add credits at platform.deepseek.com",
      },
      identity: {},
    });

    await expect(
      deepseek.fetchUsage(
        context(() => json({ balance_infos: [] }), {
          settings: { DEEPSEEK_API_KEY: "fixture-key" },
        }),
      ),
    ).rejects.toThrow("parse-failure:");
  });

  it("matches DeepSeek canonical-key precedence and legacy alias cleanup", async () => {
    for (const settings of [
      { DEEPSEEK_KEY: "  'alias-key'  " },
      { DEEPSEEK_API_KEY: '  "canonical-key"  ', DEEPSEEK_KEY: "alias-key" },
    ]) {
      const requests: Request[] = [];
      await deepseek.fetchUsage(
        context(
          () =>
            json({
              is_available: true,
              balance_infos: [
                {
                  currency: "USD",
                  total_balance: "1.00",
                  granted_balance: "0.00",
                  topped_up_balance: "1.00",
                },
              ],
            }),
          { settings, requests },
        ),
      );
      const expected = "DEEPSEEK_API_KEY" in settings ? "canonical-key" : "alias-key";
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url.toString()).toBe("https://api.deepseek.com/user/balance");
      expect(requests[0]?.options).toMatchObject({
        headers: { Authorization: `Bearer ${expected}`, Accept: "application/json" },
      });
    }
  });

  it.each([401, 403, 429, 500, 201])(
    "classifies DeepSeek HTTP %s as an API failure",
    async (status) => {
      await expect(
        deepseek.fetchUsage(
          context(() => json({ error: "provider failure" }, status), {
            settings: { DEEPSEEK_API_KEY: "fixture-key" },
          }),
        ),
      ).rejects.toThrow("api-failure:");
    },
  );

  it.each([
    { total_balance: 1, granted_balance: "0", topped_up_balance: "1" },
    { total_balance: "1", granted_balance: 0, topped_up_balance: "1" },
    { total_balance: "1", granted_balance: "0", topped_up_balance: 1 },
    { total_balance: "", granted_balance: "0", topped_up_balance: "1" },
    { total_balance: " ", granted_balance: "0", topped_up_balance: "1" },
    { total_balance: "0x10", granted_balance: "0", topped_up_balance: "1" },
    { total_balance: "Infinity", granted_balance: "0", topped_up_balance: "1" },
    { granted_balance: "0", topped_up_balance: "1" },
  ])("rejects DeepSeek non-string or invalid balance fields: %o", async (fields) => {
    await expect(
      deepseek.fetchUsage(
        context(
          () =>
            json({
              is_available: true,
              balance_infos: [{ currency: "USD", ...fields }],
            }),
          { settings: { DEEPSEEK_API_KEY: "fixture-key" } },
        ),
      ),
    ).rejects.toThrow("parse-failure:");
  });

  it("preserves DeepSeek transport cancellation", async () => {
    const aborted = new Error("cancelled");
    aborted.name = "AbortError";
    await expect(
      deepseek.fetchUsage(
        context(
          () => {
            throw aborted;
          },
          { settings: { DEEPSEEK_API_KEY: "fixture-key" } },
        ),
      ),
    ).rejects.toBe(aborted);
  });
});
