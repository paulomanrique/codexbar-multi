import { Cause, Effect, Exit } from "effect";
import { describe, expect, it } from "vite-plus/test";
import type { UsageSnapshot } from "@codexbar/contracts";
import {
  ClassifiedFetchFailure,
  fetchAttemptsFromFailure,
  makeProviderFetchPipeline,
  TestClock,
} from "../src/index.ts";

const snapshot = { providerId: "codex" } as unknown as UsageSnapshot;
const context = { sourceMode: "auto", includeCredits: false } as const;

describe("ProviderFetchPipeline", () => {
  it("records unavailable strategies and faithfully defers fallback to the strategy", async () => {
    const pipeline = makeProviderFetchPipeline({
      resolveStrategies: () =>
        Effect.succeed([
          {
            id: "unavailable",
            source: "web" as const,
            isAvailable: () => Effect.succeed(false),
            fetch: () => Effect.succeed(snapshot),
            shouldFallback: () => false,
          },
          {
            id: "web-failed",
            source: "web" as const,
            isAvailable: () => Effect.succeed(true),
            fetch: () => Effect.fail(new ClassifiedFetchFailure("network-failure", "offline")),
            shouldFallback: () => true,
          },
          {
            id: "fallback",
            source: "cli" as const,
            isAvailable: () => Effect.succeed(true),
            fetch: () => Effect.succeed(snapshot),
            shouldFallback: () => false,
          },
        ]),
    });

    const result = await Effect.runPromise(
      pipeline.fetch("codex", context).pipe(Effect.provide(TestClock())),
    );
    expect(result.strategyId).toBe("fallback");
    expect(result.attempts).toMatchObject([
      { strategyId: "unavailable", available: false },
      { strategyId: "web-failed", available: true, error: { _tag: "ClassifiedFetchFailure" } },
      { strategyId: "fallback", available: true },
    ]);
  });

  it("delays and retries a classified failure exactly once before fallback", async () => {
    let calls = 0;
    let fallbackCalls = 0;
    const pipeline = makeProviderFetchPipeline({
      resolveStrategies: () =>
        Effect.succeed([
          {
            id: "web",
            source: "web" as const,
            isAvailable: () => Effect.succeed(true),
            fetch: () =>
              Effect.suspend(() => {
                calls += 1;
                return calls === 1
                  ? Effect.fail(new ClassifiedFetchFailure("rate-limited", "later", 250))
                  : Effect.succeed(snapshot);
              }),
            shouldFallback: () => {
              fallbackCalls += 1;
              return true;
            },
          },
        ]),
    });

    const result = await Effect.runPromise(
      pipeline.fetch("codex", context).pipe(Effect.provide(TestClock())),
    );
    expect(result.strategyId).toBe("web");
    expect(calls).toBe(2);
    expect(fallbackCalls).toBe(0);
  });

  it("preserves ordered attempts on the original terminal failure object", async () => {
    const terminal = new ClassifiedFetchFailure("authentication-expired", "secret detail");
    const originalKeys = Object.keys(terminal);
    const pipeline = makeProviderFetchPipeline({
      resolveStrategies: () =>
        Effect.succeed([
          {
            id: "unavailable",
            source: "api-token" as const,
            isAvailable: () => Effect.succeed(false),
            fetch: () => Effect.succeed(snapshot),
            shouldFallback: () => false,
          },
          {
            id: "terminal",
            source: "oauth" as const,
            isAvailable: () => Effect.succeed(true),
            fetch: () => Effect.fail(terminal),
            shouldFallback: () => false,
          },
        ]),
    });

    const failure = await Effect.runPromise(
      pipeline.fetch("codex", context).pipe(Effect.provide(TestClock()), Effect.flip),
    );

    expect(failure).toBe(terminal);
    expect(failure).toBeInstanceOf(ClassifiedFetchFailure);
    expect(Object.keys(terminal)).toEqual(originalKeys);
    expect(fetchAttemptsFromFailure(failure)).toMatchObject([
      { strategyId: "unavailable", source: "api-token", available: false },
      {
        strategyId: "terminal",
        source: "oauth",
        available: true,
        error: terminal,
      },
    ]);
  });

  it("propagates cancellation rather than falling back", async () => {
    let fallbackCalls = 0;
    const controller = new AbortController();
    const pipeline = makeProviderFetchPipeline({
      resolveStrategies: () =>
        Effect.succeed([
          {
            id: "slow-web",
            source: "web" as const,
            isAvailable: () => Effect.succeed(true),
            fetch: () => Effect.sleep(60_000).pipe(Effect.as(snapshot)),
            shouldFallback: () => {
              fallbackCalls += 1;
              return true;
            },
          },
        ]),
    });
    const running = Effect.runPromiseExit(
      pipeline.fetch("codex", context).pipe(Effect.provide(TestClock())),
      { signal: controller.signal },
    );
    controller.abort();
    const exit = await running;
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    expect(fallbackCalls).toBe(0);
  });
});
