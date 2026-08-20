import { describe, expect, it } from "vite-plus/test";

import { codex } from "../src/providers/codex.ts";
import type { ProviderContext } from "../src/types.ts";

type Response = { readonly status?: number; readonly json: unknown };

function context(
  json: unknown,
  options: {
    readonly responses?: readonly Response[];
    readonly requests?: Array<{ readonly url: string; readonly options?: Record<string, unknown> }>;
    readonly settings?: Readonly<Record<string, string | undefined>>;
    readonly sourceMode?: ProviderContext["sourceMode"];
  } = {},
): ProviderContext {
  const fail = (kind: string) => (message: string) => new Error(`${kind}: ${message}`);
  let responseIndex = 0;
  const response = (): Response => options.responses?.[responseIndex++] ?? { json };
  const settings: Readonly<Record<string, string | undefined>> = {
    CODEX_ACCESS_TOKEN: "token",
    ...options.settings,
  };
  return {
    settings: { get: (key) => settings[key], getSecret: (key) => settings[key] },
    http: {
      get: async () => ({ status: 200, bodyText: JSON.stringify(json) }),
      getJSON: async (url, requestOptions) => {
        options.requests?.push({
          url,
          ...(requestOptions === undefined ? {} : { options: requestOptions }),
        });
        const next = response();
        return { status: next.status ?? 200, bodyText: JSON.stringify(next.json), json: next.json };
      },
      postJSON: async () => ({ status: 200, bodyText: JSON.stringify(json), json }),
    },
    browser: { cookieHeader: async () => "" },
    env: {},
    ...(options.sourceMode === undefined ? {} : { sourceMode: options.sourceMode }),
    date: {
      now: () => new Date("2026-08-19T00:00:00Z"),
      nowMillis: () => Date.parse("2026-08-19T00:00:00Z"),
      iso: (value) => new Date(value).toISOString(),
      unixSeconds: (value) => new Date(value * 1000).toISOString(),
      unixMillis: (value) => new Date(value).toISOString(),
      nextDailyReset: () => "2026-08-20T00:00:00Z",
    },
    format: { number: String, usd: String, monthDay: (value) => value.toISOString().slice(5, 10) },
    pct: (used, limit) => (used / limit) * 100,
    amountFromPercent: (used, limit) => (used / 100) * limit,
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

describe("Codex OAuth usage vertical slice", () => {
  it("maps wham usage windows without platform knowledge", async () => {
    const snapshot = await codex.fetchUsage(
      context({
        account_id: "account-1",
        plan_type: "plus",
        rate_limit: {
          primary_window: {
            used_percent: 12,
            reset_at: 1_777_000_000,
            limit_window_seconds: 18_000,
          },
          secondary_window: {
            used_percent: 34,
            reset_at: 1_778_000_000,
            limit_window_seconds: 604_800,
          },
        },
        credits: { has_credits: true, unlimited: false, balance: "9.5" },
      }),
    );
    expect(snapshot.primary).toMatchObject({ usedPercent: 12, windowMinutes: 300 });
    expect(snapshot.secondary).toMatchObject({ usedPercent: 34, windowMinutes: 10_080 });
    expect(snapshot.identity).toMatchObject({ accountId: "account-1", loginMethod: "plus" });
  });

  it("uses a PAT whoami identity before fetching usage", async () => {
    const requests: Array<{ readonly url: string; readonly options?: Record<string, unknown> }> =
      [];
    const snapshot = await codex.fetchUsage(
      context(
        {},
        {
          settings: {
            CODEX_ACCESS_TOKEN: "oauth-token",
            CODEX_PERSONAL_ACCESS_TOKEN: "at-test-token",
            CODEX_ACCOUNT_ID: "stale-oauth-account",
            CODEX_CLI_USER_AGENT: "codex_cli_rs/1.2.3 (Linux 6.0; x86_64)",
          },
          sourceMode: "auto",
          requests,
          responses: [
            {
              json: {
                chatgpt_account_id: "acct-pat",
                chatgpt_plan_type: "team",
                email: "pat@example.com",
              },
            },
            {
              json: {
                rate_limit: {
                  primary_window: {
                    used_percent: 68,
                    reset_at: 1_777_000_000,
                    limit_window_seconds: 604_800,
                  },
                  secondary_window: null,
                },
              },
            },
          ],
        },
      ),
    );

    expect(requests.map((request) => request.url)).toEqual([
      "https://auth.openai.com/api/accounts/v1/user-auth-credential/whoami",
      "https://chatgpt.com/backend-api/wham/usage",
    ]);
    expect(requests[0]?.options).toMatchObject({
      headers: {
        Authorization: "Bearer at-test-token",
        Accept: "application/json",
        "User-Agent": "codex_cli_rs/1.2.3 (Linux 6.0; x86_64)",
        originator: "codex_cli_rs",
      },
    });
    expect(
      (requests[0]?.options?.headers as Record<string, string>)["ChatGPT-Account-Id"],
    ).toBeUndefined();
    expect(requests[1]?.options).toMatchObject({
      headers: { "ChatGPT-Account-Id": "acct-pat", Authorization: "Bearer at-test-token" },
    });
    expect(snapshot).toMatchObject({
      primary: { usedPercent: 68, windowMinutes: 10_080 },
      identity: { accountId: "acct-pat", email: "pat@example.com", loginMethod: "team" },
    });
  });

  it("falls back from an unauthorized PAT to OAuth only in Auto mode", async () => {
    const requests: Array<{ readonly url: string; readonly options?: Record<string, unknown> }> =
      [];
    const snapshot = await codex.fetchUsage(
      context(
        {},
        {
          settings: { CODEX_ACCESS_TOKEN: "oauth-token", CODEX_PERSONAL_ACCESS_TOKEN: "at-token" },
          sourceMode: "auto",
          requests,
          responses: [
            { status: 401, json: {} },
            {
              json: {
                account_id: "oauth-account",
                rate_limit: {
                  primary_window: {
                    used_percent: 25,
                    reset_at: 1_777_000_000,
                    limit_window_seconds: 18_000,
                  },
                },
              },
            },
          ],
        },
      ),
    );
    expect(requests.map((request) => request.url)).toEqual([
      "https://auth.openai.com/api/accounts/v1/user-auth-credential/whoami",
      "https://chatgpt.com/backend-api/wham/usage",
    ]);
    expect((requests[1]?.options?.headers as Record<string, string>).Authorization).toBe(
      "Bearer oauth-token",
    );
    expect(snapshot.identity).toMatchObject({ accountId: "oauth-account" });
  });

  it("treats a blank PAT as absent and retains OAuth", async () => {
    const requests: Array<{ readonly url: string; readonly options?: Record<string, unknown> }> =
      [];
    await codex.fetchUsage(
      context(
        {
          rate_limit: {
            primary_window: {
              used_percent: 12,
              reset_at: 1_777_000_000,
              limit_window_seconds: 18_000,
            },
          },
        },
        {
          settings: { CODEX_ACCESS_TOKEN: "oauth-token", CODEX_PERSONAL_ACCESS_TOKEN: "  " },
          sourceMode: "auto",
          requests,
        },
      ),
    );
    expect(requests.map((request) => request.url)).toEqual([
      "https://chatgpt.com/backend-api/wham/usage",
    ]);
  });

  it("fails closed when a PAT whoami identity field has the wrong type", async () => {
    await expect(
      codex.fetchUsage(
        context(
          {},
          {
            settings: { CODEX_PERSONAL_ACCESS_TOKEN: "at-token" },
            sourceMode: "api",
            responses: [{ json: { chatgpt_account_id: 123 } }],
          },
        ),
      ),
    ).rejects.toThrow("parse-failure: Codex PAT whoami chatgpt_account_id must be a string");
  });

  it("keeps an explicit PAT failure terminal", async () => {
    await expect(
      codex.fetchUsage(
        context(
          {},
          {
            settings: {
              CODEX_ACCESS_TOKEN: "oauth-token",
              CODEX_PERSONAL_ACCESS_TOKEN: "at-token",
            },
            sourceMode: "api",
            responses: [{ status: 401, json: {} }],
          },
        ),
      ),
    ).rejects.toThrow("authentication-expired: Codex personal access token is expired or invalid.");
  });

  it("does not substitute OAuth when explicit PAT mode has no PAT", async () => {
    await expect(
      codex.fetchUsage(
        context({}, { settings: { CODEX_ACCESS_TOKEN: "oauth-token" }, sourceMode: "api" }),
      ),
    ).rejects.toThrow("missing-credential: Missing Codex personal access token.");
  });
});
