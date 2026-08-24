import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { InfrastructureError, type HttpRequest } from "@codexbar/core";
import { deepinfra } from "@codexbar/providers";
import { makeFirstPartyProviderRuntime } from "../src/first-party-runtime.ts";

const clock = { now: Effect.succeed(Date.parse("2026-08-24T12:00:00Z")), sleep: () => Effect.void };

const response = (request: HttpRequest, body: unknown) => ({
  status: 200,
  headers: { "content-type": "application/json" },
  body: new TextEncoder().encode(JSON.stringify(body)),
  url: request.url,
});

const selectedRuntime = (
  requests: HttpRequest[],
  settingReads: string[],
  credentialReads: string[],
) =>
  makeFirstPartyProviderRuntime({
    providers: [deepinfra],
    settings: {
      read: (_provider, key) => {
        settingReads.push(key);
        return Effect.succeed(
          key === "DEEPINFRA_API_KEY"
            ? "ambient-primary"
            : key === "DEEPINFRA_TOKEN"
              ? "ambient-alias"
              : undefined,
        );
      },
    },
    selectedAccounts: {
      resolve: () =>
        Effect.succeed({
          id: "deepinfra-selected",
          secureSettings: { DEEPINFRA_API_KEY: "selected-key", DEEPINFRA_TOKEN: null },
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
        return Effect.succeed(
          response(
            request,
            request.url.includes("/payment/checklist")
              ? { stripe_balance: -20, recent: 5, limit: 100, suspended: false }
              : { months: [{ total_cost: 500 }] },
          ),
        );
      },
    },
    clock,
  });

describe("first-party runtime selected DeepInfra accounts", () => {
  it("preserves the Swift ambient legacy alias path through the composed runtime", async () => {
    const requests: HttpRequest[] = [];
    const runtime = makeFirstPartyProviderRuntime({
      providers: [deepinfra],
      settings: {
        read: (_provider, key) =>
          Effect.succeed(key === "DEEPINFRA_TOKEN" ? " 'ambient-alias' " : undefined),
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
          return Effect.succeed(
            response(
              request,
              request.url.includes("/payment/checklist")
                ? { stripe_balance: -1, recent: 0 }
                : { months: [] },
            ),
          );
        },
      },
      clock,
    });

    const outcome = await Effect.runPromise(
      runtime.fetch("deepinfra", { sourceMode: "auto", includeCredits: false }),
    );
    expect(outcome.strategyId).toBe("deepinfra.api");
    expect(requests).toHaveLength(2);
    expect(
      requests.every((request) => request.headers?.Authorization === "Bearer ambient-alias"),
    ).toBe(true);
  });

  it.each(["auto", "api"] as const)(
    "uses only the selected API key under %s source",
    async (sourceMode) => {
      const requests: HttpRequest[] = [];
      const settingReads: string[] = [];
      const credentialReads: string[] = [];
      const runtime = selectedRuntime(requests, settingReads, credentialReads);

      const outcome = await Effect.runPromise(
        runtime.fetch("deepinfra", { sourceMode, includeCredits: false }),
      );

      expect(outcome.strategyId).toBe("deepinfra.api");
      expect(requests).toHaveLength(2);
      expect(requests.map((request) => request.headers?.Authorization)).toEqual([
        "Bearer selected-key",
        "Bearer selected-key",
      ]);
      expect(
        requests.every((request) => new URL(request.url).hostname === "api.deepinfra.com"),
      ).toBe(true);
      expect(settingReads).not.toContain("DEEPINFRA_API_KEY");
      expect(settingReads).not.toContain("DEEPINFRA_TOKEN");
      expect(credentialReads).toHaveLength(0);
      expect(JSON.stringify(outcome)).not.toContain("selected-key");
      expect(JSON.stringify(outcome)).not.toContain("ambient-primary");
    },
  );

  it.each(["web", "cli", "oauth"] as const)(
    "does not reinterpret a selected DeepInfra account under %s source",
    async (sourceMode) => {
      const requests: HttpRequest[] = [];
      const runtime = selectedRuntime(requests, [], []);

      await expect(
        Effect.runPromise(runtime.fetch("deepinfra", { sourceMode, includeCredits: false })),
      ).rejects.toMatchObject({ name: "NoAvailableStrategy", providerId: "deepinfra" });
      expect(requests).toHaveLength(0);
    },
  );

  it("fails closed when the selected mapper does not provide its canonical secret", async () => {
    let requests = 0;
    const runtime = makeFirstPartyProviderRuntime({
      providers: [deepinfra],
      settings: { read: () => Effect.succeed("ambient-key") },
      selectedAccounts: {
        resolve: () => Effect.succeed({ id: "deepinfra-invalid", secureSettings: {} }),
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
      Effect.runPromise(runtime.fetch("deepinfra", { sourceMode: "auto", includeCredits: false })),
    ).rejects.toMatchObject({ name: "NoAvailableStrategy", providerId: "deepinfra" });
    expect(requests).toBe(0);
  });

  it("redacts a selected key echoed by the transport", async () => {
    const runtime = makeFirstPartyProviderRuntime({
      providers: [deepinfra],
      settings: { read: () => Effect.succeed(undefined) },
      selectedAccounts: {
        resolve: () =>
          Effect.succeed({
            id: "deepinfra-redaction",
            secureSettings: { DEEPINFRA_API_KEY: "selected-key", DEEPINFRA_TOKEN: null },
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
      Effect.flip(runtime.fetch("deepinfra", { sourceMode: "auto", includeCredits: false })),
    );
    expect(error.message).toContain("[REDACTED]");
    expect(error.message).not.toContain("selected-key");
  });
});
