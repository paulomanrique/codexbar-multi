import { describe, expect, it } from "vite-plus/test";
import { kiro } from "../src/providers/kiro.ts";
import { parseKiroUsageLimits } from "../src/providers/kiro-usage-limits.ts";
import type { ProviderContext } from "../src/types.ts";

const response = {
  nextDateReset: 1_788_220_800,
  overageConfiguration: { overageStatus: "ENABLED" },
  usageBreakdownList: [
    {
      resourceType: "CREDIT",
      currentUsageWithPrecision: 13_603.49,
      currentOveragesWithPrecision: 3_603.49,
      usageLimitWithPrecision: 10_000,
      overageCapWithPrecision: 10_000,
      overageCharges: 144.139711109352,
      overageRate: 0.04,
      currency: "USD",
      bonuses: [],
    },
  ],
};

const failure = (kind: string) => (message: string) => new Error(`${kind}: ${message}`);
const context = (): ProviderContext =>
  ({
    settings: { get: () => undefined, getSecret: () => undefined },
    http: {
      get: async () => ({ status: 200, bodyText: "" }),
      getJSON: async () => ({ status: 200, bodyText: "", json: {} }),
      postJSON: async () => ({ status: 200, bodyText: "", json: {} }),
    },
    browser: { cookieHeader: async () => "" },
    env: { timeZone: "UTC" },
    date: {
      now: () => new Date("2026-08-20T12:00:00Z"),
      nowMillis: () => Date.parse("2026-08-20T12:00:00Z"),
      iso: (value: string) => new Date(value).toISOString(),
      unixSeconds: (value: number) => new Date(value * 1000).toISOString(),
      unixMillis: (value: number) => new Date(value).toISOString(),
      nextDailyReset: () => "",
    },
    format: {
      number: (value: number) => String(value),
      usd: (value: number) => `$${value.toFixed(2)}`,
      monthDay: () => "",
    },
    pct: (used: number, limit: number) => (used / limit) * 100,
    amountFromPercent: () => 0,
    fail: Object.fromEntries(
      [
        "authenticationExpired",
        "missingCredential",
        "permissionDenied",
        "rateLimited",
        "providerUnavailable",
        "parseFailure",
        "networkFailure",
        "apiFailure",
      ].map((kind) => [kind, failure(kind)]),
    ),
  }) as unknown as ProviderContext;

const cli = `Estimated Usage | resets on 2026-09-01 | KIRO POWER
Credits (10000.00 of 10000 covered in plan)
████████████████████████████████████████████████████████████████████████████████ 100%`;

describe("Swift-derived Kiro GetUsageLimits parity", () => {
  it("splits plan and overage without double counting and models the cap", () => {
    const limits = parseKiroUsageLimits(response, context());
    expect(limits).toMatchObject({
      planLimit: 10_000,
      planUsed: 10_000,
      overageUsed: 3_603.49,
      overageCap: 10_000,
      overageCharges: 144.139711109352,
      currencyCode: "USD",
    });
    expect(
      parseKiroUsageLimits(
        {
          ...response,
          usageBreakdownList: [{ ...response.usageBreakdownList[0], overageCapWithPrecision: 100 }],
        },
        context(),
      ),
    ).toMatchObject({ overageCap: 100, overageUsed: 3_603.49 });
  });

  it("rejects invalid reset dates and relationally impossible counters", () => {
    expect(() =>
      parseKiroUsageLimits({ ...response, nextDateReset: 1_788_220_800_000 }, context()),
    ).toThrow(/reset/i);
    expect(() =>
      parseKiroUsageLimits(
        {
          ...response,
          usageBreakdownList: [
            { ...response.usageBreakdownList[0], currentUsageWithPrecision: 100 },
          ],
        },
        context(),
      ),
    ).toThrow(/overage exceeds/i);
    expect(() =>
      parseKiroUsageLimits(
        {
          ...response,
          usageBreakdownList: [
            { ...response.usageBreakdownList[0], currentOveragesWithPrecision: 0 },
          ],
        },
        context(),
      ),
    ).toThrow(/plan usage exceeds/i);
  });

  it("keeps bonus-inclusive plan usage and treats disabled or unknown overage conservatively", () => {
    expect(
      parseKiroUsageLimits(
        {
          ...response,
          usageBreakdownList: [
            {
              ...response.usageBreakdownList[0],
              bonuses: [{}],
              currentUsageWithPrecision: 14_603.49,
            },
          ],
        },
        context(),
      ),
    ).toMatchObject({ hasUnseparatedBonus: true, planUsed: 11_000 });
    expect(
      parseKiroUsageLimits(
        { ...response, overageConfiguration: { overageStatus: "DISABLED" } },
        context(),
      ),
    ).toMatchObject({ overageEnabled: false, overageCap: undefined });
    expect(
      parseKiroUsageLimits(
        { ...response, overageConfiguration: { overageStatus: "FUTURE_STATUS" } },
        context(),
      ),
    ).toMatchObject({ overageEnabled: undefined, overageCap: undefined });
  });

  it("enriches the CLI snapshot while API-disabled overage wins and non-USD does not inherit a dollar estimate", async () => {
    const enriched = await kiro.fetchUsage({
      ...context(),
      local: {
        run: async () => ({
          exitCode: 0,
          signal: undefined,
          stdout: `${cli}\nOverages: Enabled billed at $0.04 per request\nCredits used: 40.29\nEst. cost: $1.61 USD`,
          stderr: "",
        }),
        readData: async () => undefined,
        fetchKiroUsageLimits: async () => ({ status: 200, bodyText: JSON.stringify(response) }),
      },
    });
    expect(enriched).toMatchObject({
      primary: { usedPercent: 100 },
      extraRateWindows: [{ id: "kiro-overage", window: { usedPercent: 36.0349 } }],
      providerCost: { used: 144.139711109352, limit: 400, currencyCode: "USD" },
    });
    expect(
      (enriched as { readonly details?: readonly { readonly rows: unknown }[] }).details?.[0]?.rows,
    ).toEqual(
      expect.arrayContaining([
        { label: "Overages", value: "Enabled billed at $0.04 per request" },
        { label: "Overage usage", value: "3603.49 credits", secondaryValue: "of 10000" },
        { label: "Overage credits left", value: "6396.51" },
        { label: "Overage cost", value: "$144.14", secondaryValue: "of $400.00" },
      ]),
    );
    const disabled = await kiro.fetchUsage({
      ...context(),
      local: {
        run: async () => ({
          exitCode: 0,
          signal: undefined,
          stdout: `${cli}\nOverages: Enabled`,
          stderr: "",
        }),
        readData: async () => undefined,
        fetchKiroUsageLimits: async () => ({
          status: 200,
          bodyText: JSON.stringify({
            ...response,
            overageConfiguration: { overageStatus: "DISABLED" },
          }),
        }),
      },
    });
    expect(disabled).toMatchObject({
      details: [{ rows: expect.arrayContaining([{ label: "Overages", value: "Disabled" }]) }],
    });
    expect(disabled).not.toHaveProperty("extraRateWindows");
  });

  it("keeps CLI overage for unknown API states and never labels non-USD charges as dollars", async () => {
    const unknown = await kiro.fetchUsage({
      ...context(),
      local: {
        run: async () => ({
          exitCode: 0,
          signal: undefined,
          stdout: `${cli}\nOverages: Enabled\nCredits used: 40.29`,
          stderr: "",
        }),
        readData: async () => undefined,
        fetchKiroUsageLimits: async () => ({
          status: 200,
          bodyText: JSON.stringify({
            ...response,
            overageConfiguration: { overageStatus: "FUTURE_STATUS" },
          }),
        }),
      },
    });
    expect(
      (unknown as { readonly details?: readonly { readonly rows: unknown }[] }).details?.[0]?.rows,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ label: "Overage usage" })]));
    const nonUSD = await kiro.fetchUsage({
      ...context(),
      local: {
        run: async () => ({
          exitCode: 0,
          signal: undefined,
          stdout: `${cli}\nOverages: Enabled\nEst. cost: $1.61 USD`,
          stderr: "",
        }),
        readData: async () => undefined,
        fetchKiroUsageLimits: async () => ({
          status: 200,
          bodyText: JSON.stringify({
            ...response,
            usageBreakdownList: [{ ...response.usageBreakdownList[0], currency: "EUR" }],
          }),
        }),
      },
    });
    expect(nonUSD).toMatchObject({ providerCost: { currencyCode: "EUR", limit: 400 } });
    expect(
      (nonUSD as { readonly details?: readonly { readonly rows: unknown }[] }).details?.[0]?.rows,
    ).toEqual(
      expect.arrayContaining([
        { label: "Overage cost", value: "EUR 144.139711109352", secondaryValue: "of EUR 400" },
      ]),
    );
  });

  it("keeps CLI output when enrichment is unavailable but makes cancellation terminal", async () => {
    const fallback = await kiro.fetchUsage({
      ...context(),
      local: {
        run: async () => ({ exitCode: 0, signal: undefined, stdout: "20% used", stderr: "" }),
        readData: async () => undefined,
        fetchKiroUsageLimits: async () => {
          throw new Error("state database unavailable");
        },
      },
    });
    expect(fallback).toMatchObject({ primary: { usedPercent: 20 } });
    await expect(
      kiro.fetchUsage({
        ...context(),
        local: {
          run: async () => ({ exitCode: 0, signal: undefined, stdout: "20% used", stderr: "" }),
          readData: async () => undefined,
          fetchKiroUsageLimits: async () => {
            throw new DOMException("cancelled", "AbortError");
          },
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
