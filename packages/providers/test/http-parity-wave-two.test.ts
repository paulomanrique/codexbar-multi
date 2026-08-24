import { describe, expect, it } from "vite-plus/test";

import { deepinfra } from "../src/providers/deepinfra.ts";
import { deepseek } from "../src/providers/deepseek.ts";
import { fireworks } from "../src/providers/fireworks.ts";
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
    expect(requests[0]?.url.searchParams.get("startTime")).toBe("2026-07-21T12:00:00.000Z");
    expect(requests[0]?.url.searchParams.get("endTime")).toBe("2026-08-20T12:00:00.000Z");
    expect(requests[0]?.options).toMatchObject({
      headers: { Authorization: "Bearer fixture-key", Accept: "application/json" },
    });
    expect(snapshot).toEqual({
      cost: { used: 1.525548296, limit: 0, currency: "USD", period: "Last 30 days" },
      identity: {},
    });
  });

  it("discovers one Fireworks account across paginated account pages", async () => {
    const requests: Request[] = [];
    const snapshot = await fireworks.fetchUsage(
      context(
        (request) => {
          if (request.url.pathname === "/v1/accounts") {
            if (request.url.searchParams.get("pageToken") === "page-2") {
              return json({ accounts: [{ name: "accounts/discovered-team" }] });
            }
            return json({ accounts: [{ name: "accounts/invalid slug" }], nextPageToken: "page-2" });
          }
          expect(request.url.pathname).toBe("/v1/accounts/discovered-team/billing/summary");
          return json({
            lineItems: [{ totalCost: { currencyCode: "USD", units: "2", nanos: 250_000_000 } }],
          });
        },
        { settings: { FIREWORKS_API_KEY: "fixture-key" }, requests },
      ),
    );

    expect(requests.map(({ url }) => `${url.pathname}${url.search}`)).toEqual([
      "/v1/accounts",
      "/v1/accounts?pageToken=page-2",
      "/v1/accounts/discovered-team/billing/summary?startTime=2026-07-21T12%3A00%3A00.000Z&endTime=2026-08-20T12%3A00%3A00.000Z",
    ]);
    expect(snapshot).toEqual({
      cost: { used: 2.25, limit: 0, currency: "USD", period: "Last 30 days" },
      identity: {},
    });
  });

  it("verifies an explicit Fireworks slug after an empty summary and rejects unknown accounts", async () => {
    const requests: Request[] = [];
    await expect(
      fireworks.fetchUsage(
        context(
          (request) => {
            if (request.url.pathname === "/v1/accounts/explicit-slug/billing/summary") {
              return json({ lineItems: [] });
            }
            return json({ accounts: [{ name: "accounts/different-slug" }] });
          },
          {
            settings: { FIREWORKS_API_KEY: "fixture-key", FIREWORKS_ACCOUNT_SLUG: "explicit-slug" },
            requests,
          },
        ),
      ),
    ).rejects.toThrow("Fireworks account slug 'explicit-slug' not found");
    expect(requests.map(({ url }) => url.pathname)).toEqual([
      "/v1/accounts/explicit-slug/billing/summary",
      "/v1/accounts",
    ]);
  });

  it("reports zero and multiple visible Fireworks accounts when the slug is omitted", async () => {
    await expect(
      fireworks.fetchUsage(
        context(() => json({ accounts: [] }), { settings: { FIREWORKS_API_KEY: "fixture-key" } }),
      ),
    ).rejects.toThrow("No Fireworks accounts are visible");

    await expect(
      fireworks.fetchUsage(
        context(() => json({ accounts: [{ name: "accounts/zeta" }, { name: "accounts/alpha" }] }), {
          settings: { FIREWORKS_API_KEY: "fixture-key" },
        }),
      ),
    ).rejects.toThrow("alpha, zeta");
  });

  it("classifies Fireworks authentication and availability failures like the Swift fetcher", async () => {
    for (const [responseStatus, expectedKind] of [
      [401, "authentication-expired"],
      [403, "authentication-expired"],
      [429, "rate-limited"],
      [500, "provider-unavailable"],
    ] as const) {
      await expect(
        fireworks.fetchUsage(
          context(() => json({ error: "secret-ish provider body" }, responseStatus), {
            settings: {
              FIREWORKS_API_KEY: "fixture-key",
              FIREWORKS_ACCOUNT_SLUG: "fixture-account",
            },
          }),
        ),
      ).rejects.toThrow(expectedKind);
    }
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
});
