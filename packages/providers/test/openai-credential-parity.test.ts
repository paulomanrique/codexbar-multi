import { describe, expect, it } from "vite-plus/test";

import { openai } from "../src/providers/openai.ts";
import type { ProviderContext, ProviderResponse } from "../src/types.ts";

type Request = {
  readonly url: URL;
  readonly options?: Record<string, unknown>;
};

const now = new Date("2026-08-25T12:00:00.000Z");
const failure = (kind: string) => (message: string) => new Error(`${kind}: ${message}`);

const context = (
  settings: Readonly<Record<string, string>>,
  requests: Request[],
  fixture: (request: Request) => ProviderResponse,
): ProviderContext => {
  const get = async (url: string, options?: Record<string, unknown>) => {
    const request = { url: new URL(url), ...(options === undefined ? {} : { options }) };
    requests.push(request);
    return fixture(request);
  };
  return {
    settings: { get: (key) => settings[key], getSecret: (key) => settings[key] },
    http: {
      get,
      getJSON: async (url, options) => {
        const response = await get(url, options);
        return { ...response, json: JSON.parse(response.bodyText) as unknown };
      },
      postJSON: async (url, options) => {
        const response = await get(url, options);
        return { ...response, json: JSON.parse(response.bodyText) as unknown };
      },
    },
    browser: { cookieHeader: async () => "" },
    env: {},
    date: {
      now: () => new Date(now),
      nowMillis: () => now.getTime(),
      iso: (value) => new Date(value).toISOString(),
      unixSeconds: (value) => new Date(value * 1_000).toISOString(),
      unixMillis: (value) => new Date(value).toISOString(),
      nextDailyReset: () => "2026-08-26T00:00:00.000Z",
    },
    format: {
      number: (value) => new Intl.NumberFormat("en-US").format(value),
      usd: (value) =>
        new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value),
      monthDay: (value) =>
        new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(value),
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

const json = (body: unknown, status = 200): ProviderResponse => ({
  status,
  bodyText: JSON.stringify(body),
});

const emptyPage = { data: [], has_more: false, next_page: null };

describe("OpenAI Swift-derived credential and fallback policy", () => {
  it("prefers a cleaned Admin key, scopes the project, and sends explicit auth", async () => {
    const requests: Request[] = [];
    const snapshot = await openai.fetchUsage(
      context(
        {
          OPENAI_ADMIN_KEY: "  'admin-selected'  ",
          OPENAI_API_KEY: "legacy-ambient",
          OPENAI_PROJECT_ID: '  "proj-selected"  ',
          OPENAI_HISTORY_DAYS: "1",
        },
        requests,
        () => json(emptyPage),
      ),
    );
    expect(requests).toHaveLength(2);
    expect(requests.map(({ url }) => url.pathname)).toEqual([
      "/v1/organization/costs",
      "/v1/organization/usage/completions",
    ]);
    expect(
      requests.every(({ url }) => url.searchParams.get("project_ids") === "proj-selected"),
    ).toBe(true);
    expect(
      requests.every(
        ({ options }) =>
          (options?.headers as Record<string, string> | undefined)?.Authorization ===
            "Bearer admin-selected" && options?.timeoutSeconds === 20,
      ),
    ).toBe(true);
    expect(snapshot.identity).toEqual({
      loginMethod: "Admin API: proj-selected",
      organization: "Project: proj-selected",
    });
    expect(JSON.stringify(snapshot)).not.toContain("admin-selected");
    expect(JSON.stringify(snapshot)).not.toContain("legacy-ambient");
  });

  it("uses the legacy key and deterministic credit expiry when organization usage fails", async () => {
    const requests: Request[] = [];
    const expiry = Math.floor(now.getTime() / 1_000) + 3_600;
    const snapshot = await openai.fetchUsage(
      context({ OPENAI_API_KEY: ' "legacy-key" ' }, requests, ({ url }) =>
        url.pathname === "/v1/dashboard/billing/credit_grants"
          ? json({
              total_granted: 100,
              total_used: 25,
              total_available: 75,
              grants: { data: [{ expires_at: expiry }] },
            })
          : json({ error: "usage unavailable" }, 500),
      ),
    );
    expect(requests.map(({ url }) => url.pathname)).toEqual([
      "/v1/organization/costs",
      "/v1/dashboard/billing/credit_grants",
    ]);
    expect(
      requests.every(
        ({ options }) =>
          (options?.headers as Record<string, string> | undefined)?.Authorization ===
          "Bearer legacy-key",
      ),
    ).toBe(true);
    expect(snapshot).toMatchObject({
      primary: { usedPercent: 25, resetsAt: new Date(expiry * 1_000).toISOString() },
      cost: { used: 25, limit: 100, resetsAt: new Date(expiry * 1_000).toISOString() },
      identity: { loginMethod: "API balance: $75.00" },
    });
  });

  it("never falls back from project-scoped Admin usage", async () => {
    const requests: Request[] = [];
    await expect(
      openai.fetchUsage(
        context({ OPENAI_ADMIN_KEY: "admin-key", OPENAI_PROJECT_ID: "proj-locked" }, requests, () =>
          json({ error: "denied" }, 403),
        ),
      ),
    ).rejects.toThrow("OpenAI API usage costs error: HTTP 403");
    expect(requests).toHaveLength(1);
  });

  it("returns the billing error only when organization usage rejected the credential", async () => {
    for (const [usageStatus, expectedMessage] of [
      [403, "OpenAI rejected this key for credit balance access (HTTP 401)."],
      [500, "OpenAI API usage costs error: HTTP 500"],
    ] as const) {
      const requests: Request[] = [];
      await expect(
        openai.fetchUsage(
          context({ OPENAI_ADMIN_KEY: "admin-key" }, requests, ({ url }) =>
            url.pathname === "/v1/dashboard/billing/credit_grants"
              ? json({ error: "billing denied" }, 401)
              : json({ error: "usage failed" }, usageStatus),
          ),
        ),
      ).rejects.toThrow(expectedMessage);
      expect(requests).toHaveLength(2);
    }
  });

  it("rejects numeric strings and malformed grant rows like Swift Decodable", async () => {
    for (const billingBody of [
      { total_granted: "100", total_used: 25, total_available: 75 },
      {
        total_granted: 100,
        total_used: 25,
        total_available: 75,
        grants: { data: [{ expires_at: "2000000000" }] },
      },
    ]) {
      const requests: Request[] = [];
      await expect(
        openai.fetchUsage(
          context({ OPENAI_API_KEY: "legacy-key" }, requests, ({ url }) =>
            url.pathname === "/v1/dashboard/billing/credit_grants"
              ? json(billingBody)
              : json({ error: "usage unavailable" }, 500),
          ),
        ),
      ).rejects.toThrow("OpenAI API usage costs error: HTTP 500");
      expect(requests).toHaveLength(2);
      expect(requests[1]?.options?.timeoutSeconds).toBe(15);
    }
  });

  it("preserves cancellation without starting the billing fallback", async () => {
    const requests: Request[] = [];
    const aborted = new Error("cancelled");
    aborted.name = "AbortError";
    await expect(
      openai.fetchUsage(
        context({ OPENAI_ADMIN_KEY: "admin-key" }, requests, () => {
          throw aborted;
        }),
      ),
    ).rejects.toBe(aborted);
    expect(requests).toHaveLength(1);
  });

  it("preserves cancellation raised by the billing fallback", async () => {
    const requests: Request[] = [];
    const aborted = new Error("cancelled");
    aborted.name = "AbortError";
    await expect(
      openai.fetchUsage(
        context({ OPENAI_ADMIN_KEY: "admin-key" }, requests, ({ url }) => {
          if (url.pathname === "/v1/dashboard/billing/credit_grants") throw aborted;
          return json({ error: "credential rejected" }, 401);
        }),
      ),
    ).rejects.toBe(aborted);
    expect(requests.map(({ url }) => url.pathname)).toEqual([
      "/v1/organization/costs",
      "/v1/dashboard/billing/credit_grants",
    ]);
  });

  it("fails before transport when neither OpenAI key is configured", async () => {
    const requests: Request[] = [];
    await expect(openai.fetchUsage(context({}, requests, () => json(emptyPage)))).rejects.toThrow(
      "missing-credential:",
    );
    expect(requests).toHaveLength(0);
  });
});
