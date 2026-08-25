import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { InfrastructureError, type HttpRequest } from "@codexbar/core";
import { deepseek } from "@codexbar/providers";
import { makeFirstPartyProviderRuntime } from "../src/first-party-runtime.ts";

const clock = { now: Effect.succeed(Date.parse("2026-08-25T12:00:00Z")), sleep: () => Effect.void };

const balanceResponse = (request: HttpRequest) => ({
  status: 200,
  headers: { "content-type": "application/json" },
  body: new TextEncoder().encode(
    JSON.stringify({
      is_available: true,
      balance_infos: [
        {
          currency: "USD",
          total_balance: "12.50",
          granted_balance: "2.50",
          topped_up_balance: "10.00",
        },
      ],
    }),
  ),
  url: request.url,
});

const selectedAccount = {
  id: "deepseek-selected",
  secureSettings: {
    DEEPSEEK_API_KEY: "selected-key",
    DEEPSEEK_KEY: null,
    DEEPSEEK_PLATFORM_TOKEN: null,
    DEEPSEEK_USER_TOKEN: null,
  },
  plainSettings: {
    CODEXBAR_DEEPSEEK_PROFILE_ID: null,
    CODEXBAR_DEEPSEEK_PROFILE_SCOPE: null,
  },
} as const;

const runtime = (requests: HttpRequest[]) =>
  makeFirstPartyProviderRuntime({
    providers: [deepseek],
    settings: {
      read: () => Effect.die("selected account must suppress all ambient DeepSeek context"),
    },
    selectedAccounts: { resolve: () => Effect.succeed(selectedAccount) },
    browserSessions: { cookieHeader: () => Effect.succeed("") },
    credentials: {
      read: () => Effect.die("selected account must suppress keyring DeepSeek credentials"),
      write: () => Effect.void,
      remove: () => Effect.void,
    },
    http: {
      execute: (request) => {
        requests.push(request);
        return Effect.succeed(balanceResponse(request));
      },
    },
    clock,
  });

describe("first-party runtime selected DeepSeek accounts", () => {
  it.each(["auto", "api"] as const)(
    "uses only the selected API key under %s source",
    async (sourceMode) => {
      const requests: HttpRequest[] = [];
      const outcome = await Effect.runPromise(
        runtime(requests).fetch("deepseek", { sourceMode, includeCredits: false }),
      );
      expect(outcome.strategyId).toBe("deepseek.api");
      expect(outcome.snapshot.primary).toEqual({
        usedPercent: 0,
        resetDescription: "$12.50 (Paid: $10.00 / Granted: $2.50)",
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe("https://api.deepseek.com/user/balance");
      expect(requests[0]?.headers).toMatchObject({
        Authorization: "Bearer selected-key",
        Accept: "application/json",
      });
      expect(JSON.stringify(outcome)).not.toContain("selected-key");
    },
  );

  it.each(["web", "cli", "oauth"] as const)(
    "keeps a selected DeepSeek API account terminal under %s source",
    async (sourceMode) => {
      const requests: HttpRequest[] = [];
      await expect(
        Effect.runPromise(
          runtime(requests).fetch("deepseek", { sourceMode, includeCredits: false }),
        ),
      ).rejects.toMatchObject({ name: "NoAvailableStrategy", providerId: "deepseek" });
      expect(requests).toHaveLength(0);
    },
  );

  it("redacts selected DeepSeek material from transport failures", async () => {
    const selected = makeFirstPartyProviderRuntime({
      providers: [deepseek],
      settings: { read: () => Effect.succeed(undefined) },
      selectedAccounts: { resolve: () => Effect.succeed(selectedAccount) },
      browserSessions: { cookieHeader: () => Effect.succeed("") },
      credentials: {
        read: () => Effect.succeed(undefined),
        write: () => Effect.void,
        remove: () => Effect.void,
      },
      http: {
        execute: () =>
          Effect.fail(new InfrastructureError("test transport", "selected-key rejected")),
      },
      clock,
    });
    const error = await Effect.runPromise(
      Effect.flip(selected.fetch("deepseek", { sourceMode: "auto", includeCredits: false })),
    );
    expect(error).toMatchObject({ kind: "network-failure" });
    expect(error.message).toContain("[REDACTED]");
    expect(error.message).not.toContain("selected-key");
  });

  it("does not expose a selected key echoed by an HTTP error body", async () => {
    const selected = makeFirstPartyProviderRuntime({
      providers: [deepseek],
      settings: { read: () => Effect.succeed(undefined) },
      selectedAccounts: { resolve: () => Effect.succeed(selectedAccount) },
      browserSessions: { cookieHeader: () => Effect.succeed("") },
      credentials: {
        read: () => Effect.succeed(undefined),
        write: () => Effect.void,
        remove: () => Effect.void,
      },
      http: {
        execute: (request) =>
          Effect.succeed({
            status: 401,
            headers: {},
            body: new TextEncoder().encode("Bearer selected-key rejected"),
            url: request.url,
          }),
      },
      clock,
    });
    const error = await Effect.runPromise(
      Effect.flip(selected.fetch("deepseek", { sourceMode: "auto", includeCredits: false })),
    );
    expect(error).toMatchObject({ kind: "api-failure" });
    expect(error.message).not.toContain("selected-key");
  });
});
