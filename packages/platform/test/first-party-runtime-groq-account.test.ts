import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { InfrastructureError, type HttpRequest } from "@codexbar/core";
import { groq } from "@codexbar/providers";
import { makeFirstPartyProviderRuntime } from "../src/first-party-runtime.ts";

const clock = { now: Effect.succeed(Date.parse("2026-08-24T12:00:00Z")), sleep: () => Effect.void };

const response = (request: HttpRequest) => ({
  status: 200,
  headers: { "content-type": "application/json" },
  body: new TextEncoder().encode(
    JSON.stringify({ status: "success", data: { result: [{ value: [1_777_000_000, "1"] }] } }),
  ),
  url: request.url,
});

const selectedRuntime = (
  requests: HttpRequest[],
  settingReads: string[],
  credentialReads: string[],
  endpoint = "  'groq.example.test/v1'  ",
) =>
  makeFirstPartyProviderRuntime({
    providers: [groq],
    settings: {
      read: (_provider, key) => {
        settingReads.push(key);
        return Effect.succeed(
          key === "GROQ_API_KEY" ? "ambient-key" : key === "GROQ_API_URL" ? endpoint : undefined,
        );
      },
    },
    selectedAccounts: {
      resolve: () =>
        Effect.succeed({
          id: "groq-selected",
          secureSettings: { GROQ_API_KEY: "selected-key" },
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

describe("first-party runtime selected Groq API accounts", () => {
  it("accepts a quoted ambient endpoint and API key through the composed runtime", async () => {
    const requests: HttpRequest[] = [];
    const runtime = makeFirstPartyProviderRuntime({
      providers: [groq],
      settings: {
        read: (_provider, key) =>
          Effect.succeed(
            key === "GROQ_API_KEY"
              ? " 'ambient-key' "
              : key === "GROQ_API_URL"
                ? ' "groq.example.test/v1" '
                : undefined,
          ),
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

    await Effect.runPromise(runtime.fetch("groq", { sourceMode: "auto", includeCredits: false }));
    expect(requests).toHaveLength(4);
    expect(
      requests.every(
        (request) =>
          new URL(request.url).origin === "https://groq.example.test" &&
          request.headers?.Authorization === "Bearer ambient-key",
      ),
    ).toBe(true);
  });

  it.each(["auto", "api"] as const)(
    "uses the selected key and preserves the validated global endpoint under %s source",
    async (sourceMode) => {
      const requests: HttpRequest[] = [];
      const settingReads: string[] = [];
      const credentialReads: string[] = [];
      const runtime = selectedRuntime(requests, settingReads, credentialReads);

      const outcome = await Effect.runPromise(
        runtime.fetch("groq", { sourceMode, includeCredits: false }),
      );

      expect(outcome.strategyId).toBe("groq.api");
      expect(outcome.snapshot.identity?.loginMethod).toBe("Prometheus metrics");
      expect(requests).toHaveLength(4);
      expect(
        requests.every((request) => new URL(request.url).origin === "https://groq.example.test"),
      ).toBe(true);
      expect(
        requests.every((request) => request.headers?.Authorization === "Bearer selected-key"),
      ).toBe(true);
      expect(settingReads).toContain("GROQ_API_URL");
      expect(settingReads).not.toContain("GROQ_API_KEY");
      expect(credentialReads).not.toContain("provider/groq/secret/GROQ_API_KEY");
      expect(JSON.stringify(outcome)).not.toContain("selected-key");
      expect(JSON.stringify(outcome)).not.toContain("ambient-key");
    },
  );

  it.each(["web", "cli", "oauth"] as const)(
    "does not reinterpret a selected Groq API account under %s source",
    async (sourceMode) => {
      const requests: HttpRequest[] = [];
      const runtime = selectedRuntime(requests, [], []);

      await expect(
        Effect.runPromise(runtime.fetch("groq", { sourceMode, includeCredits: false })),
      ).rejects.toMatchObject({ name: "NoAvailableStrategy", providerId: "groq" });
      expect(requests).toHaveLength(0);
    },
  );

  it.each([
    "http://attacker.test/v1",
    "https://user:pass@proxy.test/v1",
    "https://proxy.test%2f.attacker.test/v1",
  ])("rejects an unsafe selected-account endpoint before transport: %s", async (endpoint) => {
    const requests: HttpRequest[] = [];
    const runtime = selectedRuntime(requests, [], [], endpoint);

    await expect(
      Effect.runPromise(runtime.fetch("groq", { sourceMode: "auto", includeCredits: false })),
    ).rejects.toMatchObject({ kind: "api-failure" });
    expect(requests).toHaveLength(0);
  });

  it("fails closed when the selected mapper does not provide its canonical secret", async () => {
    let requests = 0;
    const runtime = makeFirstPartyProviderRuntime({
      providers: [groq],
      settings: { read: () => Effect.succeed("ambient-value") },
      selectedAccounts: {
        resolve: () => Effect.succeed({ id: "groq-invalid", secureSettings: {} }),
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
      Effect.runPromise(runtime.fetch("groq", { sourceMode: "auto", includeCredits: false })),
    ).rejects.toMatchObject({ name: "NoAvailableStrategy", providerId: "groq" });
    expect(requests).toBe(0);
  });

  it("redacts a selected key echoed by the transport", async () => {
    const runtime = makeFirstPartyProviderRuntime({
      providers: [groq],
      settings: { read: () => Effect.succeed(undefined) },
      selectedAccounts: {
        resolve: () =>
          Effect.succeed({
            id: "groq-redaction",
            secureSettings: { GROQ_API_KEY: "selected-key" },
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
      Effect.flip(runtime.fetch("groq", { sourceMode: "auto", includeCredits: false })),
    );
    expect(error.message).toContain("[REDACTED]");
    expect(error.message).not.toContain("selected-key");
  });
});
