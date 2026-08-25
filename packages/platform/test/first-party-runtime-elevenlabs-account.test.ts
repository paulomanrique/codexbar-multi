import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { InfrastructureError, type HttpRequest } from "@codexbar/core";
import { elevenlabs } from "@codexbar/providers";
import { makeFirstPartyProviderRuntime } from "../src/first-party-runtime.ts";

const clock = { now: Effect.succeed(Date.parse("2026-08-24T12:00:00Z")), sleep: () => Effect.void };

const response = (request: HttpRequest) => ({
  status: 200,
  headers: { "content-type": "application/json" },
  body: new TextEncoder().encode(
    JSON.stringify({
      tier: "creator",
      status: "active",
      character_count: 25_000,
      character_limit: 100_000,
    }),
  ),
  url: request.url,
});

const runtime = (requests: HttpRequest[], endpoint = " 'eleven.example.test/custom/v1/' ") =>
  makeFirstPartyProviderRuntime({
    providers: [elevenlabs],
    settings: {
      read: (_provider, key) => {
        if (key === "ELEVENLABS_API_KEY" || key === "XI_API_KEY") {
          return Effect.die("selected account must suppress ambient API keys");
        }
        return Effect.succeed(key === "ELEVENLABS_API_URL" ? endpoint : undefined);
      },
    },
    selectedAccounts: {
      resolve: () =>
        Effect.succeed({
          id: "elevenlabs-selected",
          secureSettings: { ELEVENLABS_API_KEY: "selected-key", XI_API_KEY: null },
        }),
    },
    browserSessions: { cookieHeader: () => Effect.succeed("") },
    credentials: {
      read: () => Effect.die("selected account must suppress keyring API keys"),
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

describe("first-party runtime selected ElevenLabs accounts", () => {
  it("preserves the quoted ambient XI_API_KEY alias", async () => {
    const requests: HttpRequest[] = [];
    const ambient = makeFirstPartyProviderRuntime({
      providers: [elevenlabs],
      settings: {
        read: (_provider, key) =>
          Effect.succeed(key === "XI_API_KEY" ? " 'ambient-alias' " : undefined),
      },
      browserSessions: { cookieHeader: () => Effect.succeed("") },
      credentials: {
        read: () => Effect.succeed(undefined),
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

    await Effect.runPromise(
      ambient.fetch("elevenlabs", { sourceMode: "auto", includeCredits: false }),
    );
    expect(requests[0]?.url).toBe("https://api.elevenlabs.io/v1/user/subscription");
    expect(requests[0]?.headers).toMatchObject({
      "xi-api-key": "ambient-alias",
      Accept: "application/json",
    });
  });

  it.each(["auto", "api"] as const)(
    "uses only the selected key and validated global endpoint under %s source",
    async (sourceMode) => {
      const requests: HttpRequest[] = [];
      const selected = runtime(requests);
      const outcome = await Effect.runPromise(
        selected.fetch("elevenlabs", { sourceMode, includeCredits: false }),
      );

      expect(outcome.strategyId).toBe("elevenlabs.api");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe("https://eleven.example.test/custom/v1/user/subscription");
      expect(requests[0]?.headers?.["xi-api-key"]).toBe("selected-key");
      expect(JSON.stringify(outcome)).not.toContain("selected-key");
    },
  );

  it.each(["web", "cli", "oauth"] as const)(
    "keeps a selected ElevenLabs account terminal under %s source",
    async (sourceMode) => {
      const requests: HttpRequest[] = [];
      await expect(
        Effect.runPromise(
          runtime(requests).fetch("elevenlabs", { sourceMode, includeCredits: false }),
        ),
      ).rejects.toMatchObject({ name: "NoAvailableStrategy", providerId: "elevenlabs" });
      expect(requests).toHaveLength(0);
    },
  );

  it.each([
    "http://attacker.test",
    "https://user:pass@eleven.test",
    "https://eleven.test%2f.attacker.test",
  ])("rejects unsafe selected-account endpoint %s before transport", async (endpoint) => {
    const requests: HttpRequest[] = [];
    await expect(
      Effect.runPromise(
        runtime(requests, endpoint).fetch("elevenlabs", {
          sourceMode: "auto",
          includeCredits: false,
        }),
      ),
    ).rejects.toMatchObject({ kind: "api-failure" });
    expect(requests).toHaveLength(0);
  });

  it("redacts a selected key from network failures", async () => {
    const selected = makeFirstPartyProviderRuntime({
      providers: [elevenlabs],
      settings: { read: () => Effect.succeed(undefined) },
      selectedAccounts: {
        resolve: () =>
          Effect.succeed({
            id: "elevenlabs-selected",
            secureSettings: { ELEVENLABS_API_KEY: "selected-key", XI_API_KEY: null },
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
      Effect.flip(selected.fetch("elevenlabs", { sourceMode: "auto", includeCredits: false })),
    );
    expect(error).toMatchObject({ kind: "network-failure" });
    expect(error.message).toContain("[REDACTED]");
    expect(error.message).not.toContain("selected-key");
  });
});
