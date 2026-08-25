import { Cause, Effect, Exit } from "effect";
import { describe, expect, it } from "vite-plus/test";
import {
  ClassifiedFetchFailure,
  InfrastructureError,
  MissingBrowserCredentialError,
  type CredentialStoreService,
} from "@codexbar/core";
import { claude, grok } from "@codexbar/providers";
import { makeFirstPartyProviderRuntime } from "../src/first-party-runtime.ts";
import { makeCredentialBrowserSessions } from "../src/node.ts";

const clock = { now: Effect.succeed(1_700_000_000_000), sleep: () => Effect.void };
const grpcPayload = new Uint8Array([0x0d, 0x00, 0x00, 0xc8, 0x41]);
const oauthToken = "fixture-oauth-token";
const cookieSecret = "super-secret-cookie-value";
const missingCredentialMessage = "No exported browser credential is available";
const allowedWebFallbackKinds = [
  "authentication-expired",
  "missing-credential",
  "provider-unavailable",
  "parse-failure",
  "network-failure",
  "rate-limited",
  "permission-denied",
  "api-failure",
] as const;

const store = (
  read: CredentialStoreService["read"] = () => Effect.succeed(undefined),
): CredentialStoreService => ({
  read,
  write: () => Effect.void,
  remove: () => Effect.void,
});

const storedBrowserSession = (
  provider: "claude" | "grok",
  accountId: string,
  cookieHeaders: Readonly<Record<string, string>>,
) =>
  JSON.stringify({
    version: 1,
    provider,
    accountId,
    cookieHeaders,
  });

const classified = (kind: ClassifiedFetchFailure["kind"]) =>
  new ClassifiedFetchFailure(kind, `${kind} from web`);

const leaked = (value: unknown) => {
  const text = value instanceof Error ? `${value.name}:${value.message}` : JSON.stringify(value);
  expect(text).not.toContain(oauthToken);
  expect(text).not.toContain(cookieSecret);
  expect(text).not.toContain("browser-session");
  expect(text).not.toContain("/tmp");
  expect(text).not.toContain("grok.com");
  return text;
};

const grokRuntime = (options: {
  readonly browserSessions: Parameters<typeof makeFirstPartyProviderRuntime>[0]["browserSessions"];
  readonly http?: Parameters<typeof makeFirstPartyProviderRuntime>[0]["http"];
  readonly onGrpc?: () => void;
}) => {
  let proxyCalls = 0;
  let grpcCalls = 0;
  const runtime = makeFirstPartyProviderRuntime({
    providers: [grok],
    settings: { read: () => Effect.succeed(undefined) },
    credentials: store(),
    browserSessions: options.browserSessions,
    local: {
      run: () => Effect.die("not used"),
      readData: () => Effect.succeed(undefined),
      fetchGrokCredentials: () =>
        Effect.succeed({
          accessToken: oauthToken,
          scope: "https://auth.x.ai::fixture",
          authMode: "oidc",
          email: "ada@example.test",
        }),
    },
    http: options.http ?? {
      execute: (request) => {
        if (request.url.includes("/v1/settings")) {
          return Effect.succeed({
            status: 200,
            headers: {},
            body: new TextEncoder().encode('{"subscription_tier_display":"SuperGrok"}'),
            url: request.url,
          });
        }
        if (request.url.includes("cli-chat-proxy.grok.com/v1/billing")) {
          proxyCalls += 1;
          return Effect.succeed({
            status: 500,
            headers: {},
            body: new TextEncoder().encode("proxy unavailable"),
            url: request.url,
          });
        }
        if (request.url.includes("grok.com/grok_api_v2")) {
          grpcCalls += 1;
          options.onGrpc?.();
          return Effect.succeed({
            status: 200,
            headers: {},
            body: grpcPayload,
            url: request.url,
          });
        }
        return Effect.fail(new InfrastructureError("test", "unexpected request"));
      },
    },
    clock,
  });
  return {
    runtime,
    counts: () => ({ proxyCalls, grpcCalls }),
  };
};

const claudeRuntime = (
  browserSessions: Parameters<typeof makeFirstPartyProviderRuntime>[0]["browserSessions"],
) =>
  makeFirstPartyProviderRuntime({
    providers: [claude],
    settings: { read: () => Effect.succeed(undefined) },
    credentials: store(),
    browserSessions,
    http: { execute: () => Effect.fail(new InfrastructureError("test", "must not be called")) },
    clock,
  });

describe("browser credential fallback slice", () => {
  it("auto CLI unavailable then oauth proxy fail then missing cookie reaches oauth-grpc", async () => {
    const { runtime, counts } = grokRuntime({
      browserSessions: makeCredentialBrowserSessions(store()),
    });
    const outcome = await Effect.runPromise(
      runtime.fetch("grok", { sourceMode: "auto", includeCredits: false }),
    );
    expect(outcome.strategyId).toBe("grok.oauth-grpc");
    expect(outcome.source).toBe("oauth");
    expect(counts()).toEqual({ proxyCalls: 1, grpcCalls: 1 });
    leaked(outcome);
  });

  it.each(allowedWebFallbackKinds)(
    "auto continues from grok.web %s to oauth-grpc",
    async (kind) => {
      const { runtime, counts } = grokRuntime({
        browserSessions: { cookieHeader: () => Effect.fail(classified(kind)) },
      });
      const outcome = await Effect.runPromise(
        runtime.fetch("grok", { sourceMode: "auto", includeCredits: false }),
      );
      expect(outcome.strategyId).toBe("grok.oauth-grpc");
      expect(counts().grpcCalls).toBe(1);
      leaked(outcome);
    },
  );

  it.each(allowedWebFallbackKinds)("explicit web stops on %s without later HTTP", async (kind) => {
    const { runtime, counts } = grokRuntime({
      browserSessions: { cookieHeader: () => Effect.fail(classified(kind)) },
    });
    await expect(
      Effect.runPromise(runtime.fetch("grok", { sourceMode: "web", includeCredits: false })),
    ).rejects.toMatchObject({ kind });
    expect(counts()).toEqual({ proxyCalls: 0, grpcCalls: 0 });
  });

  it("explicit web missing cookie is terminal missing-credential", async () => {
    const { runtime, counts } = grokRuntime({
      browserSessions: makeCredentialBrowserSessions(store()),
    });
    await expect(
      Effect.runPromise(runtime.fetch("grok", { sourceMode: "web", includeCredits: false })),
    ).rejects.toMatchObject({ kind: "missing-credential" });
    expect(counts()).toEqual({ proxyCalls: 0, grpcCalls: 0 });
  });

  it("absent stored browser credential maps to missing-credential", async () => {
    const browserSessions = makeCredentialBrowserSessions(store());
    await expect(
      Effect.runPromise(browserSessions.cookieHeader("claude", "claude.ai")),
    ).rejects.toBeInstanceOf(MissingBrowserCredentialError);
    await expect(
      Effect.runPromise(browserSessions.cookieHeader("claude", "claude.ai")),
    ).rejects.toMatchObject({ message: missingCredentialMessage });
    const error = await Effect.runPromise(
      claudeRuntime(browserSessions)
        .fetch("claude", { sourceMode: "auto", includeCredits: false })
        .pipe(Effect.flip),
    );
    expect(error).toMatchObject({ kind: "missing-credential", message: missingCredentialMessage });
    expect(leaked(error)).not.toContain("claude");
  });

  it.each([
    ["corrupt JSON", "not-json"],
    ["domain missing", storedBrowserSession("claude", "default", { "other.example": "session=x" })],
  ] as const)("%s stored credential stays api-failure", async (_label, stored) => {
    const browserSessions = makeCredentialBrowserSessions(store(() => Effect.succeed(stored)));
    await expect(
      Effect.runPromise(browserSessions.cookieHeader("claude", "claude.ai")),
    ).rejects.toMatchObject({
      _tag: "InfrastructureError",
      message: "Stored browser credential is invalid",
    });
    const error = await Effect.runPromise(
      claudeRuntime(browserSessions)
        .fetch("claude", { sourceMode: "auto", includeCredits: false })
        .pipe(Effect.flip),
    );
    expect(error).toMatchObject({ kind: "api-failure" });
    expect(error).not.toMatchObject({ _tag: "MissingBrowserCredentialError" });
    leaked(error);
  });

  it("keyring failures stay api-failure", async () => {
    const browserSessions = makeCredentialBrowserSessions(
      store(() =>
        Effect.fail(new InfrastructureError("keyring", "Unable to read stored credential")),
      ),
    );
    await expect(
      Effect.runPromise(browserSessions.cookieHeader("claude", "claude.ai")),
    ).rejects.toMatchObject({ _tag: "InfrastructureError" });
    await expect(
      Effect.runPromise(
        claudeRuntime(browserSessions).fetch("claude", {
          sourceMode: "auto",
          includeCredits: false,
        }),
      ),
    ).rejects.toMatchObject({ kind: "api-failure" });
  });

  it("AbortError from cookie lookup is interrupt and never reaches oauth-grpc", async () => {
    const { runtime, counts } = grokRuntime({
      browserSessions: {
        cookieHeader: () => Effect.fail(new DOMException("aborted", "AbortError")),
      },
    });
    const exit = await Effect.runPromiseExit(
      runtime.fetch("grok", { sourceMode: "auto", includeCredits: false }),
    );
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    expect(counts().grpcCalls).toBe(0);
  });

  it("AbortSignal cancellation is interrupt and makes no later HTTP call", async () => {
    const controller = new AbortController();
    let startedResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const { runtime, counts } = grokRuntime({
      browserSessions: {
        cookieHeader: () =>
          Effect.tryPromise({
            try: (signal) => {
              startedResolve?.();
              return new Promise((_resolve, reject) =>
                signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
              );
            },
            catch: (error) => new InfrastructureError("cookie lookup", "aborted", error),
          }),
      },
    });
    const pending = Effect.runPromiseExit(
      runtime.fetch("grok", { sourceMode: "auto", includeCredits: false }),
      { signal: controller.signal },
    );
    await started;
    controller.abort(new DOMException("cancelled", "AbortError"));
    const exit = await pending;
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    expect(counts().grpcCalls).toBe(0);
  });

  it("does not treat an unrelated CanceledError name as cancellation", async () => {
    const { runtime, counts } = grokRuntime({
      browserSessions: {
        cookieHeader: () =>
          Effect.fail(Object.assign(new Error("canceled"), { name: "CanceledError" })),
      },
    });
    const outcome = await Effect.runPromise(
      runtime.fetch("grok", { sourceMode: "auto", includeCredits: false }),
    );
    expect(outcome.strategyId).toBe("grok.oauth-grpc");
    expect(counts().grpcCalls).toBe(1);
  });

  it("redacts token, cookie, and path from outcomes and errors", async () => {
    const present = makeCredentialBrowserSessions(
      store(() =>
        Effect.succeed(
          storedBrowserSession("claude", "default", {
            "claude.ai": `sessionKey=${cookieSecret}`,
          }),
        ),
      ),
    );
    expect(await Effect.runPromise(present.cookieHeader("claude", "claude.ai"))).toBe(
      `sessionKey=${cookieSecret}`,
    );
    const malformed = makeCredentialBrowserSessions(store(() => Effect.succeed("{ not json")));
    const error = await Effect.runPromise(
      claudeRuntime(malformed)
        .fetch("claude", { sourceMode: "auto", includeCredits: false })
        .pipe(Effect.flip),
    );
    leaked(error);
    expect(error.message).toBe("Stored browser credential is invalid");
  });
});
