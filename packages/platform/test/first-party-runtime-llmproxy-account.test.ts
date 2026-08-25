import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { InfrastructureError, type HttpRequest } from "@codexbar/core";
import { llmproxy } from "@codexbar/providers";
import { makeFirstPartyProviderRuntime } from "../src/first-party-runtime.ts";

const clock = { now: Effect.succeed(Date.parse("2026-08-24T12:00:00Z")), sleep: () => Effect.void };

const response = (request: HttpRequest) => ({
  status: 200,
  headers: { "content-type": "application/json" },
  body: new TextEncoder().encode(JSON.stringify({ providers: {} })),
  url: request.url,
});

const runtime = (requests: HttpRequest[], baseURL: string | undefined) =>
  makeFirstPartyProviderRuntime({
    providers: [llmproxy],
    settings: {
      read: (_provider, key) => {
        if (key === "LLM_PROXY_API_KEY") {
          return Effect.die("selected account must suppress ambient LLM Proxy credentials");
        }
        return Effect.succeed(key === "LLM_PROXY_BASE_URL" ? baseURL : undefined);
      },
    },
    selectedAccounts: {
      resolve: () =>
        Effect.succeed({
          id: "llmproxy-selected",
          secureSettings: { LLM_PROXY_API_KEY: "selected-key" },
        }),
    },
    browserSessions: { cookieHeader: () => Effect.succeed("") },
    credentials: {
      read: () => Effect.die("selected account must suppress keyring LLM Proxy credentials"),
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

describe("first-party runtime selected LLM Proxy accounts", () => {
  it.each(["auto", "api"] as const)(
    "uses the selected key with the validated global base under %s source",
    async (sourceMode) => {
      const requests: HttpRequest[] = [];
      const outcome = await Effect.runPromise(
        runtime(requests, " 'proxy.example.test/custom/v1/' ").fetch("llmproxy", {
          sourceMode,
          includeCredits: false,
        }),
      );
      expect(outcome.strategyId).toBe("llmproxy.api");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe("https://proxy.example.test/custom/v1/quota-stats");
      expect(requests[0]?.headers?.Authorization).toBe("Bearer selected-key");
      expect(JSON.stringify(outcome)).not.toContain("selected-key");
    },
  );

  it.each(["web", "cli", "oauth"] as const)(
    "keeps a selected LLM Proxy account terminal under %s source",
    async (sourceMode) => {
      const requests: HttpRequest[] = [];
      await expect(
        Effect.runPromise(
          runtime(requests, "https://proxy.example.test").fetch("llmproxy", {
            sourceMode,
            includeCredits: false,
          }),
        ),
      ).rejects.toMatchObject({ name: "NoAvailableStrategy", providerId: "llmproxy" });
      expect(requests).toHaveLength(0);
    },
  );

  it.each([undefined, "http://public.example.test", "https://user:pass@proxy.example.test"])(
    "rejects missing or unsafe global base %s before transport",
    async (baseURL) => {
      const requests: HttpRequest[] = [];
      await expect(
        Effect.runPromise(
          runtime(requests, baseURL).fetch("llmproxy", {
            sourceMode: "auto",
            includeCredits: false,
          }),
        ),
      ).rejects.toMatchObject({
        kind: baseURL === undefined ? "missing-credential" : "api-failure",
      });
      expect(requests).toHaveLength(0);
    },
  );

  it("redacts selected LLM Proxy material from transport failures", async () => {
    const selected = makeFirstPartyProviderRuntime({
      providers: [llmproxy],
      settings: {
        read: (_provider, key) =>
          Effect.succeed(key === "LLM_PROXY_BASE_URL" ? "https://proxy.example.test" : undefined),
      },
      selectedAccounts: {
        resolve: () =>
          Effect.succeed({
            id: "llmproxy-selected",
            secureSettings: { LLM_PROXY_API_KEY: "selected-key" },
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
      Effect.flip(selected.fetch("llmproxy", { sourceMode: "auto", includeCredits: false })),
    );
    expect(error).toMatchObject({ kind: "network-failure" });
    expect(error.message).toContain("[REDACTED]");
    expect(error.message).not.toContain("selected-key");
  });

  it("redacts a selected key echoed by an HTTP error body", async () => {
    const selected = makeFirstPartyProviderRuntime({
      providers: [llmproxy],
      settings: {
        read: (_provider, key) =>
          Effect.succeed(key === "LLM_PROXY_BASE_URL" ? "https://proxy.example.test" : undefined),
      },
      selectedAccounts: {
        resolve: () =>
          Effect.succeed({
            id: "llmproxy-selected",
            secureSettings: { LLM_PROXY_API_KEY: "selected-key" },
          }),
      },
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
      Effect.flip(selected.fetch("llmproxy", { sourceMode: "auto", includeCredits: false })),
    );
    expect(error).toMatchObject({ kind: "api-failure" });
    expect(error.message).toContain("[REDACTED]");
    expect(error.message).not.toContain("selected-key");
  });
});
