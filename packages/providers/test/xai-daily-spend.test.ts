import { describe, expect, it } from "vite-plus/test";
import { mapXaiDailySpendSnapshot } from "@codexbar/core";

import { xai } from "../src/providers/xai.ts";
import { mapProviderSnapshot } from "../src/snapshot-mapper.ts";
import type { ProviderContext, ProviderResponse } from "../src/types.ts";

const now = new Date("2026-08-20T12:00:00.000Z");
const response = (body: unknown, status = 200): ProviderResponse => ({
  status,
  bodyText: JSON.stringify(body),
});
const failure = (kind: string) => (message: string) => new Error(`${kind}: ${message}`);

const context = (usage: ProviderResponse | Error): ProviderContext => {
  const request = async (
    _url: string,
    _options?: Record<string, unknown>,
  ): Promise<ProviderResponse> => response({ total: { val: "-1234" } });
  return {
    settings: {
      get: (key) => (key === "XAI_TEAM_ID" ? "fixture-team" : undefined),
      getSecret: () => undefined,
    },
    http: {
      get: request,
      getJSON: async (url, options) => {
        const result = await request(url, options);
        return { ...result, json: JSON.parse(result.bodyText) as unknown };
      },
      postJSON: async (url, options) => {
        if (usage instanceof Error) throw usage;
        const result = await request(url, options);
        return {
          ...(url.endsWith("/prepaid/balance") ? result : usage),
          json: JSON.parse((url.endsWith("/prepaid/balance") ? result : usage).bodyText) as unknown,
        };
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
      number: (value) => String(value),
      usd: (value) => `$${value}`,
      monthDay: () => "Aug 20",
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
};

describe("xAI daily-spend provider to ingestion boundary", () => {
  it("publishes an empty parseable 2xx analytics chart as confirmed-empty spend", async () => {
    const raw = await xai.fetchUsage(context(response({ timeSeries: [] })));
    const snapshot = mapProviderSnapshot(raw, "xai", now);
    expect(snapshot.details[0]?.chart?.points).toEqual([]);
    expect(snapshot.dataConfidence).toBe("exact");
    expect(mapXaiDailySpendSnapshot(snapshot)).toMatchObject({
      availability: "available",
      coverage: "exact",
      records: [],
    });
  });

  it("keeps a best-effort analytics failure unavailable instead of treating prepaid balance as spend", async () => {
    const raw = await xai.fetchUsage(
      context(response({ message: "temporarily unavailable" }, 500)),
    );
    const snapshot = mapProviderSnapshot(raw, "xai", now);
    expect(snapshot.details[0]?.chart).toBeUndefined();
    expect(snapshot.dataConfidence).toBe("unknown");
    expect(mapXaiDailySpendSnapshot(snapshot)).toMatchObject({
      availability: "unavailable",
      coverage: "estimated",
      records: [],
    });
  });

  it("propagates analytics cancellation instead of converting it into an unavailable chart", async () => {
    const cancellation = new Error("fixture cancellation");
    cancellation.name = "AbortError";
    await expect(xai.fetchUsage(context(cancellation))).rejects.toBe(cancellation);
  });
});
