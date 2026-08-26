import { describe, expect, it } from "vite-plus/test";

import {
  normalizeQoderManualCredential,
  qoder,
  type QoderManualCredential,
} from "../src/providers/qoder.ts";
import type { ProviderContext, ProviderResponse } from "../src/types.ts";

type Request = {
  readonly method: "GET";
  readonly url: URL;
  readonly options?: Record<string, unknown>;
};

const error = (kind: string) => (message: string) => new Error(`${kind}: ${message}`);
const json = (value: unknown, status = 200): ProviderResponse => ({
  status,
  bodyText: JSON.stringify(value),
});
const usageFixture = json({
  total_quota: {
    quota_summary: {
      used_value: 25,
      limit_value: 100,
      remaining_value: 75,
      usage_percentage: 25,
    },
  },
});
const context = (
  fixture: (request: Request) => ProviderResponse,
  settings: Readonly<Record<string, string>> = {},
  requests: Request[] = [],
): ProviderContext => {
  const request = async (url: string, options?: Record<string, unknown>) => {
    const recorded = { method: "GET" as const, url: new URL(url), ...(options ? { options } : {}) };
    requests.push(recorded);
    return fixture(recorded);
  };
  return {
    settings: { get: (key) => settings[key], getSecret: (key) => settings[key] },
    http: {
      get: request,
      getJSON: async (url, options) => {
        const response = await request(url, options);
        return { ...response, json: JSON.parse(response.bodyText) as unknown };
      },
      postJSON: async () => {
        throw new Error("unused");
      },
    },
    browser: {
      cookieHeader: async () => {
        throw new Error("manual Qoder credential must not read browser cookies");
      },
    },
    env: {},
    date: {
      now: () => new Date("2026-08-20T12:00:00.000Z"),
      nowMillis: () => Date.parse("2026-08-20T12:00:00.000Z"),
      iso: (value) => new Date(value).toISOString(),
      unixSeconds: (value) => new Date(value * 1_000).toISOString(),
      unixMillis: (value) => new Date(value).toISOString(),
      nextDailyReset: () => "2026-08-21T00:00:00.000Z",
    },
    format: {
      number: (value, options) =>
        new Intl.NumberFormat("en-US", options as Intl.NumberFormatOptions).format(value),
      usd: (value) => `$${value.toFixed(2)}`,
      monthDay: (value) => value.toISOString(),
    },
    pct: (used, limit) => (used / limit) * 100,
    amountFromPercent: (percent, total) => (percent / 100) * total,
    fail: {
      authenticationExpired: error("authentication-expired"),
      missingCredential: error("missing-credential"),
      permissionDenied: error("permission-denied"),
      rateLimited: error("rate-limited"),
      providerUnavailable: error("provider-unavailable"),
      parseFailure: error("parse-failure"),
      networkFailure: error("network-failure"),
      apiFailure: error("api-failure"),
    },
  };
};

describe("Qoder manual cookie normalization", () => {
  it.each([
    ["sid=abc", { cookieHeader: "sid=abc", site: "qoder.com" }],
    ["Cookie: sid=abc", { cookieHeader: "sid=abc", site: "qoder.com" }],
    [
      "sid=abc; Domain=.qoder.com.cn",
      { cookieHeader: "sid=abc; Domain=.qoder.com.cn", site: "qoder.com.cn" },
    ],
    [
      "curl https://qoder.com.cn -H 'Host: qoder.com.cn' -H 'Cookie: sid=abc'",
      { cookieHeader: "sid=abc", site: "qoder.com.cn" },
    ],
    [
      "curl --url https://qoder.com -H 'Cookie: sid=abc'",
      { cookieHeader: "sid=abc", site: "qoder.com" },
    ],
    [
      "GET /account/usage HTTP/1.1\nHost: qoder.com.cn\nCookie: sid=abc",
      { cookieHeader: "sid=abc", site: "qoder.com.cn" },
    ],
    [
      "GET https://qoder.com/account/usage HTTP/1.1\nHost: qoder.com\nCookie: sid=abc",
      { cookieHeader: "sid=abc", site: "qoder.com" },
    ],
  ] as const)("accepts %s", (raw, expected) => {
    expect(normalizeQoderManualCredential(raw)).toEqual(expected satisfies QoderManualCredential);
  });

  it.each([
    undefined,
    "",
    "Cookie: sid=abc\r\nInjected: yes",
    "sid=abc\0",
    "sid=abc; Domain=example.com",
    "sid=abc; Domain=qoder.com; Domain=qoder.com.cn",
    "curl https://qoder.com https://qoder.com.cn -H 'Cookie: sid=abc'",
    "curl https://qoder.com -H 'Host: qoder.com.cn' -H 'Cookie: sid=abc'",
    "curl https://qoder.com -H 'Cookie: sid=abc; Domain=.qoder.com.cn'",
    "GET /account/usage HTTP/1.1\nHost: qoder.com\nCookie: sid=abc; Domain=.qoder.com.cn",
    "curl https://example.com -H 'Cookie: sid=abc'",
    "curl https://qoder.com --config qoder.curlrc -H 'Cookie: sid=abc'",
    "curl https://qoder.com --location-trusted -H 'Cookie: sid=abc'",
    "curl https://qoder.com --parallel -H 'Cookie: sid=abc'",
    "curl https://qoder.com -H @headers.txt -H 'Cookie: sid=abc'",
    "curl https://qoder.com -H 'Cookie: sid=abc\r\nHost: qoder.com.cn'",
    "GET https://qoder.com/account/usage HTTP/1.1\nHost: qoder.com.cn\nCookie: sid=abc",
    "GET /account/usage HTTP/1.1\nHost: qoder.com.cn:evil\nCookie: sid=abc",
    `sid=${"a".repeat(1024 * 1024)}`,
  ] as const)("rejects %s", (raw) => {
    expect(normalizeQoderManualCredential(raw)).toBeUndefined();
  });

  it("uses only the routed manual Qoder site and preserves Swift request headers", async () => {
    const requests: Request[] = [];
    const snapshot = await qoder.fetchUsage(
      context(
        () => usageFixture,
        { QODER_COOKIE_HEADER: "sid=abc", QODER_SITE: "qoder.com.cn" },
        requests,
      ),
    );

    expect(requests.map((request) => request.url.hostname)).toEqual(["qoder.com.cn"]);
    expect(requests[0]?.options).toMatchObject({
      headers: {
        Cookie: "sid=abc",
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
        Origin: "https://qoder.com.cn",
        Referer: "https://qoder.com.cn/account/usage",
        "X-Requested-With": "XMLHttpRequest",
        "Bx-V": "2.5.35",
      },
    });
    expect(snapshot).toMatchObject({
      primary: { usedPercent: 25, resetDescription: "25 / 100 credits" },
    });
  });

  it("rejects invalid manual material before browser fallback", async () => {
    await expect(
      qoder.fetchUsage(
        context(() => usageFixture, {
          QODER_COOKIE_HEADER: "curl https://qoder.com https://qoder.com.cn -H 'Cookie: sid=abc'",
        }),
      ),
    ).rejects.toThrow("missing-credential:");
  });

  it.each([
    { used_value: -1, limit_value: 100 },
    { used_value: 1, limit_value: Number.NaN },
    { used_value: 1, limit_value: 100, remaining_value: -1 },
    { used_value: 1, limit_value: 0, remaining_value: 0 },
    { used_value: "1", limit_value: 100 },
  ])("rejects malformed quota values %#", async (quotaSummary) => {
    await expect(
      qoder.fetchUsage(
        context(
          () =>
            json({
              total_quota: { quota_summary: quotaSummary },
            }),
          { QODER_COOKIE_HEADER: "sid=fixture" },
        ),
      ),
    ).rejects.toThrow("parse-failure:");
  });
});
