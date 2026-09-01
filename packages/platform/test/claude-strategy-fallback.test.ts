import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { MissingBrowserCredentialError } from "@codexbar/core";
import { claude } from "@codexbar/providers";
import { makeFirstPartyProviderRuntime } from "../src/first-party-runtime.ts";

const clock = { now: Effect.succeed(Date.parse("2026-08-20T12:00:00Z")), sleep: () => Effect.void };
const credentials = {
  read: () => Effect.succeed(undefined),
  write: () => Effect.void,
  remove: () => Effect.void,
};
const unusedLocal = {
  run: () => Effect.succeed({ exitCode: 0, signal: undefined, stdout: "", stderr: "" }),
  readData: () => Effect.succeed(undefined),
};
const oauthBody = {
  five_hour: { utilization: 11, resets_at: "2026-08-20T17:00:00Z" },
  seven_day: { utilization: 22 },
};

describe("Claude strategy order and fallback", () => {
  it("prefers nonempty OAuth and never invokes CLI", async () => {
    let cliCalls = 0;
    const runtime = makeFirstPartyProviderRuntime({
      runtime: "cli",
      providers: [claude],
      settings: {
        read: (_provider, key) =>
          Effect.succeed(key === "CLAUDE_OAUTH_ACCESS_TOKEN" ? "oauth-token" : undefined),
      },
      credentials,
      browserSessions: { cookieHeader: () => Effect.fail(new Error("missing")) },
      local: {
        ...unusedLocal,
        fetchClaudeCliUsage: () => {
          cliCalls += 1;
          return Effect.succeed({ stdout: "", stderr: "", loggedIn: true });
        },
      },
      http: {
        execute: () =>
          Effect.succeed({
            status: 200,
            headers: {},
            body: new TextEncoder().encode(JSON.stringify(oauthBody)),
            url: "https://api.anthropic.com/api/oauth/usage",
          }),
      },
      clock,
    });
    await expect(
      Effect.runPromise(runtime.fetch("claude", { sourceMode: "auto", includeCredits: false })),
    ).resolves.toMatchObject({ strategyId: "claude.oauth", source: "oauth" });
    expect(cliCalls).toBe(0);
  });

  it("falls through missing OAuth to CLI and does not fabricate identity", async () => {
    const runtime = makeFirstPartyProviderRuntime({
      providers: [claude],
      settings: { read: () => Effect.succeed(undefined) },
      credentials,
      browserSessions: { cookieHeader: () => Effect.fail(new Error("missing")) },
      local: {
        ...unusedLocal,
        fetchClaudeCliUsage: () =>
          Effect.succeed({
            stdout:
              "Settings: Claude Usage\nCurrent session\n20% left\nCurrent week (all models)\n30% left",
            stderr: "",
            loggedIn: true,
          }),
      },
      http: { execute: () => Effect.fail(new Error("not used")) } as never,
      clock,
    });
    const outcome = await Effect.runPromise(
      runtime.fetch("claude", { sourceMode: "auto", includeCredits: false }),
    );
    expect(outcome.strategyId).toBe("claude.cli");
    expect(outcome.snapshot.primary?.usedPercent).toBe(80);
    expect(outcome.snapshot.dataConfidence).toBe("percentOnly");
    expect(outcome.snapshot.identity?.accountEmail).toBeUndefined();
  });

  it("cancellation during OAuth is terminal and does not invoke CLI", async () => {
    let cliCalls = 0;
    const runtime = makeFirstPartyProviderRuntime({
      providers: [claude],
      settings: {
        read: (_provider, key) =>
          Effect.succeed(key === "CLAUDE_OAUTH_ACCESS_TOKEN" ? "oauth-token" : undefined),
      },
      credentials,
      browserSessions: { cookieHeader: () => Effect.fail(new Error("missing")) },
      local: {
        ...unusedLocal,
        fetchClaudeCliUsage: () => {
          cliCalls += 1;
          return Effect.succeed({ stdout: "", stderr: "", loggedIn: true });
        },
      },
      http: {
        execute: () => Effect.never,
      },
      clock,
    });
    const controller = new AbortController();
    const pending = Effect.runPromise(
      runtime.fetch("claude", { sourceMode: "auto", includeCredits: false }),
      { signal: controller.signal },
    );
    controller.abort();
    await expect(pending).rejects.toBeDefined();
    expect(cliCalls).toBe(0);
  });

  it("CLI failure can reach an already-exported web session", async () => {
    const runtime = makeFirstPartyProviderRuntime({
      providers: [claude],
      settings: {
        read: (_provider, key) =>
          Effect.succeed(key === "CLAUDE_COOKIE_HEADER" ? "sessionKey=cookie" : undefined),
      },
      credentials,
      browserSessions: { cookieHeader: () => Effect.fail(new Error("missing")) },
      local: {
        ...unusedLocal,
        fetchClaudeCliUsage: () => Effect.succeed({ stdout: "", stderr: "", loggedIn: false }),
      },
      http: {
        execute: (request) => {
          const body = request.url.includes("/organizations/")
            ? oauthBody
            : [{ uuid: "org-1", name: "Org" }];
          return Effect.succeed({
            status: 200,
            headers: {},
            body: new TextEncoder().encode(JSON.stringify(body)),
            url: request.url,
          });
        },
      },
      clock,
    });
    await expect(
      Effect.runPromise(runtime.fetch("claude", { sourceMode: "auto", includeCredits: false })),
    ).resolves.toMatchObject({ strategyId: "claude.web", source: "web" });
  });

  it("no credential yields classified failure", async () => {
    const runtime = makeFirstPartyProviderRuntime({
      providers: [claude],
      settings: { read: () => Effect.succeed(undefined) },
      credentials,
      browserSessions: { cookieHeader: () => Effect.fail(new MissingBrowserCredentialError()) },
      local: unusedLocal,
      http: { execute: () => Effect.fail(new Error("not used")) } as never,
      clock,
    });
    await expect(
      Effect.runPromise(runtime.fetch("claude", { sourceMode: "auto", includeCredits: false })),
    ).rejects.toMatchObject({ kind: "missing-credential" });
  });
});
