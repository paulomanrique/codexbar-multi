import { Cause, Effect, Exit } from "effect";
import { InfrastructureError, type HttpRequest, type HttpResponse } from "@codexbar/core";
import { opencodego } from "@codexbar/providers";
import { describe, expect, it } from "vite-plus/test";
import { makeFirstPartyProviderRuntime } from "../src/first-party-runtime.ts";

const selectedCookie =
  "provider=google; auth=go-selected-session; theme=dark; __Host-auth=go-selected-host";
const expectedCookie = "auth=go-selected-session; __Host-auth=go-selected-host";
const clock = { now: Effect.succeed(Date.parse("2026-08-25T12:00:00Z")), sleep: () => Effect.void };

const response = (request: HttpRequest, body: unknown): HttpResponse => ({
  status: 200,
  headers: { "content-type": "application/json" },
  body: new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body)),
  url: request.url,
});

const pageUsage = {
  rollingUsage: { usagePercent: 15, resetInSec: 600 },
  weeklyUsage: { usagePercent: 35, resetInSec: 3600 },
};

const makeRuntime = (options: {
  readonly workspace?: string;
  readonly execute: (request: HttpRequest) => Effect.Effect<HttpResponse, InfrastructureError>;
}) =>
  makeFirstPartyProviderRuntime({
    providers: [opencodego],
    settings: {
      read: (_provider, key) => {
        if (key === "OPENCODE_API_KEY" || key === "OPENCODEGO_COOKIE") {
          return Effect.die("selected account must suppress ambient secrets");
        }
        if (key === "OPENCODEGO_WORKSPACE_ID") return Effect.succeed(options.workspace);
        return Effect.die(`unexpected setting ${key}`);
      },
    },
    selectedAccounts: {
      resolve: () =>
        Effect.succeed({
          id: "opencodego-selected",
          secureSettings: { OPENCODEGO_COOKIE: selectedCookie, OPENCODE_API_KEY: null },
        }),
    },
    browserSessions: {
      cookieHeader: () => Effect.die("selected account must suppress browser sessions"),
    },
    credentials: {
      read: () => Effect.die("selected account must suppress keyring settings"),
      write: () => Effect.void,
      remove: () => Effect.void,
    },
    http: { execute: options.execute },
    clock,
  });

const successfulResponse = (request: HttpRequest): HttpResponse =>
  response(
    request,
    new URL(request.url).pathname.endsWith("/go") ? pageUsage : { zenBalanceUSD: 7 },
  );

describe("OpenCode Go selected cookie runtime", () => {
  it.each(["auto", "web"] as const)(
    "uses only the selected web account and global workspace under %s source",
    async (sourceMode) => {
      const requests: HttpRequest[] = [];
      const runtime = makeRuntime({
        workspace: "wrk_global",
        execute: (request) => {
          requests.push(request);
          return Effect.succeed(successfulResponse(request));
        },
      });
      const outcome = await Effect.runPromise(
        runtime.fetch("opencodego", { sourceMode, includeCredits: false }),
      );
      expect(outcome).toMatchObject({
        strategyId: "opencodego.web",
        source: "web",
        snapshot: { primary: { usedPercent: 15 }, providerCost: { used: 7 } },
      });
      expect(requests).toHaveLength(2);
      expect(requests.map(({ headers }) => headers?.Cookie)).toEqual([
        expectedCookie,
        expectedCookie,
      ]);
      expect(requests.some(({ url }) => url.includes("/zen/go/v1/usage"))).toBe(false);
    },
  );

  it.each(["api", "cli", "oauth"] as const)(
    "keeps the selected web account terminal under %s source",
    async (sourceMode) => {
      let requests = 0;
      const runtime = makeRuntime({
        workspace: "wrk_global",
        execute: () => {
          requests += 1;
          return Effect.die("selected OpenCode Go source must be terminal");
        },
      });
      await expect(
        Effect.runPromise(runtime.fetch("opencodego", { sourceMode, includeCredits: false })),
      ).rejects.toMatchObject({ name: "NoAvailableStrategy", providerId: "opencodego" });
      expect(requests).toBe(0);
    },
  );

  it("discovers the workspace without changing the selected account", async () => {
    const requests: HttpRequest[] = [];
    const runtime = makeRuntime({
      execute: (request) => {
        requests.push(request);
        if (requests.length === 1) return Effect.succeed(response(request, 'id: "wrk_found"'));
        return Effect.succeed(successfulResponse(request));
      },
    });
    await Effect.runPromise(
      runtime.fetch("opencodego", { sourceMode: "auto", includeCredits: false }),
    );
    expect(requests).toHaveLength(3);
    expect(requests.every(({ headers }) => headers?.Cookie === expectedCookie)).toBe(true);
    expect(requests[1]?.url).toContain("/workspace/wrk_found/go");
  });

  it("redacts the selected header and auth values", async () => {
    const runtime = makeRuntime({
      workspace: "wrk_global",
      execute: () =>
        Effect.fail(
          new InfrastructureError(
            "OpenCode Go transport",
            `rejected ${selectedCookie}; auth go-selected-session; host go-selected-host`,
          ),
        ),
    });
    const error = await Effect.runPromise(
      Effect.flip(runtime.fetch("opencodego", { sourceMode: "auto", includeCredits: false })),
    );
    expect(error).toMatchObject({ kind: "network-failure" });
    expect(error.message).toContain("[REDACTED]");
    expect(error.message).not.toContain(selectedCookie);
    expect(error.message).not.toContain("go-selected-session");
    expect(error.message).not.toContain("go-selected-host");
  });

  it.each([
    ["workspace", undefined, 1],
    ["usage page", "wrk_global", 1],
    ["optional billing", "wrk_global", 2],
  ] as const)("propagates cancellation during %s", async (_phase, workspace, hangAt) => {
    let calls = 0;
    let startedResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const runtime = makeRuntime({
      ...(workspace === undefined ? {} : { workspace }),
      execute: (request) => {
        calls += 1;
        if (calls < hangAt) return Effect.succeed(successfulResponse(request));
        return Effect.tryPromise({
          try: (signal) => {
            startedResolve?.();
            return new Promise<HttpResponse>((_resolve, reject) =>
              signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
            );
          },
          catch: (error) => new InfrastructureError("OpenCode Go transport", "cancelled", error),
        });
      },
    });
    const controller = new AbortController();
    const pending = Effect.runPromiseExit(
      runtime.fetch("opencodego", { sourceMode: "auto", includeCredits: false }),
      { signal: controller.signal },
    );
    await started;
    controller.abort(new DOMException("cancelled", "AbortError"));
    const exit = await pending;
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    expect(calls).toBe(hangAt);
  });
});
