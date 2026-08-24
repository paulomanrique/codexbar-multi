import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { InfrastructureError, type HttpRequest } from "@codexbar/core";
import type { FirstPartyProvider, ProviderContext, ProviderStrategy } from "@codexbar/providers";
import { makeFirstPartyProviderRuntime } from "../src/first-party-runtime.ts";

const clock = { now: Effect.succeed(1), sleep: () => Effect.void };

const credentials = {
  read: () => Effect.succeed(undefined),
  write: () => Effect.void,
  remove: () => Effect.void,
};

const fallbackOn = [
  "authentication-expired",
  "missing-credential",
  "provider-unavailable",
  "parse-failure",
  "network-failure",
  "rate-limited",
  "permission-denied",
  "api-failure",
] as const;

interface SeenGrokStrategy {
  readonly id: string;
  readonly sourceMode: string | undefined;
  readonly oauth: string | undefined;
  readonly cookie: string | undefined;
  readonly selectedAccount: ProviderContext["selectedAccount"];
}

const grokFixture = (
  seen: SeenGrokStrategy[],
  fail: (id: string, ctx: ProviderContext) => Error | undefined = () => undefined,
): FirstPartyProvider => {
  const strategy = (id: string, kind: ProviderStrategy["kind"]): ProviderStrategy => ({
    id,
    kind,
    fallbackOn,
    fetchUsage: async (ctx) => {
      seen.push({
        id,
        sourceMode: ctx.sourceMode,
        oauth: ctx.settings.getSecret("GROK_OAUTH_TOKEN"),
        cookie: ctx.settings.getSecret("GROK_COOKIE_HEADER"),
        selectedAccount: ctx.selectedAccount,
      });
      const error = fail(id, ctx);
      if (error !== undefined) throw error;
      return { primary: { usedPercent: 25 } };
    },
  });
  const cli = strategy("grok.cli", "cli");
  const oauth = strategy("grok.oauth", "oauth");
  const web = strategy("grok.web", "web");
  const oauthGrpc = strategy("grok.oauth-grpc", "oauth");
  return {
    ...web,
    descriptor: {
      id: "grok",
      name: "Grok",
      status: "partial",
      endpoints: [],
      settings: [
        { key: "GROK_OAUTH_TOKEN", title: "SuperGrok OAuth token", type: "secure" },
        { key: "GROK_COOKIE_HEADER", title: "Cookie header", type: "secure" },
      ],
      strategy: web,
      strategies: [cli, oauth, web, oauthGrpc],
    },
    strategies: [cli, oauth, web, oauthGrpc],
  };
};

const runtimeFor = (
  provider: FirstPartyProvider,
  selectedSecureSettings: Readonly<Record<string, string | null>>,
  settingsRead: (key: string) => string | undefined = () => undefined,
) =>
  makeFirstPartyProviderRuntime({
    providers: [provider],
    settings: { read: (_provider, key) => Effect.succeed(settingsRead(key)) },
    selectedAccounts: {
      resolve: () =>
        Effect.succeed({
          id: "account-selected",
          secureSettings: selectedSecureSettings,
        }),
    },
    credentials,
    browserSessions: { cookieHeader: () => Effect.fail(new Error("not used")) },
    http: {
      execute: (_request: HttpRequest) => Effect.fail(new InfrastructureError("test", "not used")),
    },
    clock,
  });

describe("first-party runtime Grok selected-account routing", () => {
  it("uses the selected Grok OAuth credential over ambient and keeps it out of outcomes", async () => {
    const seen: SeenGrokStrategy[] = [];
    let ambientOAuthReads = 0;
    const provider = grokFixture(seen);
    const runtime = runtimeFor(provider, { GROK_OAUTH_TOKEN: "selected-oauth-secret" }, (key) => {
      if (key === "GROK_OAUTH_TOKEN") ambientOAuthReads += 1;
      if (key === "GROK_OAUTH_TOKEN") return "ambient-oauth-secret";
      if (key === "GROK_COOKIE_HEADER") return "ambient-cookie=secret";
      return undefined;
    });

    const outcome = await Effect.runPromise(
      runtime.fetch("grok", { sourceMode: "auto", includeCredits: false }),
    );

    expect(outcome.strategyId).toBe("grok.oauth");
    expect(outcome.attempts.map((attempt) => attempt.strategyId)).toEqual(["grok.oauth"]);
    expect(seen).toEqual([
      {
        id: "grok.oauth",
        sourceMode: "auto",
        oauth: "selected-oauth-secret",
        cookie: "ambient-cookie=secret",
        selectedAccount: { id: "account-selected" },
      },
    ]);
    expect(ambientOAuthReads).toBe(0);
    expect(JSON.stringify(outcome)).not.toContain("selected-oauth-secret");
    expect(JSON.stringify(outcome)).not.toContain("ambient-oauth-secret");
  });

  it("routes selected Grok OAuth auto refreshes only through OAuth strategies", async () => {
    const seen: SeenGrokStrategy[] = [];
    const provider = grokFixture(seen, (id, ctx) =>
      id === "grok.oauth"
        ? ctx.fail.missingCredential("proxy rejected selected-oauth-secret")
        : undefined,
    );
    const runtime = runtimeFor(provider, { GROK_OAUTH_TOKEN: "selected-oauth-secret" });

    const outcome = await Effect.runPromise(
      runtime.fetch("grok", { sourceMode: "auto", includeCredits: false }),
    );

    expect(outcome.strategyId).toBe("grok.oauth-grpc");
    expect(outcome.attempts.map((attempt) => attempt.strategyId)).toEqual([
      "grok.oauth",
      "grok.oauth-grpc",
    ]);
    expect(seen.map((entry) => entry.id)).toEqual(["grok.oauth", "grok.oauth-grpc"]);
    expect(JSON.stringify(outcome)).not.toContain("selected-oauth-secret");
  });

  it("routes selected Grok cookies in auto mode only to web", async () => {
    const seen: SeenGrokStrategy[] = [];
    let ambientOAuthReads = 0;
    const provider = grokFixture(seen);
    const runtime = runtimeFor(
      provider,
      { GROK_OAUTH_TOKEN: null, GROK_COOKIE_HEADER: "sso=selected-cookie" },
      (key) => {
        if (key === "GROK_OAUTH_TOKEN") ambientOAuthReads += 1;
        return key === "GROK_OAUTH_TOKEN" ? "ambient-oauth-secret" : undefined;
      },
    );

    const outcome = await Effect.runPromise(
      runtime.fetch("grok", { sourceMode: "auto", includeCredits: false }),
    );

    expect(outcome.strategyId).toBe("grok.web");
    expect(outcome.attempts.map((attempt) => attempt.strategyId)).toEqual(["grok.web"]);
    expect(seen).toEqual([
      {
        id: "grok.web",
        sourceMode: "auto",
        oauth: undefined,
        cookie: "sso=selected-cookie",
        selectedAccount: { id: "account-selected" },
      },
    ]);
    expect(ambientOAuthReads).toBe(0);
    expect(JSON.stringify(outcome)).not.toContain("selected-cookie");
  });

  it("keeps explicit Grok source modes explicit and does not suppress opposite ambient credentials", async () => {
    const seen: SeenGrokStrategy[] = [];
    const provider = grokFixture(seen);
    const runtime = runtimeFor(provider, { GROK_OAUTH_TOKEN: "selected-oauth-secret" }, (key) =>
      key === "GROK_COOKIE_HEADER" ? "ambient-cookie=secret" : undefined,
    );

    await expect(
      Effect.runPromise(runtime.fetch("grok", { sourceMode: "web", includeCredits: false })),
    ).resolves.toMatchObject({ strategyId: "grok.web" });

    expect(seen).toEqual([
      {
        id: "grok.web",
        sourceMode: "web",
        oauth: "selected-oauth-secret",
        cookie: "ambient-cookie=secret",
        selectedAccount: { id: "account-selected" },
      },
    ]);
  });

  it("keeps explicit Grok OAuth selected while scrubbing another account's pasted token", async () => {
    const seen: SeenGrokStrategy[] = [];
    let ambientOAuthReads = 0;
    const provider = grokFixture(seen);
    const runtime = runtimeFor(
      provider,
      { GROK_OAUTH_TOKEN: null, GROK_COOKIE_HEADER: "sso=selected-cookie" },
      (key) => {
        if (key === "GROK_OAUTH_TOKEN") ambientOAuthReads += 1;
        return key === "GROK_OAUTH_TOKEN" ? "ambient-oauth-secret" : undefined;
      },
    );

    await expect(
      Effect.runPromise(runtime.fetch("grok", { sourceMode: "oauth", includeCredits: false })),
    ).resolves.toMatchObject({ strategyId: "grok.oauth" });

    expect(seen).toEqual([
      {
        id: "grok.oauth",
        sourceMode: "oauth",
        oauth: undefined,
        cookie: "sso=selected-cookie",
        selectedAccount: { id: "account-selected" },
      },
    ]);
    expect(ambientOAuthReads).toBe(0);
  });
});
