import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { InfrastructureError, type HttpRequest, type HttpResponse } from "@codexbar/core";
import { codex } from "@codexbar/providers";
import { makeFirstPartyProviderRuntime } from "../src/first-party-runtime.ts";

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

  it.each(["web", "cli"] as const)(
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
