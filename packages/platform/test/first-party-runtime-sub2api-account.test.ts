import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { InfrastructureError, type HttpRequest } from "@codexbar/core";
import { sub2api } from "@codexbar/providers";
import { makeFirstPartyProviderRuntime } from "../src/first-party-runtime.ts";

const clock = { now: Effect.succeed(Date.parse("2026-08-24T12:00:00Z")), sleep: () => Effect.void };

const response = (request: HttpRequest) => ({
  status: 200,
  headers: { "content-type": "application/json" },
  body: new TextEncoder().encode(
    JSON.stringify({
      isValid: true,
      planName: "Group",
      quota: { limit: 100, used: 25, remaining: 75, unit: "USD" },
    }),
  ),
  url: request.url,
});

const runtime = (requests: HttpRequest[], baseURL: string | undefined) =>
  makeFirstPartyProviderRuntime({
    providers: [sub2api],
    settings: {
      read: (_provider, key) => {
        if (key === "SUB2API_API_KEY") {
          return Effect.die("selected account must suppress ambient sub2api credentials");
        }
        return Effect.succeed(key === "SUB2API_BASE_URL" ? baseURL : undefined);
      },
    },
    selectedAccounts: {
      resolve: () =>
        Effect.succeed({
          id: "sub2api-selected",
          secureSettings: { SUB2API_API_KEY: "selected-key" },
        }),
    },
    browserSessions: { cookieHeader: () => Effect.succeed("") },
    credentials: {
      read: () => Effect.die("selected account must suppress keyring sub2api credentials"),
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
    timeZone: "America/Sao_Paulo",
  });

describe("first-party runtime selected sub2api accounts", () => {
  it.each(["auto", "api"] as const)(
    "uses the selected group key with the validated global base under %s source",
    async (sourceMode) => {
      const requests: HttpRequest[] = [];
      const outcome = await Effect.runPromise(
        runtime(requests, " 'sub2api.example.test/custom/v1/' ").fetch("sub2api", {
          sourceMode,
          includeCredits: false,
        }),
      );

      expect(outcome.strategyId).toBe("sub2api.api");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe(
        "https://sub2api.example.test/custom/v1/usage?days=30&timezone=America%2FSao_Paulo",
      );
      expect(requests[0]?.headers?.Authorization).toBe("Bearer selected-key");
      expect(requests[0]?.timeoutMs).toBe(15_000);
      expect(JSON.stringify(outcome)).not.toContain("selected-key");
    },
  );

  it.each(["web", "cli", "oauth"] as const)(
    "keeps a selected sub2api account terminal under %s source",
    async (sourceMode) => {
      const requests: HttpRequest[] = [];
      await expect(
        Effect.runPromise(
          runtime(requests, "https://sub2api.example.test").fetch("sub2api", {
            sourceMode,
            includeCredits: false,
          }),
        ),
      ).rejects.toMatchObject({ name: "NoAvailableStrategy", providerId: "sub2api" });
      expect(requests).toHaveLength(0);
    },
  );

  it.each([
    undefined,
    "http://public.example.test",
    "https://user:pass@sub2api.example.test",
    "https://sub2api.example.test?query=1",
    "https://sub2api.example.test#fragment",
  ])("rejects missing or unsafe global base %s before transport", async (baseURL) => {
    const requests: HttpRequest[] = [];
    await expect(
      Effect.runPromise(
        runtime(requests, baseURL).fetch("sub2api", {
          sourceMode: "auto",
          includeCredits: false,
        }),
      ),
    ).rejects.toMatchObject({ kind: "missing-credential" });
    expect(requests).toHaveLength(0);
  });

  it("redacts selected sub2api material from transport failures", async () => {
    const selected = makeFirstPartyProviderRuntime({
      providers: [sub2api],
      settings: {
        read: (_provider, key) =>
          Effect.succeed(key === "SUB2API_BASE_URL" ? "https://sub2api.example.test" : undefined),
      },
      selectedAccounts: {
        resolve: () =>
          Effect.succeed({
            id: "sub2api-selected",
            secureSettings: { SUB2API_API_KEY: "selected-key" },
          }),
      },
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
      Effect.flip(selected.fetch("sub2api", { sourceMode: "auto", includeCredits: false })),
    );
    expect(error).toMatchObject({ kind: "network-failure" });
    expect(error.message).toContain("[REDACTED]");
    expect(error.message).not.toContain("selected-key");
  });
});
