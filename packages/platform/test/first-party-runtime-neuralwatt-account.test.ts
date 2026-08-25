import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { InfrastructureError, type HttpRequest } from "@codexbar/core";
import { neuralwatt } from "@codexbar/providers";
import { makeFirstPartyProviderRuntime } from "../src/first-party-runtime.ts";

const clock = { now: Effect.succeed(Date.parse("2026-08-24T12:00:00Z")), sleep: () => Effect.void };

const response = (request: HttpRequest) => ({
  status: 200,
  headers: { "content-type": "application/json" },
  body: new TextEncoder().encode(
    JSON.stringify({
      balance: {
        credits_remaining_usd: 32,
        total_credits_usd: 50,
        credits_used_usd: 18,
        accounting_method: "energy",
      },
      subscription: {
        plan: "standard",
        kwh_included: 20,
        kwh_used: 5,
      },
    }),
  ),
  url: request.url,
});

const runtime = (requests: HttpRequest[], endpoint = " 'neural.example.test/custom/v1/' ") =>
  makeFirstPartyProviderRuntime({
    providers: [neuralwatt],
    settings: {
      read: (_provider, key) => {
        if (key === "NEURALWATT_API_KEY") {
          return Effect.die("selected account must suppress ambient Neuralwatt credentials");
        }
        return Effect.succeed(key === "NEURALWATT_API_URL" ? endpoint : undefined);
      },
    },
    selectedAccounts: {
      resolve: () =>
        Effect.succeed({
          id: "neuralwatt-selected",
          secureSettings: { NEURALWATT_API_KEY: "selected-key" },
        }),
    },
    browserSessions: { cookieHeader: () => Effect.succeed("") },
    credentials: {
      read: () => Effect.die("selected account must suppress keyring Neuralwatt credentials"),
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

describe("first-party runtime selected Neuralwatt accounts", () => {
  it.each(["auto", "api"] as const)(
    "uses only the selected key and validated global endpoint under %s source",
    async (sourceMode) => {
      const requests: HttpRequest[] = [];
      const outcome = await Effect.runPromise(
        runtime(requests).fetch("neuralwatt", { sourceMode, includeCredits: false }),
      );

      expect(outcome.strategyId).toBe("neuralwatt.api");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe("https://neural.example.test/custom/v1/quota");
      expect(requests[0]?.headers).toMatchObject({
        Authorization: "Bearer selected-key",
        Accept: "application/json",
      });
      expect(JSON.stringify(outcome)).not.toContain("selected-key");
    },
  );

  it.each(["web", "cli", "oauth"] as const)(
    "keeps a selected Neuralwatt account terminal under %s source",
    async (sourceMode) => {
      const requests: HttpRequest[] = [];
      await expect(
        Effect.runPromise(
          runtime(requests).fetch("neuralwatt", { sourceMode, includeCredits: false }),
        ),
      ).rejects.toMatchObject({ name: "NoAvailableStrategy", providerId: "neuralwatt" });
      expect(requests).toHaveLength(0);
    },
  );

  it.each([
    "http://attacker.test",
    "https://user:pass@neural.test",
    "https://neural.test%2f.attacker.test",
  ])("rejects unsafe selected-account endpoint %s before transport", async (endpoint) => {
    const requests: HttpRequest[] = [];
    await expect(
      Effect.runPromise(
        runtime(requests, endpoint).fetch("neuralwatt", {
          sourceMode: "auto",
          includeCredits: false,
        }),
      ),
    ).rejects.toMatchObject({ kind: "api-failure" });
    expect(requests).toHaveLength(0);
  });

  it("redacts selected Neuralwatt material from transport failures", async () => {
    const selected = makeFirstPartyProviderRuntime({
      providers: [neuralwatt],
      settings: { read: () => Effect.succeed(undefined) },
      selectedAccounts: {
        resolve: () =>
          Effect.succeed({
            id: "neuralwatt-selected",
            secureSettings: { NEURALWATT_API_KEY: "selected-key" },
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
      Effect.flip(selected.fetch("neuralwatt", { sourceMode: "auto", includeCredits: false })),
    );
    expect(error).toMatchObject({ kind: "network-failure" });
    expect(error.message).toContain("[REDACTED]");
    expect(error.message).not.toContain("selected-key");
  });
});
