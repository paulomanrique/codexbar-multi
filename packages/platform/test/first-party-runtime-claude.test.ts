import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { ClassifiedFetchFailure } from "@codexbar/core";
import { amp, claude } from "@codexbar/providers";
import type { FirstPartyProvider } from "@codexbar/providers";
import { makeFirstPartyProviderRuntime } from "../src/first-party-runtime.ts";

const clock = { now: Effect.succeed(1), sleep: () => Effect.void };

const credentials = {
  read: () => Effect.succeed(undefined),
  write: () => Effect.void,
  remove: () => Effect.void,
};

const unusedLocal = {
  run: () => Effect.succeed({ exitCode: 0, signal: undefined, stdout: "", stderr: "" }),
  readData: () => Effect.succeed(undefined),
};

describe("first-party runtime Claude scoping and bounds", () => {
  it("rejects fetchClaudeCliUsage for non-claude providers with permission-denied", async () => {
    let capabilityCalls = 0;
    const ampCallingClaude: FirstPartyProvider = {
      ...amp,
      strategies: [
        {
          id: "amp.claude-misuse",
          kind: "cli",
          fetchUsage: async (ctx) => {
            await ctx.local!.fetchClaudeCliUsage!();
            return {
              primary: { usedPercent: 0, windowMinutes: 1 },
              identity: { providerId: "amp" },
            };
          },
        },
      ],
    };
    const runtime = makeFirstPartyProviderRuntime({
      providers: [ampCallingClaude],
      settings: { read: () => Effect.succeed(undefined) },
      credentials,
      browserSessions: { cookieHeader: () => Effect.fail(new Error("missing")) },
      local: {
        ...unusedLocal,
        fetchClaudeCliUsage: () => {
          capabilityCalls += 1;
          return Effect.succeed({ stdout: "x", stderr: "", loggedIn: true });
        },
      },
      http: { execute: () => Effect.fail(new Error("not used")) } as never,
      clock,
    });
    await expect(
      Effect.runPromise(runtime.fetch("amp", { sourceMode: "cli", includeCredits: false })),
    ).rejects.toMatchObject({
      name: "ClassifiedFetchFailure",
      kind: "permission-denied",
      message: expect.stringMatching(/not declared/i),
    });
    const rejected = await Effect.runPromise(
      runtime.fetch("amp", { sourceMode: "cli", includeCredits: false }),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(rejected).toBeInstanceOf(ClassifiedFetchFailure);
    expect(rejected).not.toMatchObject({ operation: "read Claude CLI usage" });
    expect(capabilityCalls).toBe(0);
  });

  it("rejects 1 MiB/NUL limits on the production Claude path", async () => {
    const runtime = makeFirstPartyProviderRuntime({
      providers: [claude],
      settings: { read: () => Effect.succeed(undefined) },
      credentials,
      browserSessions: { cookieHeader: () => Effect.fail(new Error("missing")) },
      local: {
        ...unusedLocal,
        fetchClaudeCliUsage: () =>
          Effect.succeed({ stdout: "x".repeat(1024 * 1024 + 1), stderr: "", loggedIn: true }),
      },
      http: { execute: () => Effect.fail(new Error("not used")) } as never,
      clock,
    });
    await expect(
      Effect.runPromise(runtime.fetch("claude", { sourceMode: "cli", includeCredits: false })),
    ).rejects.toMatchObject({ kind: "api-failure" });

    const runtime2 = makeFirstPartyProviderRuntime({
      providers: [claude],
      settings: { read: () => Effect.succeed(undefined) },
      credentials,
      browserSessions: { cookieHeader: () => Effect.fail(new Error("missing")) },
      local: {
        ...unusedLocal,
        fetchClaudeCliUsage: () =>
          Effect.succeed({ stdout: "x\u0000", stderr: "", loggedIn: true }),
      },
      http: { execute: () => Effect.fail(new Error("not used")) } as never,
      clock,
    });
    await expect(
      Effect.runPromise(runtime2.fetch("claude", { sourceMode: "cli", includeCredits: false })),
    ).rejects.toMatchObject({ kind: "api-failure" });
  });

  it("bounds Claude output by UTF-8 bytes rather than JavaScript characters", async () => {
    const runtime = makeFirstPartyProviderRuntime({
      providers: [claude],
      settings: { read: () => Effect.succeed(undefined) },
      credentials: {
        read: () => Effect.succeed(undefined),
        write: () => Effect.void,
        remove: () => Effect.void,
      },
      browserSessions: { cookieHeader: () => Effect.fail(new Error("missing")) },
      local: {
        ...unusedLocal,
        fetchClaudeCliUsage: () =>
          Effect.succeed({ stdout: "é".repeat(600_000), stderr: "", loggedIn: true }),
      },
      http: { execute: () => Effect.fail(new Error("not used")) } as never,
      clock,
    });
    await expect(
      Effect.runPromise(runtime.fetch("claude", { sourceMode: "cli", includeCredits: false })),
    ).rejects.toMatchObject({ kind: "api-failure" });
  });
});
