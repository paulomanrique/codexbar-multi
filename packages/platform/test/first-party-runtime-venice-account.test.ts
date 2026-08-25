import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { InfrastructureError, type HttpRequest } from "@codexbar/core";
import { venice } from "@codexbar/providers";
import { makeFirstPartyProviderRuntime } from "../src/first-party-runtime.ts";

const clock = { now: Effect.succeed(Date.parse("2026-08-24T12:00:00Z")), sleep: () => Effect.void };

const response = (request: HttpRequest) => ({
  status: 200,
  headers: { "content-type": "application/json" },
  body: new TextEncoder().encode(
    JSON.stringify({
      canConsume: true,
      consumptionCurrency: "USD",
      balances: { usd: 12.34, diem: null },
      diemEpochAllocation: null,
    }),
  ),
  url: request.url,
});

const selectedRuntime = (
  requests: HttpRequest[],
  settingReads: string[],
  credentialReads: string[],
) =>
  makeFirstPartyProviderRuntime({
    providers: [venice],
    settings: {
      read: (_provider, key) => {
        settingReads.push(key);
        return Effect.succeed(
          key === "VENICE_API_KEY"
            ? "ambient-primary"
            : key === "VENICE_KEY"
              ? "ambient-alias"
              : undefined,
        );
      },
    },
    selectedAccounts: {
      resolve: () =>
        Effect.succeed({
          id: "venice-selected",
          secureSettings: { VENICE_API_KEY: "selected-key", VENICE_KEY: null },
        }),
    },
    browserSessions: { cookieHeader: () => Effect.succeed("") },
    credentials: {
      read: (key) => {
        credentialReads.push(key);
        return Effect.succeed("ambient-keyring");
      },
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

describe("first-party runtime selected Venice API accounts", () => {
  it("preserves the quoted ambient legacy alias through the composed runtime", async () => {
    const requests: HttpRequest[] = [];
    const runtime = makeFirstPartyProviderRuntime({
      providers: [venice],
      settings: {
        read: (_provider, key) =>
          Effect.succeed(key === "VENICE_KEY" ? " 'ambient-alias' " : undefined),
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

    await Effect.runPromise(runtime.fetch("venice", { sourceMode: "auto", includeCredits: false }));
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.venice.ai/api/v1/billing/balance");
    expect(requests[0]?.headers).toMatchObject({
      Authorization: "Bearer ambient-alias",
      Accept: "application/json",
    });
  });

  it.each(["auto", "api"] as const)(
    "uses only the selected canonical key under %s source",
    async (sourceMode) => {
      const requests: HttpRequest[] = [];
      const settingReads: string[] = [];
      const credentialReads: string[] = [];
      const runtime = selectedRuntime(requests, settingReads, credentialReads);

      const outcome = await Effect.runPromise(
        runtime.fetch("venice", { sourceMode, includeCredits: false }),
      );

      expect(outcome.strategyId).toBe("venice.api");
      expect(outcome.snapshot.primary).toMatchObject({
        usedPercent: 0,
        resetDescription: "$12.34 USD remaining",
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.headers?.Authorization).toBe("Bearer selected-key");
      expect(settingReads).not.toContain("VENICE_API_KEY");
      expect(settingReads).not.toContain("VENICE_KEY");
      expect(credentialReads).toHaveLength(0);
      expect(JSON.stringify(outcome)).not.toContain("selected-key");
      expect(JSON.stringify(outcome)).not.toContain("ambient-primary");
    },
  );

  it.each(["web", "cli", "oauth"] as const)(
    "does not reinterpret a selected Venice account under %s source",
    async (sourceMode) => {
      const requests: HttpRequest[] = [];
      const runtime = selectedRuntime(requests, [], []);

      await expect(
        Effect.runPromise(runtime.fetch("venice", { sourceMode, includeCredits: false })),
      ).rejects.toMatchObject({ name: "NoAvailableStrategy", providerId: "venice" });
      expect(requests).toHaveLength(0);
    },
  );

  it("fails closed when the selected mapper omits its canonical secret", async () => {
    let requests = 0;
    const runtime = makeFirstPartyProviderRuntime({
      providers: [venice],
      settings: { read: () => Effect.succeed("ambient-value") },
      selectedAccounts: {
        resolve: () =>
          Effect.succeed({ id: "venice-invalid", secureSettings: { VENICE_KEY: null } }),
      },
      browserSessions: { cookieHeader: () => Effect.succeed("") },
      credentials: {
        read: () => Effect.succeed("ambient-keyring"),
        write: () => Effect.void,
        remove: () => Effect.void,
      },
      http: {
        execute: () => {
          requests += 1;
          return Effect.die("must not execute");
        },
      },
      clock,
    });

    await expect(
      Effect.runPromise(runtime.fetch("venice", { sourceMode: "auto", includeCredits: false })),
    ).rejects.toMatchObject({ name: "NoAvailableStrategy", providerId: "venice" });
    expect(requests).toBe(0);
  });

  it("redacts a selected key echoed by the transport", async () => {
    const runtime = makeFirstPartyProviderRuntime({
      providers: [venice],
      settings: { read: () => Effect.succeed(undefined) },
      selectedAccounts: {
        resolve: () =>
          Effect.succeed({
            id: "venice-redaction",
            secureSettings: { VENICE_API_KEY: "selected-key", VENICE_KEY: null },
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
      Effect.flip(runtime.fetch("venice", { sourceMode: "auto", includeCredits: false })),
    );
    expect(error).toMatchObject({ kind: "network-failure" });
    expect(error.message).toContain("[REDACTED]");
    expect(error.message).not.toContain("selected-key");
  });
});
