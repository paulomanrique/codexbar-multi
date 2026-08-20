import { describe, expect, it } from "vite-plus/test";

import { abacus } from "../src/providers/abacus.ts";
import { mistral } from "../src/providers/mistral.ts";
import { sakana } from "../src/providers/sakana.ts";
import type { ProviderContext, ProviderResponse } from "../src/types.ts";

type Request = {
  readonly method: "GET" | "POST";
  readonly url: URL;
  readonly options?: Record<string, unknown>;
};
const fail = (kind: string) => (message: string) => new Error(`${kind}: ${message}`);
const reply = (body: unknown, status = 200): ProviderResponse => ({
  status,
  bodyText: typeof body === "string" ? body : JSON.stringify(body),
});
function context(
  fixture: (request: Request) => ProviderResponse,
  values: Record<string, string> = {},
  requests: Request[] = [],
): ProviderContext {
  const request = async (
    method: Request["method"],
    url: string,
    options?: Record<string, unknown>,
  ) => {
    const recorded = { method, url: new URL(url), ...(options ? { options } : {}) };
    requests.push(recorded);
    return fixture(recorded);
  };
  return {
    settings: { get: (key) => values[key], getSecret: (key) => values[key] },
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
    env: { timeZone: "UTC" },
    date: {
      now: () => new Date("2026-08-20T12:00:00Z"),
      nowMillis: () => Date.parse("2026-08-20T12:00:00Z"),
      iso: (value) => new Date(value).toISOString(),
      unixSeconds: (value) => new Date(value * 1000).toISOString(),
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
}

describe("Swift-derived Sakana, Abacus and Mistral parity", () => {
  it("keeps provider and strategy IDs aligned", () => {
    expect(
      [sakana, abacus, mistral].map((provider) => [provider.descriptor.id, provider.id]),
    ).toEqual([
      ["sakana", "sakana.web"],
      ["abacus", "abacus.web"],
      ["mistral", "mistral.web"],
    ]);
  });
  it("parses Sakana subscription windows and ignores absent optional PAYG", async () => {
    const html = `<div data-slot="card-title"><span>Standard</span><span>$20/mo</span></div><p>5-hour</p><p>92% used</p><p>Resets on June 2, 2026 at 8:00 AM</p><p>Weekly</p><p>32% used</p>`;
    const snapshot = await sakana.fetchUsage(
      context((request) => reply(request.url.search ? "" : html), { SAKANA_COOKIE: "session=ok" }),
    );
    expect(snapshot).toEqual({
      primary: { usedPercent: 92, windowMinutes: 300, resetsAt: "2026-06-02T08:00:00.000Z" },
      secondary: { usedPercent: 32, windowMinutes: 10080 },
      identity: { loginMethod: "Standard $20/mo" },
    });
  });
  it("maps Abacus required compute points and optional billing plan", async () => {
    const requests: Request[] = [];
    const snapshot = await abacus.fetchUsage(
      context(
        (request) =>
          request.method === "GET"
            ? reply({ success: true, result: { totalComputePoints: 1000, computePointsLeft: 750 } })
            : reply({
                success: true,
                result: { currentTier: "Pro", nextBillingDate: "2026-09-01T00:00:00Z" },
              }),
        { ABACUS_COOKIE_HEADER: "session=ok" },
        requests,
      ),
    );
    expect(requests.map((entry) => entry.url.pathname)).toEqual([
      "/api/_getOrganizationComputePoints",
      "/api/_getBillingInfo",
    ]);
    expect(snapshot).toMatchObject({
      primary: {
        usedPercent: 25,
        resetsAt: "2026-09-01T00:00:00.000Z",
        resetDescription: "250 / 1,000 credits",
      },
      identity: { loginMethod: "Pro" },
    });
  });
  it("aggregates Mistral prices, forwards only console cookies for Vibe, and preserves credits", async () => {
    const requests: Request[] = [];
    const snapshot = await mistral.fetchUsage(
      context(
        (request) => {
          if (request.url.pathname === "/api/billing/v2/usage")
            return reply({
              currency: "EUR",
              currency_symbol: "€",
              completion: {
                models: {
                  "mistral-small::metric": {
                    input: [
                      {
                        billing_metric: "metric",
                        billing_group: "input",
                        value: 100,
                        timestamp: "2026-08-20",
                      },
                    ],
                    output: [
                      {
                        billing_metric: "metric",
                        billing_group: "output",
                        value: 50,
                        timestamp: "2026-08-20",
                      },
                    ],
                  },
                },
              },
              prices: [
                { billing_metric: "metric", billing_group: "input", price: "0.01" },
                { billing_metric: "metric", billing_group: "output", price: "0.02" },
              ],
            });
          if (request.url.pathname === "/api/billing/credits")
            return reply({
              wallet_amount: 12.5,
              credit_notes_amount: 2.25,
              ongoing_usage_balance: 1.5,
            });
          return reply([
            {
              result: { data: { json: { usagePercentage: 42, resetAt: "2026-09-01T00:00:00Z" } } },
            },
          ]);
        },
        { MISTRAL_COOKIE_HEADER: "ory_session_test=abc; csrftoken=csrf; private=value" },
        requests,
      ),
    );
    expect(requests[2]?.options).toMatchObject({
      headers: { Cookie: "csrftoken=csrf; ory_session_test=abc", "X-CSRFToken": "csrf" },
    });
    expect(snapshot).toMatchObject({
      cost: { used: 2, currency: "EUR" },
      extraRateWindows: [{ id: "mistral-monthly-plan", window: { usedPercent: 42 } }],
      identity: { loginMethod: "API spend: €2.0000 this month" },
    });
  });
});
