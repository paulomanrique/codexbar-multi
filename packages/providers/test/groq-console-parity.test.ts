import { describe, expect, it } from "vite-plus/test";

import { mapFirstPartyProviderSnapshot } from "../src/snapshot-mapper.ts";
import {
  groq,
  groqConsoleOrganizationID,
  groqConsoleSessionFromCookieHeader,
  InvalidGroqConsoleActivity,
  makeGroqConsoleUsageSnapshot,
  mapGroqConsoleUsageSnapshot,
  parseGroqConsoleActivityRows,
  resolveGroqConsoleActivityURL,
} from "../src/index.ts";

const base64URL = (value: string): string =>
  btoa(value).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");

const jwt = (payload: string): string => `header.${base64URL(payload)}.signature`;

describe("Groq console pure parity", () => {
  it("decodes the Groq organization claim from a session JWT", () => {
    expect(
      groqConsoleOrganizationID(jwt('{"https://groq.com/organization":{"id":"org_abc123"}}')),
    ).toBe("org_abc123");
  });

  it("falls back to the Stytch organization slug when the Groq claim is absent", () => {
    expect(
      groqConsoleOrganizationID(jwt('{"https://stytch.com/organization":{"slug":"org_slug9"}}')),
    ).toBe("org_slug9");
  });

  it("returns undefined for malformed JWTs", () => {
    expect(groqConsoleOrganizationID("not-a-jwt")).toBeUndefined();
    expect(groqConsoleOrganizationID("only.two")).toBeUndefined();
    expect(groqConsoleOrganizationID(jwt('{"https://groq.com/organization":{}}'))).toBeUndefined();
  });

  it("parses the long session token and direct JWT from a cookie header", () => {
    expect(
      groqConsoleSessionFromCookieHeader(
        "Cookie: stytch_session=opaque123; stytch_session_jwt=jwt.abc.def; other=x",
      ),
    ).toEqual({
      sessionToken: "opaque123",
      directJWT: "jwt.abc.def",
      sourceLabel: "manual",
    });
  });

  it("aggregates activity rows into daily buckets and model breakdowns", () => {
    const rows = parseGroqConsoleActivityRows({
      object: "list",
      data: [
        {
          organization_name: "Personal",
          model: "llama-3.1-8b-instant",
          timestamp: 1_783_900_800,
          num_requests: 3,
          n_context_tokens_total: 100,
          n_non_cached_context_tokens_total: 80,
          n_generated_tokens_total: 40,
          cost: 0.01,
        },
        {
          organization_name: "Personal",
          model: "openai/gpt-oss-120b",
          timestamp: 1_783_901_000,
          num_requests: 2,
          n_context_tokens_total: 50,
          n_non_cached_context_tokens_total: 50,
          n_generated_tokens_total: 10,
          cost: 0.02,
        },
        {
          organization_name: "Personal",
          model: "llama-3.1-8b-instant",
          timestamp: 1_783_987_200,
          num_requests: 1,
          n_context_tokens_total: 10,
          n_non_cached_context_tokens_total: 10,
          n_generated_tokens_total: 5,
          cost: 0.005,
        },
      ],
    });

    const snapshot = makeGroqConsoleUsageSnapshot(rows, {
      updatedAt: new Date("2026-07-14T00:00:00.000Z"),
      historyDays: 30,
    });

    expect(snapshot.daily).toHaveLength(2);
    expect(snapshot.organizationName).toBe("Personal");
    expect(snapshot.daily[0]).toMatchObject({
      day: "2026-07-13",
      requests: 5,
      inputTokens: 130,
      cachedInputTokens: 20,
      outputTokens: 50,
      totalTokens: 200,
      costUSD: 0.03,
    });
    expect(snapshot.daily[0]?.models).toHaveLength(2);
    expect(snapshot.daily[1]).toMatchObject({
      day: "2026-07-14",
      requests: 1,
      totalTokens: 15,
      costUSD: 0.005,
    });
  });

  it("projects console usage to the shared UsageSnapshot shape", () => {
    const updatedAt = new Date("2026-07-14T00:00:00.000Z");
    const snapshot = makeGroqConsoleUsageSnapshot(
      [
        {
          organizationName: "Personal",
          model: "llama-3.1-8b-instant",
          timestamp: 1_783_900_800,
          numRequests: 10,
          contextTokensTotal: 100,
          nonCachedContextTokensTotal: 100,
          generatedTokensTotal: 50,
          costUSD: 0.5,
        },
      ],
      { updatedAt, historyDays: 30 },
    );

    const usage = mapFirstPartyProviderSnapshot(
      mapGroqConsoleUsageSnapshot(snapshot),
      groq.descriptor,
      updatedAt,
    );

    expect(usage.identity).toMatchObject({
      providerId: "groq",
      accountOrganization: "Personal",
      loginMethod: "Console",
    });
    expect(usage.providerCost).toMatchObject({
      used: 0.5,
      limit: 0,
      currencyCode: "USD",
      period: "Last 30 days",
    });
    expect(usage.details[0]?.chart?.points).toEqual([{ label: "2026-07-13", value: 0.5 }]);
  });

  it("rejects malformed declared activity fields", () => {
    expect(() => parseGroqConsoleActivityRows({ data: {} })).toThrow(InvalidGroqConsoleActivity);
    expect(() => parseGroqConsoleActivityRows({ data: [{ timestamp: "1" }] })).toThrow(
      InvalidGroqConsoleActivity,
    );
    expect(() =>
      parseGroqConsoleActivityRows({ data: [{ timestamp: 1, num_requests: 1.5 }] }),
    ).toThrow(InvalidGroqConsoleActivity);
  });

  it("builds the console activity URL from the validated Groq API origin", () => {
    expect(
      resolveGroqConsoleActivityURL(new URL("https://api.groq.com/v1"), "org_abc123", {
        start: new Date("2026-07-13T00:00:00.000Z"),
        end: new Date("2026-07-14T00:00:00.000Z"),
      }),
    ).toBe(
      "https://api.groq.com/platform/v1/organizations/org_abc123/activity?start_date=1783900800&end_date=1783987200",
    );
  });
});
