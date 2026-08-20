import { describe, expect, it } from "vite-plus/test";

import { openai } from "../src/providers/openai.ts";
import { t3chat } from "../src/providers/t3chat.ts";
import { mapProviderSnapshot } from "../src/snapshot-mapper.ts";
import type { ProviderContext, ProviderResponse } from "../src/types.ts";

const fail = (kind: string) => (message: string) => new Error(`${kind}: ${message}`);

function context(options: {
  readonly now: Date;
  readonly settings?: Readonly<Record<string, string>>;
  readonly cookie?: string;
  readonly onCookieDomain?: (domain: string) => void;
  readonly request: (url: URL, options?: Record<string, unknown>) => ProviderResponse;
}): ProviderContext {
  const settings = options.settings ?? {};
  const request = async (url: string, requestOptions?: Record<string, unknown>) =>
    options.request(new URL(url), requestOptions);
  return {
    settings: {
      get: (key) => settings[key],
      getSecret: (key) => settings[key],
    },
    http: {
      get: request,
      getJSON: async (url, requestOptions) => {
        const response = await request(url, requestOptions);
        return { ...response, json: JSON.parse(response.bodyText) as unknown };
      },
      postJSON: async (url, requestOptions) => {
        const response = await request(url, requestOptions);
        return { ...response, json: JSON.parse(response.bodyText) as unknown };
      },
    },
    browser: {
      cookieHeader: async (domain) => {
        options.onCookieDomain?.(domain);
        return options.cookie ?? "";
      },
    },
    env: {},
    date: {
      now: () => new Date(options.now),
      nowMillis: () => options.now.getTime(),
      iso: (value) => new Date(value).toISOString(),
      unixSeconds: (value) => new Date(value * 1_000).toISOString(),
      unixMillis: (value) => new Date(value).toISOString(),
      nextDailyReset: () => "2026-08-21T00:00:00.000Z",
    },
    format: {
      number: (value, formatOptions) =>
        new Intl.NumberFormat("en-US", formatOptions as Intl.NumberFormatOptions).format(value),
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

const openAiCosts = {
  object: "page",
  data: [
    {
      object: "bucket",
      start_time: 1_700_000_000,
      end_time: 1_700_086_400,
      results: [
        { amount: { value: 12.5, currency: "usd" }, line_item: "Text tokens" },
        { amount: { value: "2.25", currency: "usd" }, line_item: "Web search tool calls" },
      ],
    },
  ],
  has_more: false,
  next_page: null,
};

const openAiCompletions = {
  object: "page",
  data: [
    {
      object: "bucket",
      start_time: 1_700_000_000,
      end_time: 1_700_086_400,
      results: [
        {
          input_tokens: 1_000,
          input_cached_tokens: 250,
          output_tokens: 500,
          num_model_requests: 7,
          model: "gpt-5.2",
        },
        {
          input_tokens: 300,
          output_tokens: 200,
          num_model_requests: 3,
          model: "gpt-5.2-codex",
        },
      ],
    },
  ],
  has_more: false,
  next_page: null,
};

describe("first vertical slice Swift parity goldens", () => {
  it("maps the upstream OpenAI costs/completions fixture deterministically", async () => {
    const requestedRanges: string[] = [];
    const now = new Date(1_700_179_200 * 1_000);
    const raw = await openai.fetchUsage(
      context({
        now,
        settings: { OPENAI_API_KEY: "fixture-key", OPENAI_HISTORY_DAYS: "30" },
        request: (url) => {
          requestedRanges.push(url.searchParams.get("start_time") ?? "");
          return {
            status: 200,
            bodyText: JSON.stringify(
              url.pathname.endsWith("/organization/costs") ? openAiCosts : openAiCompletions,
            ),
          };
        },
      }),
    );

    const snapshot = mapProviderSnapshot(raw, "openai", now);
    expect(new Set(requestedRanges)).toEqual(new Set(["1697673600"]));
    expect(snapshot.providerCost).toMatchObject({
      used: 14.75,
      currencyCode: "USD",
      period: "Last 30 days",
    });
    expect(snapshot.identity).toMatchObject({ providerId: "openai", loginMethod: "Admin API" });
    expect(snapshot.details).toEqual([
      {
        title: "Usage summary",
        rows: [
          { label: "Spend", value: "$14.75", secondaryValue: "Last 30 days" },
          { label: "Requests", value: "10" },
          { label: "Tokens", value: "2,000", secondaryValue: "1,300 input · 700 output" },
          { label: "Cached input", value: "250" },
        ],
        chart: {
          kind: "bars",
          title: "Daily spend",
          unit: "USD",
          points: [{ label: "2023-11-14", value: 14.75 }],
        },
      },
      {
        title: "Models",
        rows: [
          { label: "gpt-5.2", value: "1,500 tokens", secondaryValue: "7 requests" },
          { label: "gpt-5.2-codex", value: "500 tokens", secondaryValue: "3 requests" },
        ],
      },
      {
        title: "Line items",
        rows: [
          { label: "Text tokens", value: "$12.50" },
          { label: "Web search tool calls", value: "$2.25" },
        ],
      },
    ]);
  });

  it("maps the upstream T3 Chat JSONL fixture to base and overage windows", async () => {
    const now = new Date(1_778_000_000 * 1_000);
    const body = [
      '{"json":{"0":[[0],[null,0,0]]}}',
      '{"json":[2,0,[[{"subTier":"pro","subscription":{"productName":"pro","currentPeriodEnd":1780763009000},"usageBand":"max","billingNextResetAt":1779366216920,"usageFourHourPercentage":12.5,"usageMonthPercentage":34.25,"usageFourHourNextResetAt":1779366216920}]]]}',
    ].join("\n");
    let cookieDomain = "";
    let requestHeaders: Record<string, string> | undefined;
    const raw = await t3chat.fetchUsage(
      context({
        now,
        cookie: "session=fixture",
        onCookieDomain: (domain) => {
          cookieDomain = domain;
        },
        request: (_url, options) => {
          requestHeaders = options?.headers as Record<string, string> | undefined;
          return { status: 200, bodyText: body };
        },
      }),
    );

    const snapshot = mapProviderSnapshot(raw, "t3chat", now);
    expect(cookieDomain).toBe("t3.chat");
    expect(requestHeaders).toMatchObject({ Cookie: "session=fixture", Origin: "https://t3.chat" });
    expect(snapshot.primary).toEqual({
      usedPercent: 12.5,
      windowMinutes: 240,
      resetsAt: "2026-05-21T12:23:36.920Z",
      resetDescription: "Base - max",
    });
    expect(snapshot.secondary).toEqual({
      usedPercent: 34.25,
      resetsAt: "2026-06-06T16:23:29.000Z",
      resetDescription: "Overage",
    });
    expect(snapshot.identity).toEqual({ providerId: "t3chat", loginMethod: "Pro" });
  });
});
