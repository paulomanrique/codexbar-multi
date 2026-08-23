import { describe, expect, it } from "vite-plus/test";

import { alibaba } from "../src/providers/alibaba.ts";
import { alibabatokenplan } from "../src/providers/alibabatokenplan.ts";
import { qwencloud } from "../src/providers/qwencloud.ts";
import type { ProviderContext, ProviderResponse } from "../src/types.ts";

type Request = {
  readonly method: "GET" | "POST";
  readonly url: URL;
  readonly options?: Record<string, unknown>;
};
const failure = (kind: string) => (message: string) => new Error(`${kind}: ${message}`);
const response = (json: unknown, status = 200): ProviderResponse => ({
  status,
  bodyText: JSON.stringify(json),
});

const context = (
  callback: (request: Request) => ProviderResponse,
  options: {
    readonly settings?: Record<string, string>;
    readonly cookie?: string;
    readonly requests?: Request[];
    readonly sleep?: (milliseconds: number) => Promise<void>;
  } = {},
): ProviderContext => {
  const request = async (
    method: "GET" | "POST",
    url: string,
    requestOptions?: Record<string, unknown>,
  ) => {
    const entry: Request = {
      method,
      url: new URL(url),
      ...(requestOptions ? { options: requestOptions } : {}),
    };
    options.requests?.push(entry);
    return callback(entry);
  };
  const settings = options.settings ?? {};
  return {
    settings: { get: (key) => settings[key], getSecret: (key) => settings[key] },
    http: {
      get: (url, requestOptions) => request("GET", url, requestOptions),
      getJSON: async (url, requestOptions) => {
        const result = await request("GET", url, requestOptions);
        return { ...result, json: JSON.parse(result.bodyText) as unknown };
      },
      postJSON: async (url, requestOptions) => {
        const result = await request("POST", url, requestOptions);
        return { ...result, json: JSON.parse(result.bodyText) as unknown };
      },
    },
    browser: { cookieHeader: async () => options.cookie ?? "" },
    env: { timeZone: "UTC" },
    date: {
      now: () => new Date("2026-08-20T12:00:00.000Z"),
      nowMillis: () => Date.parse("2026-08-20T12:00:00.000Z"),
      iso: (value) => new Date(value).toISOString(),
      unixSeconds: (value) => new Date(value * 1_000).toISOString(),
      unixMillis: (value) => new Date(value).toISOString(),
      nextDailyReset: () => "2026-08-21T00:00:00.000Z",
      ...(options.sleep ? { sleep: options.sleep } : {}),
    },
    format: {
      number: (value, formatOptions) =>
        new Intl.NumberFormat("en-US", formatOptions as Intl.NumberFormatOptions).format(value),
      usd: (value) => `$${value.toFixed(2)}`,
      monthDay: (value) => value.toISOString().slice(5, 10),
    },
    pct: (used, total) => (used / total) * 100,
    amountFromPercent: (usedPercent, total) => (usedPercent / 100) * total,
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
};

describe("Alibaba and Qwen Cloud Swift parity", () => {
  it("declares all browser-session capabilities without importing a platform cookie store", () => {
    expect(
      [alibaba, alibabatokenplan, qwencloud].map((provider) => provider.descriptor.id),
    ).toEqual(["alibaba", "alibabatokenplan", "qwencloud"]);
    for (const provider of [alibaba, alibabatokenplan, qwencloud]) {
      expect(provider.descriptor.capabilities).toEqual(["browser-cookies"]);
      expect(provider.descriptor.cookieDomains?.length).toBeGreaterThan(0);
    }
  });

  it("parses Alibaba Coding Plan API-key quota lanes and exact auth headers", async () => {
    const requests: Request[] = [];
    const raw = await alibaba.fetchUsage(
      context(
        () =>
          response({
            data: {
              codingPlanInstanceInfos: [
                {
                  planName: "Pro",
                  status: "ACTIVE",
                  codingPlanQuotaInfo: {
                    per5HourUsedQuota: 12,
                    per5HourTotalQuota: 120,
                    per5HourQuotaNextRefreshTime: 1_800_000_000_000,
                    perWeekUsedQuota: 75,
                    perWeekTotalQuota: 500,
                    perBillMonthUsedQuota: 8,
                    perBillMonthTotalQuota: 100,
                  },
                },
              ],
            },
          }),
        { settings: { ALIBABA_CODING_PLAN_API_KEY: "fixture-key" }, requests },
      ),
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url.hostname).toBe("modelstudio.console.alibabacloud.com");
    expect(requests[0]?.options).toMatchObject({
      headers: {
        Authorization: "Bearer fixture-key",
        "x-api-key": "fixture-key",
        "X-DashScope-API-Key": "fixture-key",
      },
    });
    expect(raw).toMatchObject({
      primary: { usedPercent: 10, windowMinutes: 300, resetDescription: "12 / 120 used" },
      secondary: { usedPercent: 15, windowMinutes: 10_080 },
      tertiary: { usedPercent: 8, windowMinutes: 43_200 },
      identity: { loginMethod: "Pro" },
    });
  });

  it("parses the shared Alibaba Personal token-plan fixtures and preserves the form envelope", async () => {
    const requests: Request[] = [];
    const raw = await alibabatokenplan.fetchUsage(
      context(
        (request) => {
          if (request.method === "GET")
            return {
              status: 200,
              bodyText:
                '<script>window.ALIYUN_CONSOLE_CONFIG = { SEC_TOKEN: "fixture-token" };</script>',
            };
          const body = decodeURIComponent(String(request.options?.body));
          if (body.includes('"Api":"zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/subscription"'))
            return response({ data: { DataV2: { data: { data: { specCode: "pro" } } } } });
          if (body.includes('"Api":"zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/quota-config"'))
            return response({
              data: { DataV2: { data: { data: { pro: { five_hour: 12_000, weekly: 40_000 } } } } },
            });
          return response({
            data: {
              DataV2: {
                data: {
                  data: {
                    per5HourPercentage: 0.0009973083333333333,
                    per5HourResetTime: 1_784_813_220_000,
                    per1WeekPercentage: 0.0003014725,
                    per1WeekResetTime: 1_785_234_900_000,
                  },
                },
              },
            },
          });
        },
        {
          settings: {
            ALIBABA_TOKEN_PLAN_REGION: "intl-personal",
            ALIBABA_TOKEN_PLAN_COOKIE: "sid=fixture",
          },
          requests,
        },
      ),
    );
    expect(requests).toHaveLength(4);
    expect(requests[0]?.options).toMatchObject({
      headers: {
        Referer: "https://modelstudio.console.alibabacloud.com/",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": "document",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
    });
    expect(requests[1]?.url.hostname).toBe("bailian-singapore-cs.alibabacloud.com");
    expect(decodeURIComponent(String(requests[1]?.options?.body))).toContain(
      "sec_token=fixture-token",
    );
    expect(requests[1]?.options).toMatchObject({
      headers: { Cookie: "sid=fixture", Origin: "https://modelstudio.console.alibabacloud.com" },
    });
    expect(raw).toMatchObject({
      primary: {
        usedPercent: 0.09973083333333332,
        windowMinutes: 300,
        resetDescription: "11.97 / 12,000 credits used",
      },
      secondary: {
        usedPercent: 0.03014725,
        windowMinutes: 10_080,
        resetDescription: "12.06 / 40,000 credits used",
      },
      identity: { loginMethod: "Pro" },
    });
  });

  it("retries an empty Personal Success envelope before publishing usage", async () => {
    let usageCalls = 0;
    const sleeps: number[] = [];
    const raw = await alibabatokenplan.fetchUsage(
      context(
        (request) => {
          if (request.method === "GET") return { status: 200, bodyText: "<html></html>" };
          const body = decodeURIComponent(String(request.options?.body));
          if (body.includes('"Api":"zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage"')) {
            usageCalls += 1;
            return usageCalls === 1
              ? response({ code: "SUCCESS", successResponse: true, data: {} })
              : response({ data: { per5HourPercentage: 0.25 } });
          }
          return response({});
        },
        {
          settings: {
            ALIBABA_TOKEN_PLAN_REGION: "cn-personal",
            ALIBABA_TOKEN_PLAN_COOKIE: "sid=fixture",
          },
          sleep: async (milliseconds) => {
            sleeps.push(milliseconds);
          },
        },
      ),
    );
    expect(usageCalls).toBe(2);
    expect(sleeps).toEqual([400]);
    expect(raw.primary).toMatchObject({ usedPercent: 25, windowMinutes: 300 });
  });

  it("classifies a persistently empty Personal Success envelope as transient", async () => {
    let usageCalls = 0;
    const sleeps: number[] = [];
    await expect(
      alibabatokenplan.fetchUsage(
        context(
          (request) => {
            if (request.method === "GET") return { status: 200, bodyText: "<html></html>" };
            const body = decodeURIComponent(String(request.options?.body));
            if (body.includes('"Api":"zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage"')) {
              usageCalls += 1;
              return response({ code: "SUCCESS", successResponse: true, data: {} });
            }
            return response({});
          },
          {
            settings: {
              ALIBABA_TOKEN_PLAN_REGION: "cn-personal",
              ALIBABA_TOKEN_PLAN_COOKIE: "sid=fixture",
            },
            sleep: async (milliseconds) => {
              sleeps.push(milliseconds);
            },
          },
        ),
      ),
    ).rejects.toThrow(
      "provider-unavailable: Alibaba Token Plan usage is temporarily unavailable; it will refresh automatically.",
    );
    expect(usageCalls).toBe(3);
    expect(sleeps).toEqual([400, 400]);
  });

  it("keeps the OneConsole token fallback compatible with lower-case and missing shells", async () => {
    const cases = [
      {
        name: "lower-case sec_token",
        shell: "<script>var x = { sec_token: 'lower-token' };</script>",
        token: "lower-token",
      },
      {
        name: "token-less shell",
        shell: "<html><body>no token here</body></html>",
        token: undefined,
      },
    ] as const;

    for (const testCase of cases) {
      const requests: Request[] = [];
      await alibabatokenplan.fetchUsage(
        context(
          (request) => {
            if (request.method === "GET") return { status: 200, bodyText: testCase.shell };
            const body = decodeURIComponent(String(request.options?.body));
            if (
              body.includes('"Api":"zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/subscription"')
            )
              return response({});
            if (
              body.includes('"Api":"zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/quota-config"')
            )
              return response({});
            expect(
              body.includes(testCase.token ? `sec_token=${testCase.token}` : "sec_token="),
            ).toBe(testCase.token !== undefined);
            return response({ data: { per5HourPercentage: 0.03 } });
          },
          {
            settings: {
              ALIBABA_TOKEN_PLAN_REGION: "cn-personal",
              ALIBABA_TOKEN_PLAN_COOKIE: "sid=fixture",
            },
            requests,
          },
        ),
      );
      expect(requests[0]?.options).toMatchObject({
        headers: {
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          Referer: "https://bailian.console.aliyun.com/",
          "Sec-Fetch-Site": "same-origin",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Dest": "document",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
      });
      expect(testCase.name).toBeTruthy();
    }
  });

  it("parses Qwen Cloud current personal windows and classifies login payloads", async () => {
    const raw = await qwencloud.fetchUsage(
      context(
        (request) => {
          if (request.method === "GET") return response("<html>sec_token = 'qwen-token'</html>");
          const body = decodeURIComponent(String(request.options?.body));
          if (body.includes('"Api":"zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/subscription"'))
            return response({ data: { specCode: "standard" } });
          if (body.includes('"Api":"zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/quota-config"'))
            return response({ data: { standard: { five_hour: 3_000, weekly: 10_000 } } });
          return response({
            data: {
              per5HourPercentage: 0.03,
              per5HourResetTime: 1_700_003_600_000,
              per1WeekPercentage: 0.01,
              per1WeekResetTime: 1_700_086_400_000,
            },
          });
        },
        { settings: { QWEN_CLOUD_COOKIE: "login_qwencloud_ticket=fixture" } },
      ),
    );
    expect(raw).toMatchObject({
      primary: { usedPercent: 3, windowMinutes: 300, resetDescription: "90 / 3,000 credits used" },
      secondary: {
        usedPercent: 1,
        windowMinutes: 10_080,
        resetDescription: "100 / 10,000 credits used",
      },
      identity: { loginMethod: "Standard" },
    });
    await expect(
      qwencloud.fetchUsage(
        context(() => response({ code: "ConsoleNeedLogin", successResponse: false }), {
          settings: { QWEN_CLOUD_COOKIE: "sid=fixture" },
        }),
      ),
    ).rejects.toThrow("authentication-expired");
  });
});
