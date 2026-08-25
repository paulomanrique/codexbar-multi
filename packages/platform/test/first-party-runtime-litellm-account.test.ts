import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { InfrastructureError, type HttpRequest } from "@codexbar/core";
import { litellm } from "@codexbar/providers";
import { makeFirstPartyProviderRuntime } from "../src/first-party-runtime.ts";

const clock = { now: Effect.succeed(Date.parse("2026-08-25T12:00:00Z")), sleep: () => Effect.void };

const selectedAccount = {
  id: "litellm-selected",
  secureSettings: { LITELLM_API_KEY: "selected-key" },
} as const;

const response = (request: HttpRequest) => {
  const url = new URL(request.url);
  const body =
    url.pathname === "/gateway/key/info"
      ? { info: { user_id: "user-123", team_id: "team-456" } }
      : {
          user_id: "user-123",
          user_info: {
            user_id: "user-123",
            user_email: "selected@example.test",
            spend: 25,
            max_budget: 100,
          },
          teams: [
            {
              team_id: "team-456",
              team_alias: "Selected team",
              spend: 40,
              max_budget: 200,
            },
          ],
        };
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: new TextEncoder().encode(JSON.stringify(body)),
    url: request.url,
  };
};

const runtime = (requests: HttpRequest[], baseURL: string | undefined) =>
  makeFirstPartyProviderRuntime({
    providers: [litellm],
    settings: {
      read: (_provider, key) => {
        if (key === "LITELLM_API_KEY") {
          return Effect.die("selected account must suppress ambient LiteLLM credentials");
        }
        return Effect.succeed(key === "LITELLM_BASE_URL" ? baseURL : undefined);
      },
    },
    selectedAccounts: { resolve: () => Effect.succeed(selectedAccount) },
    browserSessions: { cookieHeader: () => Effect.succeed("") },
    credentials: {
      read: () => Effect.die("selected account must suppress keyring LiteLLM credentials"),
      write: () => Effect.void,
      remove: () => Effect.void,
    },
    http: {
      execute: (request) => {
        requests.push(request);
        return Effect.succeed(response(request));
      },
    },
    clock,
  });

describe("first-party runtime selected LiteLLM accounts", () => {
  it.each(["auto", "api"] as const)(
    "uses the selected key with the validated global base under %s source",
    async (sourceMode) => {
      const requests: HttpRequest[] = [];
      const outcome = await Effect.runPromise(
        runtime(requests, " 'litellm.example.test/gateway/v1/' ").fetch("litellm", {
          sourceMode,
          includeCredits: false,
        }),
      );
      expect(outcome.strategyId).toBe("litellm.api");
      expect(outcome.snapshot).toMatchObject({
        primary: { usedPercent: 25 },
        secondary: { usedPercent: 20 },
        identity: {
          accountEmail: "selected@example.test",
          accountOrganization: "Selected team",
          loginMethod: "api",
          providerId: "litellm",
        },
      });
      expect(requests.map(({ url }) => url)).toEqual([
        "https://litellm.example.test/gateway/key/info",
        "https://litellm.example.test/gateway/user/info?user_id=user-123",
      ]);
      expect(
        requests.every(({ headers }) => headers?.Authorization === "Bearer selected-key"),
      ).toBe(true);
      expect(JSON.stringify(outcome)).not.toContain("selected-key");
    },
  );

  it.each(["web", "cli", "oauth"] as const)(
    "keeps a selected LiteLLM account terminal under %s source",
    async (sourceMode) => {
      const requests: HttpRequest[] = [];
      await expect(
        Effect.runPromise(
          runtime(requests, "https://litellm.example.test").fetch("litellm", {
            sourceMode,
            includeCredits: false,
          }),
        ),
      ).rejects.toMatchObject({ name: "NoAvailableStrategy", providerId: "litellm" });
      expect(requests).toHaveLength(0);
    },
  );

  it.each([
    undefined,
    "http://public.example.test",
    "https://user:pass@litellm.example.test",
    "https://litellm.example.test%2f@evil.test",
  ])("rejects missing or unsafe global base %s before transport", async (baseURL) => {
    const requests: HttpRequest[] = [];
    await expect(
      Effect.runPromise(
        runtime(requests, baseURL).fetch("litellm", {
          sourceMode: "auto",
          includeCredits: false,
        }),
      ),
    ).rejects.toMatchObject({
      kind: baseURL === undefined ? "missing-credential" : "api-failure",
    });
    expect(requests).toHaveLength(0);
  });

  it("redacts selected LiteLLM material from transport failures", async () => {
    const selected = makeFirstPartyProviderRuntime({
      providers: [litellm],
      settings: {
        read: (_provider, key) =>
          Effect.succeed(key === "LITELLM_BASE_URL" ? "https://litellm.example.test" : undefined),
      },
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
      Effect.flip(selected.fetch("litellm", { sourceMode: "auto", includeCredits: false })),
    );
    expect(error).toMatchObject({ kind: "network-failure" });
    expect(error.message).toContain("[REDACTED]");
    expect(error.message).not.toContain("selected-key");
  });

  it("redacts a selected key echoed by an HTTP error body", async () => {
    const selected = makeFirstPartyProviderRuntime({
      providers: [litellm],
      settings: {
        read: (_provider, key) =>
          Effect.succeed(key === "LITELLM_BASE_URL" ? "https://litellm.example.test" : undefined),
      },
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
      Effect.flip(selected.fetch("litellm", { sourceMode: "auto", includeCredits: false })),
    );
    expect(error).toMatchObject({ kind: "api-failure" });
    expect(error.message).toContain("[REDACTED]");
    expect(error.message).not.toContain("selected-key");
  });
});
