import { describe, expect, it } from "vite-plus/test";

import { zai } from "../src/providers/zai.ts";
import type { ProviderContext, ProviderResponse } from "../src/types.ts";

type Request = {
  readonly url: URL;
  readonly options?: Record<string, unknown>;
};

const response = (json: unknown, status = 200): ProviderResponse => ({
  status,
  bodyText: JSON.stringify(json),
});

const context = (
  callback: (request: Request) => ProviderResponse,
  settings: Readonly<Record<string, string>>,
  requests: Request[],
): ProviderContext => ({
  settings: { get: (key) => settings[key], getSecret: (key) => settings[key] },
  http: {
    get: async (url, options) => callback({ url: new URL(url), ...(options ? { options } : {}) }),
    getJSON: async (url, options) => {
      const request = { url: new URL(url), ...(options ? { options } : {}) };
      requests.push(request);
      const result = callback(request);
      return { ...result, json: JSON.parse(result.bodyText) as unknown };
    },
    postJSON: async () => ({ status: 500, bodyText: "{}", json: {} }),
  },
  browser: { cookieHeader: async () => "" },
  env: { timeZone: "UTC" },
  date: {
    now: () => new Date("2026-08-21T12:00:00.000Z"),
    nowMillis: () => Date.parse("2026-08-21T12:00:00.000Z"),
    iso: (value) => new Date(value).toISOString(),
    unixSeconds: (value) => new Date(value * 1_000).toISOString(),
    unixMillis: (value) => new Date(value).toISOString(),
    nextDailyReset: () => "2026-08-22T00:00:00.000Z",
  },
  format: {
    number: (value) => String(value),
    usd: (value) => `$${value.toFixed(2)}`,
    monthDay: (value) => value.toISOString().slice(5, 10),
  },
  pct: (used, total) => (used / total) * 100,
  amountFromPercent: (usedPercent, total) => (usedPercent / 100) * total,
  fail: {
    authenticationExpired: (message) => new Error(message),
    missingCredential: (message) => new Error(message),
    permissionDenied: (message) => new Error(message),
    rateLimited: (message) => new Error(message),
    providerUnavailable: (message) => new Error(message),
    parseFailure: (message) => new Error(message),
    networkFailure: (message) => new Error(message),
    apiFailure: (message) => new Error(message),
  },
});

const quotaResponse = response({
  success: true,
  code: 200,
  data: {
    planName: "GLM Coding Plan",
    limits: [
      {
        type: "CREDIT_LIMIT",
        unit: 3,
        number: 5,
        percentage: 20,
        usage: 100,
        currentValue: 20,
        remaining: 80,
        nextResetTime: 1_800_000_000_000,
        usageDetails: [],
      },
    ],
  },
});

describe("post-0.54 upstream provider deltas", () => {
  it("adds the bounded BigModel CN account balance without making it quota-critical", async () => {
    const requests: Request[] = [];
    const result = await zai.fetchUsage(
      context(
        (request) => {
          if (request.url.pathname.endsWith("quota/limit")) return quotaResponse;
          if (request.url.hostname === "www.bigmodel.cn")
            return response({
              success: true,
              data: {
                availableBalance: 12.5,
                balance: 14,
                rechargeAmount: 20,
                giveAmount: 5,
                totalSpendAmount: 12.5,
              },
            });
          return response({}, 503);
        },
        { Z_AI_REGION: "bigmodel-cn" },
        requests,
      ),
    );

    expect(requests[1]).toMatchObject({
      url: new URL("https://www.bigmodel.cn/api/biz/account/query-customer-account-report"),
      options: { timeoutSeconds: 5 },
    });
    expect(result).toMatchObject({ identity: { loginMethod: "GLM Coding Plan" } });
    const details = result.details as readonly { readonly rows: readonly unknown[] }[];
    expect(details[0]?.rows).toContainEqual({
      label: "Account balance",
      value: "¥12.50",
      secondaryValue: "recharged ¥20.00 · granted ¥5.00 · spent ¥12.50",
    });
  });

  it("skips balance globally and does not turn null amounts into a fake zero", async () => {
    const globalRequests: Request[] = [];
    await zai.fetchUsage(
      context(
        (request) => (request.url.pathname.endsWith("quota/limit") ? quotaResponse : response({})),
        { Z_AI_REGION: "global" },
        globalRequests,
      ),
    );
    expect(globalRequests.some((request) => request.url.hostname === "www.bigmodel.cn")).toBe(
      false,
    );

    const cnRequests: Request[] = [];
    const result = await zai.fetchUsage(
      context(
        (request) =>
          request.url.pathname.endsWith("quota/limit")
            ? quotaResponse
            : request.url.hostname === "www.bigmodel.cn"
              ? response({ success: true, data: { availableBalance: null, balance: null } })
              : response({}),
        { Z_AI_REGION: "bigmodel-cn" },
        cnRequests,
      ),
    );
    expect(JSON.stringify(result)).not.toContain("Account balance");
    expect(zai.descriptor.endpoints).toContainEqual({
      setting: "Z_AI_BALANCE_ENDPOINT",
      policy: "https",
    });
  });
});
