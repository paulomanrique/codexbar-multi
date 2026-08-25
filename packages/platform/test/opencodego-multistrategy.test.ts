import { Effect, Fiber } from "effect";
import { InfrastructureError } from "@codexbar/core";
import { opencodego } from "@codexbar/providers";
import { describe, expect, it, vi } from "vite-plus/test";
import { makeFirstPartyProviderRuntime } from "../src/first-party-runtime.ts";

const clock = {
  now: Effect.succeed(Date.parse("2026-08-20T12:00:00.000Z")),
  sleep: () => Effect.void,
};
const body = (value: unknown) =>
  new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));

const runtimeFor = (
  requestLog: string[],
  apiStatus = 200,
  apiKey: string | undefined = "go-fixture",
) =>
  makeFirstPartyProviderRuntime({
    providers: [opencodego],
    settings: {
      read: (_provider, setting) =>
        Effect.succeed(
          setting === "OPENCODE_API_KEY"
            ? apiKey
            : setting === "OPENCODEGO_WORKSPACE_ID"
              ? "wrk_fixture"
              : undefined,
        ),
    },
    credentials: {
      read: () => Effect.succeed(undefined),
      write: () => Effect.void,
      remove: () => Effect.void,
    },
    browserSessions: { cookieHeader: () => Effect.succeed("auth=fixture") },
    http: {
      execute: (request) => {
        const url = new URL(request.url);
        requestLog.push(url.pathname);
        if (url.pathname === "/zen/go/v1/usage")
          return Effect.succeed({
            status: apiStatus,
            headers: {},
            body: body(
              apiStatus === 200
                ? { rollingUsage: { usagePercent: 10, resetInSec: 600 } }
                : "unavailable",
            ),
            url: request.url,
          });
        if (url.pathname.endsWith("/go"))
          return Effect.succeed({
            status: 200,
            headers: {},
            body: body({ rollingUsage: { usagePercent: 15, resetInSec: 600 } }),
            url: request.url,
          });
        if (url.pathname === "/_server")
          return Effect.succeed({
            status: 200,
            headers: {},
            body: body({ zenBalanceUSD: 7 }),
            url: request.url,
          });
        return Effect.fail(new InfrastructureError("test", "unexpected OpenCode Go request"));
      },
    },
    clock,
  });

describe("OpenCode Go host multi-strategy runtime", () => {
  it("tries API then the approved web strategy in Auto mode", async () => {
    const calls: string[] = [];
    const outcome = await Effect.runPromise(
      runtimeFor(calls, 503).fetch("opencodego", { sourceMode: "auto", includeCredits: false }),
    );

    expect(outcome).toMatchObject({
      strategyId: "opencodego.web",
      source: "web",
      snapshot: { primary: { usedPercent: 15 }, providerCost: { used: 7 } },
    });
    expect(outcome.attempts.map((attempt) => attempt.strategyId)).toEqual([
      "opencodego.api",
      "opencodego.web",
    ]);
    expect(calls).toEqual(["/zen/go/v1/usage", "/workspace/wrk_fixture/go", "/_server"]);
  });

  it("keeps an explicit API request within the API strategy", async () => {
    const calls: string[] = [];
    await expect(
      Effect.runPromise(
        runtimeFor(calls, 503).fetch("opencodego", { sourceMode: "api", includeCredits: false }),
      ),
    ).rejects.toMatchObject({ kind: "provider-unavailable" });
    expect(calls).toEqual(["/zen/go/v1/usage"]);
  });

  it("uses the approved web strategy when Auto has no API key", async () => {
    const calls: string[] = [];
    const outcome = await Effect.runPromise(
      runtimeFor(calls, 200, "").fetch("opencodego", {
        sourceMode: "auto",
        includeCredits: false,
      }),
    );
    expect(outcome).toMatchObject({ strategyId: "opencodego.web", source: "web" });
    expect(outcome.attempts.map((attempt) => attempt.strategyId)).toEqual([
      "opencodego.api",
      "opencodego.web",
    ]);
    expect(calls).toEqual(["/workspace/wrk_fixture/go", "/_server"]);
  });

  it("reports a missing API key without making a web request in API mode", async () => {
    const calls: string[] = [];
    await expect(
      Effect.runPromise(
        runtimeFor(calls, 200, "").fetch("opencodego", {
          sourceMode: "api",
          includeCredits: false,
        }),
      ),
    ).rejects.toMatchObject({ kind: "missing-credential" });
    expect(calls).toEqual([]);
  });

  it("does not fall back to web when an Auto API request is interrupted", async () => {
    let apiCalls = 0;
    let cookieCalls = 0;
    const runtime = makeFirstPartyProviderRuntime({
      providers: [opencodego],
      settings: {
        read: (_provider, setting) =>
          Effect.succeed(
            setting === "OPENCODE_API_KEY"
              ? "go-fixture"
              : setting === "OPENCODEGO_WORKSPACE_ID"
                ? "wrk_fixture"
                : undefined,
          ),
      },
      credentials: {
        read: () => Effect.succeed(undefined),
        write: () => Effect.void,
        remove: () => Effect.void,
      },
      browserSessions: {
        cookieHeader: () =>
          Effect.sync(() => {
            cookieCalls += 1;
            return "session=must-not-be-read";
          }),
      },
      http: {
        execute: () =>
          Effect.sync(() => {
            apiCalls += 1;
          }).pipe(Effect.andThen(Effect.never)),
      },
      clock,
    });

    const fiber = Effect.runFork(
      runtime.fetch("opencodego", { sourceMode: "auto", includeCredits: false }),
    );
    await vi.waitFor(() => expect(apiCalls).toBe(1));
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(cookieCalls).toBe(0);
  });

  it("keeps an explicit web request out of the API strategy", async () => {
    const calls: string[] = [];
    const outcome = await Effect.runPromise(
      runtimeFor(calls).fetch("opencodego", { sourceMode: "web", includeCredits: false }),
    );
    expect(outcome).toMatchObject({ strategyId: "opencodego.web", source: "web" });
    expect(calls).toEqual(["/workspace/wrk_fixture/go", "/_server"]);
  });
});
