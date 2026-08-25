import { describe, expect, it } from "vite-plus/test";
import { venice } from "../src/providers/venice.ts";
import type { ProviderContext, ProviderJSONResponse } from "../src/types.ts";

type Request = {
  readonly url: string;
  readonly options?: Record<string, unknown>;
};

const failure = (kind: string) => (message: string) => new Error(`${kind}: ${message}`);

const context = (
  settings: Readonly<Record<string, string>>,
  response: ProviderJSONResponse,
  requests: Request[] = [],
): ProviderContext => ({
  settings: {
    get: (key) => settings[key],
    getSecret: (key) => settings[key],
  },
  http: {
    get: async () => ({ status: 500, bodyText: "unused" }),
    getJSON: async (url, options) => {
      requests.push({ url, ...(options === undefined ? {} : { options }) });
      return response;
    },
    postJSON: async () => ({ status: 500, bodyText: "unused", json: {} }),
  },
  browser: { cookieHeader: async () => "" },
  env: {},
  date: {
    now: () => new Date("2026-08-24T12:00:00Z"),
    nowMillis: () => Date.parse("2026-08-24T12:00:00Z"),
    iso: (value) => new Date(value).toISOString(),
    unixSeconds: (value) => new Date(value * 1_000).toISOString(),
    unixMillis: (value) => new Date(value).toISOString(),
    nextDailyReset: () => "2026-08-25T00:00:00.000Z",
  },
  format: {
    number: (value) => String(value),
    usd: (value) => `$${value.toFixed(2)}`,
    monthDay: (value) => new Date(value).toISOString().slice(5, 10),
  },
  pct: (used, limit) =>
    !Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0
      ? 100
      : Math.max(0, Math.min(100, (used / limit) * 100)),
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
});

const json = (body: unknown, status = 200): ProviderJSONResponse => ({
  status,
  bodyText: JSON.stringify(body),
  json: body,
});

describe("Venice Swift/plugin parity", () => {
  it("preserves canonical precedence, legacy alias cleanup and exact auth scope", async () => {
    for (const settings of [
      { VENICE_KEY: "  'alias-key'  " },
      { VENICE_API_KEY: '  "canonical-key"  ', VENICE_KEY: "alias-key" },
    ]) {
      const requests: Request[] = [];
      await venice.fetchUsage(
        context(
          settings,
          json({ canConsume: true, consumptionCurrency: "USD", balances: { usd: 1 } }),
          requests,
        ),
      );
      const expected = "VENICE_API_KEY" in settings ? "canonical-key" : "alias-key";
      expect(requests).toEqual([
        {
          url: "https://api.venice.ai/api/v1/billing/balance",
          options: {
            headers: { Authorization: `Bearer ${expected}`, Accept: "application/json" },
          },
        },
      ]);
    }

    await expect(
      venice.fetchUsage(context({}, json({ canConsume: true, balances: {} }))),
    ).rejects.toThrow("missing-credential:");
  });

  it.each([
    [
      { canConsume: false, balances: {} },
      { usedPercent: 100, resetDescription: "Balance unavailable for API calls" },
    ],
    [
      { canConsume: true, consumptionCurrency: "usd", balances: { usd: "12.345" } },
      { usedPercent: 0, resetDescription: "$12.35 USD remaining" },
    ],
    [
      {
        canConsume: true,
        consumptionCurrency: "DIEM",
        balances: { diem: 25 },
        diemEpochAllocation: 100,
      },
      { usedPercent: 75, resetDescription: "DIEM 25.00 / 100.00 epoch allocation" },
    ],
    [
      {
        canConsume: true,
        consumptionCurrency: "BUNDLED_CREDITS",
        balances: { diem: "50.0", usd: "10.0" },
        diemEpochAllocation: "100.0",
      },
      { usedPercent: 50, resetDescription: "DIEM 50.00 / 100.00 epoch allocation" },
    ],
    [
      {
        canConsume: true,
        consumptionCurrency: "DIEM",
        balances: { diem: 125 },
        diemEpochAllocation: 100,
      },
      { usedPercent: 0, resetDescription: "DIEM 125.00 / 100.00 epoch allocation" },
    ],
    [
      { canConsume: true, consumptionCurrency: "DIEM", balances: { diem: 4.5 } },
      { usedPercent: 0, resetDescription: "DIEM 4.50 remaining" },
    ],
    [
      { canConsume: true, consumptionCurrency: null, balances: { diem: 3 } },
      { usedPercent: 0, resetDescription: "DIEM 3.00 remaining" },
    ],
    [
      { canConsume: true, consumptionCurrency: null, balances: { usd: 2 } },
      { usedPercent: 0, resetDescription: "$2.00 USD remaining" },
    ],
    [
      { canConsume: true, consumptionCurrency: "USD", balances: { usd: 0, diem: 0 } },
      { usedPercent: 100, resetDescription: "No Venice API balance available" },
    ],
  ] as const)("maps the Venice balance golden %#", async (payload, primary) => {
    const snapshot = await venice.fetchUsage(
      context({ VENICE_API_KEY: "fixture-key" }, json(payload)),
    );
    expect(snapshot).toEqual({ primary, identity: {} });
  });

  it.each([
    [],
    {},
    { canConsume: "yes", balances: {} },
    { canConsume: true, balances: [] },
    { canConsume: true, balances: { usd: "not-a-number" } },
    { canConsume: true, balances: {}, consumptionCurrency: 42 },
  ])("classifies malformed Venice payloads as parse failures %#", async (payload) => {
    await expect(
      venice.fetchUsage(context({ VENICE_API_KEY: "fixture-key" }, json(payload))),
    ).rejects.toThrow("parse-failure:");
  });

  it.each([
    [401, "authentication-expired"],
    [403, "permission-denied"],
    [429, "rate-limited"],
    [500, "provider-unavailable"],
  ] as const)("classifies Venice HTTP %s as %s", async (status, kind) => {
    await expect(
      venice.fetchUsage(
        context({ VENICE_API_KEY: "fixture-key" }, json({ error: "denied" }, status)),
      ),
    ).rejects.toThrow(`${kind}:`);
  });

  it.each([201, 204])("rejects non-oracle Venice success status %s", async (status) => {
    await expect(
      venice.fetchUsage(
        context(
          { VENICE_API_KEY: "fixture-key" },
          json({ canConsume: true, balances: {} }, status),
        ),
      ),
    ).rejects.toThrow("api-failure: Venice API error");
  });
});
