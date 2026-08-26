import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import {
  InfrastructureError,
  MissingBrowserCredentialError,
  type HttpRequest,
  type HttpResponse,
  type PersistedCodexBarConfig,
} from "@codexbar/core";
import { codex } from "@codexbar/providers";
import { makeFirstPartyProviderRuntime } from "../src/first-party-runtime.ts";
import {
  resolveSelectedFirstPartyAccountFromVault,
  tokenAccountVaultKey,
} from "../src/token-account-vault-config.ts";

const clock = { now: Effect.succeed(Date.parse("2026-08-25T12:00:00Z")), sleep: () => Effect.void };

const response = (request: HttpRequest, body: unknown, status = 200): HttpResponse => ({
  status,
  headers: { "content-type": "application/json" },
  body: new TextEncoder().encode(JSON.stringify(body)),
  url: request.url,
});

const usagePayload = {
  account_id: "acct-selected",
  plan_type: "pro",
  rate_limit: {
    primary_window: {
      used_percent: 12,
      reset_at: 1_777_000_000,
      limit_window_seconds: 18_000,
    },
  },
};

const jwt = (payload: Record<string, unknown>): string =>
  `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;

const runtime = (
  requests: HttpRequest[],
  selectedAccount: {
    readonly secureSettings: Readonly<Record<string, string | null>>;
    readonly plainSettings: Readonly<Record<string, string | null>>;
  },
  execute: (request: HttpRequest) => Effect.Effect<HttpResponse, InfrastructureError> = (request) =>
    Effect.succeed(response(request, usagePayload)),
) =>
  makeFirstPartyProviderRuntime({
    providers: [codex],
    settings: {
      read: (_provider, key) =>
        key === "CODEX_CLI_USER_AGENT"
          ? Effect.succeed("codex_cli_rs/1.2.3 (Linux 6.0; x86_64)")
          : Effect.die(`selected Codex account must suppress ambient setting ${key}`),
    },
    selectedAccounts: {
      resolve: () => Effect.succeed({ id: "codex-selected", ...selectedAccount }),
    },
    browserSessions: { cookieHeader: () => Effect.die("selected Codex account must not use web") },
    credentials: {
      read: () => Effect.die("selected Codex account must suppress keyring credentials"),
      write: () => Effect.void,
      remove: () => Effect.void,
    },
    http: {
      execute: (request) => {
        requests.push(request);
        return execute(request);
      },
    },
    clock,
  });

describe("first-party runtime selected Codex accounts", () => {
  it("derives the selected account header through the production vault resolver", async () => {
    const requests: HttpRequest[] = [];
    const credentialReads: string[] = [];
    const account = { id: "codex-selected", label: "Selected", addedAt: 0 };
    const key = tokenAccountVaultKey("codex", account.id);
    const config: PersistedCodexBarConfig = {
      version: 1,
      providers: [
        {
          id: "codex",
          extensions: {},
          tokenAccounts: { version: 2, activeIndex: 0, accounts: [account] },
        },
      ],
    };
    const credentials = {
      read: (requestedKey: string) => {
        credentialReads.push(requestedKey);
        return requestedKey === key
          ? Effect.succeed(
              JSON.stringify({
                tokens: {
                  access_token: "selected-oauth",
                  refresh_token: "must-not-escape",
                  id_token: jwt({
                    "https://api.openai.com/auth": { chatgpt_account_id: "acct-from-jwt" },
                  }),
                },
              }),
            )
          : Effect.die(`selected Codex account must suppress keyring read ${requestedKey}`);
      },
      write: () => Effect.void,
      remove: () => Effect.void,
    };
    const selected = makeFirstPartyProviderRuntime({
      providers: [codex],
      settings: {
        read: (_provider, setting) =>
          setting === "CODEX_CLI_USER_AGENT"
            ? Effect.succeed("codex_cli_rs/1.2.3 (Windows 11; x86_64)")
            : Effect.die(`selected Codex account must suppress ambient setting ${setting}`),
      },
      selectedAccounts: {
        resolve: () => resolveSelectedFirstPartyAccountFromVault(config, credentials, "codex"),
      },
      browserSessions: { cookieHeader: () => Effect.die("must not use web") },
      credentials,
      http: {
        execute: (request) => {
          requests.push(request);
          return Effect.succeed(
            response(request, { ...usagePayload, account_id: "acct-from-jwt" }),
          );
        },
      },
      clock,
    });

    const outcome = await Effect.runPromise(
      selected.fetch("codex", { sourceMode: "auto", includeCredits: false }),
    );
    expect(requests[0]?.headers).toMatchObject({
      Authorization: "Bearer selected-oauth",
      "ChatGPT-Account-Id": "acct-from-jwt",
    });
    expect(credentialReads).toEqual([key]);
    expect(JSON.stringify(outcome)).not.toContain("selected-oauth");
    expect(JSON.stringify(outcome)).not.toContain("must-not-escape");
  });

  it("switches selected vault accounts without reusing ambient or stale credentials", async () => {
    const requests: HttpRequest[] = [];
    const credentialReads: string[] = [];
    const accounts = [
      { id: "codex-a", label: "Account A", addedAt: 0 },
      { id: "codex-b", label: "Account B", addedAt: 1 },
    ];
    const credentialsByKey = new Map([
      [
        tokenAccountVaultKey("codex", "codex-a"),
        JSON.stringify({
          tokens: {
            access_token: "oauth-a",
            refresh_token: "refresh-a-must-not-escape",
            account_id: "acct-a",
          },
        }),
      ],
      [
        tokenAccountVaultKey("codex", "codex-b"),
        JSON.stringify({
          tokens: {
            access_token: "oauth-b",
            refresh_token: "refresh-b-must-not-escape",
            account_id: "acct-b",
          },
        }),
      ],
    ]);
    let activeIndex = 0;
    const currentConfig = (): PersistedCodexBarConfig => ({
      version: 1,
      providers: [
        {
          id: "codex",
          extensions: {},
          tokenAccounts: { version: 2, activeIndex, accounts },
        },
      ],
    });
    const credentials = {
      read: (key: string) => {
        credentialReads.push(key);
        const value = credentialsByKey.get(key);
        return value === undefined
          ? Effect.die(`selected Codex account requested unexpected vault key ${key}`)
          : Effect.succeed(value);
      },
      write: () => Effect.void,
      remove: () => Effect.void,
    };
    const selected = makeFirstPartyProviderRuntime({
      providers: [codex],
      settings: {
        read: (_provider, setting) =>
          setting === "CODEX_CLI_USER_AGENT"
            ? Effect.succeed("codex_cli_rs/1.2.3 (Windows 11; x86_64)")
            : Effect.die(`selected Codex account must suppress ambient setting ${setting}`),
      },
      selectedAccounts: {
        resolve: () =>
          resolveSelectedFirstPartyAccountFromVault(currentConfig(), credentials, "codex"),
      },
      browserSessions: { cookieHeader: () => Effect.die("selected account must not use web") },
      credentials,
      http: {
        execute: (request) => {
          requests.push(request);
          return Effect.succeed(
            response(request, {
              ...usagePayload,
              account_id: request.headers?.["ChatGPT-Account-Id"],
            }),
          );
        },
      },
      clock,
    });

    const first = await Effect.runPromise(
      selected.fetch("codex", { sourceMode: "auto", includeCredits: false }),
    );
    activeIndex = 1;
    const second = await Effect.runPromise(
      selected.fetch("codex", { sourceMode: "auto", includeCredits: false }),
    );

    expect(requests.map(({ headers }) => headers?.Authorization)).toEqual([
      "Bearer oauth-a",
      "Bearer oauth-b",
    ]);
    expect(requests.map(({ headers }) => headers?.["ChatGPT-Account-Id"])).toEqual([
      "acct-a",
      "acct-b",
    ]);
    expect(credentialReads).toEqual([
      tokenAccountVaultKey("codex", "codex-a"),
      tokenAccountVaultKey("codex", "codex-b"),
    ]);
    expect([first.snapshot.identity?.accountId, second.snapshot.identity?.accountId]).toEqual([
      "acct-a",
      "acct-b",
    ]);
    expect(JSON.stringify([first, second])).not.toMatch(/oauth-|refresh-/u);
  });

  it("uses only the selected OAuth credential and account header", async () => {
    const requests: HttpRequest[] = [];
    const outcome = await Effect.runPromise(
      runtime(requests, {
        secureSettings: {
          CODEX_ACCESS_TOKEN: "selected-oauth",
          CODEX_PERSONAL_ACCESS_TOKEN: null,
        },
        plainSettings: { CODEX_ACCOUNT_ID: "acct-selected" },
      }).fetch("codex", { sourceMode: "auto", includeCredits: false }),
    );
    expect(outcome.strategyId).toBe("codex");
    expect(outcome.snapshot.identity).toMatchObject({
      providerId: "codex",
      accountId: "acct-selected",
      loginMethod: "pro",
    });
    expect(requests.map(({ url }) => url)).toEqual(["https://chatgpt.com/backend-api/wham/usage"]);
    expect(requests[0]?.headers).toMatchObject({
      Authorization: "Bearer selected-oauth",
      "ChatGPT-Account-Id": "acct-selected",
    });
    expect(JSON.stringify(outcome)).not.toContain("selected-oauth");
  });

  it("uses selected PAT whoami before usage without borrowing OAuth", async () => {
    const requests: HttpRequest[] = [];
    await expect(
      Effect.runPromise(
        runtime(
          requests,
          {
            secureSettings: {
              CODEX_ACCESS_TOKEN: null,
              CODEX_PERSONAL_ACCESS_TOKEN: "at-selected",
            },
            plainSettings: { CODEX_ACCOUNT_ID: null },
          },
          (request) =>
            Effect.succeed(
              response(
                request,
                request.url.endsWith("/whoami")
                  ? {
                      chatgpt_account_id: "acct-pat",
                      chatgpt_plan_type: "team",
                      email: "selected@example.test",
                    }
                  : usagePayload,
              ),
            ),
        ).fetch("codex", { sourceMode: "auto", includeCredits: false }),
      ),
    ).resolves.toMatchObject({
      snapshot: { identity: { accountId: "acct-pat", accountEmail: "selected@example.test" } },
    });
    expect(requests.map(({ url }) => url)).toEqual([
      "https://auth.openai.com/api/accounts/v1/user-auth-credential/whoami",
      "https://chatgpt.com/backend-api/wham/usage",
    ]);
    expect(requests.every(({ headers }) => headers?.Authorization === "Bearer at-selected")).toBe(
      true,
    );
    expect(requests[1]?.headers?.["ChatGPT-Account-Id"]).toBe("acct-pat");
  });

  it("fails closed when the selected account has no usable Codex credential", async () => {
    const requests: HttpRequest[] = [];
    await expect(
      Effect.runPromise(
        runtime(requests, {
          secureSettings: {
            CODEX_ACCESS_TOKEN: null,
            CODEX_PERSONAL_ACCESS_TOKEN: null,
          },
          plainSettings: { CODEX_ACCOUNT_ID: "acct-selected" },
        }).fetch("codex", { sourceMode: "auto", includeCredits: false }),
      ),
    ).rejects.toMatchObject({ name: "NoAvailableStrategy", providerId: "codex" });
    expect(requests).toEqual([]);
  });

  it.each(["cli"] as const)(
    "does not route selected Codex account material through %s source mode",
    async (sourceMode) => {
      const requests: HttpRequest[] = [];
      await expect(
        Effect.runPromise(
          runtime(requests, {
            secureSettings: {
              CODEX_ACCESS_TOKEN: "selected-oauth",
              CODEX_PERSONAL_ACCESS_TOKEN: null,
            },
            plainSettings: { CODEX_ACCOUNT_ID: "acct-selected" },
          }).fetch("codex", { sourceMode, includeCredits: false }),
        ),
      ).rejects.toMatchObject({ name: "NoAvailableStrategy", providerId: "codex" });
      expect(requests).toEqual([]);
    },
  );

  it("routes explicit web through only the selected account browser session", async () => {
    const requests: HttpRequest[] = [];
    const browserCalls: Array<{
      readonly provider: string;
      readonly domain: string;
      readonly selectedAccountId?: string;
    }> = [];
    const selected = makeFirstPartyProviderRuntime({
      providers: [codex],
      settings: {
        read: (_provider, setting) =>
          setting === "CODEX_CLI_USER_AGENT"
            ? Effect.succeed("codex_cli_rs/1.2.3 (Windows 11; x86_64)")
            : Effect.die(`selected Codex web account must suppress ambient setting ${setting}`),
      },
      selectedAccounts: {
        resolve: () =>
          Effect.succeed({
            id: "codex-web-selected",
            accountEmail: "owner@example.com",
            secureSettings: {
              CODEX_ACCESS_TOKEN: null,
              CODEX_PERSONAL_ACCESS_TOKEN: null,
            },
            plainSettings: { CODEX_ACCOUNT_ID: "acct-owner" },
          }),
      },
      browserSessions: {
        cookieHeader: (provider, domain, selectedAccountId) => {
          browserCalls.push({
            provider,
            domain,
            ...(selectedAccountId === undefined ? {} : { selectedAccountId }),
          });
          return Effect.succeed("__Secure-session=selected-cookie");
        },
      },
      credentials: {
        read: () => Effect.die("selected Codex web account must not read the ambient keyring"),
        write: () => Effect.void,
        remove: () => Effect.void,
      },
      http: {
        execute: (request) => {
          requests.push(request);
          return Effect.succeed(
            response(
              request,
              request.url.endsWith("/backend-api/me")
                ? { user: { email: "owner@example.com" } }
                : { ...usagePayload, account_id: "acct-owner" },
            ),
          );
        },
      },
      clock,
    });

    const outcome = await Effect.runPromise(
      selected.fetch("codex", { sourceMode: "web", includeCredits: false }),
    );
    expect(outcome.strategyId).toBe("codex.web.dashboard");
    expect(browserCalls).toEqual([
      {
        provider: "codex",
        domain: "chatgpt.com",
        selectedAccountId: "codex-web-selected",
      },
    ]);
    expect(requests.map(({ url }) => url)).toEqual([
      "https://chatgpt.com/backend-api/me",
      "https://chatgpt.com/backend-api/wham/usage",
    ]);
    expect(
      requests.every(({ headers }) => headers?.Cookie === "__Secure-session=selected-cookie"),
    ).toBe(true);
    expect(requests.every(({ headers }) => headers?.Authorization === undefined)).toBe(true);
    expect(outcome.snapshot.identity).toMatchObject({
      accountId: "acct-owner",
      accountEmail: "owner@example.com",
    });
    expect(JSON.stringify(outcome)).not.toContain("selected-cookie");
  });

  it("keeps Codex web fenced while selected-account browser cleanup is pending", async () => {
    let browserCalls = 0;
    let httpCalls = 0;
    const selected = makeFirstPartyProviderRuntime({
      providers: [codex],
      settings: {
        read: (_provider, setting) =>
          setting === "CODEX_CLI_USER_AGENT"
            ? Effect.succeed("codex_cli_rs/1.2.3 (Windows 11; x86_64)")
            : Effect.die(`cleanup-fenced Codex account must suppress ${setting}`),
      },
      selectedAccounts: {
        resolve: () =>
          Effect.succeed({
            id: "codex-web-selected",
            accountEmail: "owner@example.com",
            browserSessionCleanupPending: true,
            secureSettings: {
              CODEX_ACCESS_TOKEN: null,
              CODEX_PERSONAL_ACCESS_TOKEN: null,
            },
            plainSettings: { CODEX_ACCOUNT_ID: "acct-owner" },
          }),
      },
      browserSessions: {
        cookieHeader: () => {
          browserCalls += 1;
          return Effect.succeed("__Secure-session=must-not-be-read");
        },
      },
      credentials: {
        read: () => Effect.die("cleanup-fenced Codex account must not read ambient credentials"),
        write: () => Effect.void,
        remove: () => Effect.void,
      },
      http: {
        execute: (request) => {
          httpCalls += 1;
          return Effect.succeed(response(request, usagePayload));
        },
      },
      clock,
    });

    await expect(
      Effect.runPromise(selected.fetch("codex", { sourceMode: "web", includeCredits: false })),
    ).rejects.toMatchObject({ name: "NoAvailableStrategy", providerId: "codex" });
    expect(browserCalls).toBe(0);
    expect(httpCalls).toBe(0);
  });

  it("keeps Codex web unavailable without scoped ownership and maps a missing selected session", async () => {
    let browserCalls = 0;
    let httpCalls = 0;
    const unselected = makeFirstPartyProviderRuntime({
      providers: [codex],
      settings: {
        read: () => {
          throw new Error("unselected Codex web must not read ambient settings");
        },
      },
      selectedAccounts: { resolve: () => Effect.succeed(undefined) },
      browserSessions: {
        cookieHeader: () => {
          browserCalls += 1;
          return Effect.succeed("default-session=must-not-be-read");
        },
      },
      credentials: {
        read: () => Effect.die("unselected Codex web must not read the keyring"),
        write: () => Effect.void,
        remove: () => Effect.void,
      },
      http: {
        execute: () => {
          httpCalls += 1;
          return Effect.die("unselected Codex web must not use HTTP");
        },
      },
      clock,
    });
    await expect(
      Effect.runPromise(unselected.fetch("codex", { sourceMode: "web", includeCredits: false })),
    ).rejects.toMatchObject({ name: "NoAvailableStrategy", providerId: "codex" });
    expect(browserCalls).toBe(0);
    expect(httpCalls).toBe(0);

    const makeRuntime = (accountEmail: string | undefined) =>
      makeFirstPartyProviderRuntime({
        providers: [codex],
        settings: {
          read: (_provider, setting) =>
            setting === "CODEX_CLI_USER_AGENT"
              ? Effect.succeed(undefined)
              : Effect.die(`ambient setting must not be read: ${setting}`),
        },
        selectedAccounts: {
          resolve: () =>
            Effect.succeed({
              id: "codex-web-selected",
              ...(accountEmail === undefined ? {} : { accountEmail }),
              secureSettings: {
                CODEX_ACCESS_TOKEN: null,
                CODEX_PERSONAL_ACCESS_TOKEN: null,
              },
              plainSettings: { CODEX_ACCOUNT_ID: "acct-owner" },
            }),
        },
        browserSessions: {
          cookieHeader: () => {
            browserCalls += 1;
            return Effect.fail(new MissingBrowserCredentialError());
          },
        },
        credentials: {
          read: () => Effect.die("ambient keyring must not be read"),
          write: () => Effect.void,
          remove: () => Effect.void,
        },
        http: {
          execute: () => {
            httpCalls += 1;
            return Effect.die("HTTP must not be reached");
          },
        },
        clock,
      });

    await expect(
      Effect.runPromise(
        makeRuntime(undefined).fetch("codex", { sourceMode: "web", includeCredits: false }),
      ),
    ).rejects.toMatchObject({ name: "NoAvailableStrategy", providerId: "codex" });
    expect(browserCalls).toBe(0);
    expect(httpCalls).toBe(0);

    await expect(
      Effect.runPromise(
        makeRuntime("owner@example.com").fetch("codex", {
          sourceMode: "web",
          includeCredits: false,
        }),
      ),
    ).rejects.toMatchObject({ kind: "missing-credential" });
    expect(browserCalls).toBe(1);
    expect(httpCalls).toBe(0);
  });

  it("falls back from a production-classified PAT 401 to selected OAuth", async () => {
    const requests: HttpRequest[] = [];
    const outcome = await Effect.runPromise(
      runtime(
        requests,
        {
          secureSettings: {
            CODEX_ACCESS_TOKEN: "selected-oauth",
            CODEX_PERSONAL_ACCESS_TOKEN: "at-selected",
          },
          plainSettings: { CODEX_ACCOUNT_ID: "acct-oauth" },
        },
        (request) =>
          Effect.succeed(
            request.url.endsWith("/whoami")
              ? {
                  status: 401,
                  headers: { "content-type": "text/html" },
                  body: new TextEncoder().encode("<html>login</html>"),
                  url: request.url,
                }
              : response(request, { ...usagePayload, account_id: "acct-oauth" }),
          ),
      ).fetch("codex", { sourceMode: "auto", includeCredits: false }),
    );
    expect(requests.map(({ url }) => url)).toEqual([
      "https://auth.openai.com/api/accounts/v1/user-auth-credential/whoami",
      "https://chatgpt.com/backend-api/wham/usage",
    ]);
    expect(requests[1]?.headers?.Authorization).toBe("Bearer selected-oauth");
    expect(outcome.snapshot.identity?.accountId).toBe("acct-oauth");
  });

  it("redacts selected Codex credentials from transport failures", async () => {
    const selected = runtime(
      [],
      {
        secureSettings: {
          CODEX_ACCESS_TOKEN: "selected-oauth",
          CODEX_PERSONAL_ACCESS_TOKEN: null,
        },
        plainSettings: { CODEX_ACCOUNT_ID: "acct-selected" },
      },
      () => Effect.fail(new InfrastructureError("test transport", "selected-oauth rejected")),
    );
    const error = await Effect.runPromise(
      Effect.flip(selected.fetch("codex", { sourceMode: "auto", includeCredits: false })),
    );
    expect(error.message).not.toContain("selected-oauth");
    expect(error.message).toContain("[REDACTED]");
  });
});
