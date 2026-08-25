import { Cause, Effect, Exit } from "effect";
import { InfrastructureError, type HttpRequest, type HttpResponse } from "@codexbar/core";
import { opencode } from "@codexbar/providers";
import { describe, expect, it } from "vite-plus/test";
import { makeFirstPartyProviderRuntime } from "../src/first-party-runtime.ts";

const selectedCookie =
  "provider=google; auth=selected-session; theme=dark; __Host-auth=selected-host";
const expectedCookie = "auth=selected-session; __Host-auth=selected-host";
const clock = { now: Effect.succeed(Date.parse("2026-08-25T12:00:00Z")), sleep: () => Effect.void };

const response = (request: HttpRequest, body: unknown): HttpResponse => ({
  status: 200,
  headers: { "content-type": "application/json" },
  body: new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body)),
  url: request.url,
});

const subscription = {
  rollingUsage: { usagePercent: 12.5, resetInSec: 600 },
  weeklyUsage: { usagePercent: 40, resetInSec: 7200 },
};

const makeRuntime = (options: {
  readonly workspace?: string;
  readonly execute: (request: HttpRequest) => Effect.Effect<HttpResponse, InfrastructureError>;
}) =>
  makeFirstPartyProviderRuntime({
    providers: [opencode],
    settings: {
      read: (_provider, key) => {
        if (key === "OPENCODE_COOKIE") return Effect.die("selected cookie must suppress settings");
        if (key === "OPENCODE_WORKSPACE_ID") return Effect.succeed(options.workspace);
        return Effect.die(`unexpected setting ${key}`);
      },
    },
    selectedAccounts: {
      resolve: () =>
        Effect.succeed({
          id: "opencode-selected",
          secureSettings: { OPENCODE_COOKIE: selectedCookie },
        }),
    },
    browserSessions: {
      cookieHeader: () => Effect.die("selected cookie must suppress browser sessions"),
    },
    credentials: {
      read: () => Effect.die("selected cookie must suppress keyring settings"),
      write: () => Effect.void,
      remove: () => Effect.void,
    },
    http: { execute: options.execute },
    clock,
  });

describe("OpenCode selected cookie runtime", () => {
  it.each(["auto", "web"] as const)(
    "uses only the selected cookie and global workspace under %s source",
    async (sourceMode) => {
      const requests: HttpRequest[] = [];
      const runtime = makeRuntime({
        workspace: "wrk_global",
        execute: (request) => {
          requests.push(request);
          return Effect.succeed(response(request, subscription));
        },
      });
      const outcome = await Effect.runPromise(
        runtime.fetch("opencode", { sourceMode, includeCredits: false }),
      );
      expect(outcome).toMatchObject({
        strategyId: "opencode.web",
        source: "web",
        snapshot: { primary: { usedPercent: 12.5 }, secondary: { usedPercent: 40 } },
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.headers?.Cookie).toBe(expectedCookie);
      expect(new URL(requests[0]?.url ?? "").searchParams.get("args")).toBe('["wrk_global"]');
    },
  );

  it.each(["api", "cli", "oauth"] as const)(
    "keeps the selected cookie terminal under %s source",
    async (sourceMode) => {
      let requests = 0;
      const runtime = makeRuntime({
        workspace: "wrk_global",
        execute: () => {
          requests += 1;
          return Effect.die("selected OpenCode source must be terminal");
        },
      });
      await expect(
        Effect.runPromise(runtime.fetch("opencode", { sourceMode, includeCredits: false })),
      ).rejects.toMatchObject({ name: "NoAvailableStrategy", providerId: "opencode" });
      expect(requests).toBe(0);
    },
  );

  it("discovers the workspace with the same filtered selected cookie", async () => {
    const requests: HttpRequest[] = [];
    const runtime = makeRuntime({
      execute: (request) => {
        requests.push(request);
        return Effect.succeed(
          response(request, requests.length === 1 ? '{"id":"wrk_discovered"}' : subscription),
        );
      },
    });
    await Effect.runPromise(
      runtime.fetch("opencode", { sourceMode: "auto", includeCredits: false }),
    );
    expect(requests).toHaveLength(2);
    expect(requests.map(({ headers }) => headers?.Cookie)).toEqual([
      expectedCookie,
      expectedCookie,
    ]);
    expect(new URL(requests[1]?.url ?? "").searchParams.get("args")).toBe('["wrk_discovered"]');
  });

  it("falls back from subscription shape to billing without changing account", async () => {
    const requests: HttpRequest[] = [];
    const runtime = makeRuntime({
      workspace: "wrk_global",
      execute: (request) => {
        requests.push(request);
        return Effect.succeed(
          response(
            request,
            requests.length === 1
              ? null
              : {
                  customerID: "cus_fixture",
                  monthlyUsage: 1_250_000_000,
                  monthlyLimit: 50,
                  balance: 750_000_000,
                  subscription: null,
                },
          ),
        );
      },
    });
    const outcome = await Effect.runPromise(
      runtime.fetch("opencode", { sourceMode: "auto", includeCredits: false }),
    );
    expect(outcome.snapshot.providerCost).toMatchObject({
      used: 12.5,
      limit: 50,
      currencyCode: "USD",
      period: "Monthly",
      balance: 7.5,
    });
    expect(requests).toHaveLength(2);
    expect(requests.every(({ headers }) => headers?.Cookie === expectedCookie)).toBe(true);
  });

  it("executes the raw subscription POST through the composed runtime", async () => {
    const requests: HttpRequest[] = [];
    const runtime = makeRuntime({
      workspace: "wrk_global",
      execute: (request) => {
        requests.push(request);
        if (request.method === "GET") return Effect.succeed(response(request, { ok: true }));
        expect(request.method).toBe("POST");
        expect(new URL(request.url).search).toBe("");
        expect(request.headers?.["Content-Type"]).toBe("application/json");
        expect(new TextDecoder().decode(request.body)).toBe('["wrk_global"]');
        return Effect.succeed(response(request, subscription));
      },
    });
    const outcome = await Effect.runPromise(
      runtime.fetch("opencode", { sourceMode: "auto", includeCredits: false }),
    );
    expect(outcome.snapshot.primary?.usedPercent).toBe(12.5);
    expect(requests.map(({ method }) => method)).toEqual(["GET", "POST"]);
  });

  it("redacts the selected header and both auth values", async () => {
    const runtime = makeRuntime({
      workspace: "wrk_global",
      execute: () =>
        Effect.fail(
          new InfrastructureError(
            "OpenCode transport",
            `rejected ${selectedCookie}; auth selected-session; host selected-host`,
          ),
        ),
    });
    const error = await Effect.runPromise(
      Effect.flip(runtime.fetch("opencode", { sourceMode: "auto", includeCredits: false })),
    );
    expect(error).toMatchObject({ kind: "network-failure" });
    expect(error.message).toContain("[REDACTED]");
    expect(error.message).not.toContain(selectedCookie);
    expect(error.message).not.toContain("selected-session");
    expect(error.message).not.toContain("selected-host");
  });

  it.each([
    ["workspace", undefined, 1],
    ["subscription", "wrk_global", 1],
    ["billing", "wrk_global", 2],
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
        if (calls < hangAt) return Effect.succeed(response(request, null));
        return Effect.tryPromise({
          try: (signal) => {
            startedResolve?.();
            return new Promise<HttpResponse>((_resolve, reject) =>
              signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
            );
          },
          catch: (error) => new InfrastructureError("OpenCode transport", "cancelled", error),
        });
      },
    });
    const controller = new AbortController();
    const pending = Effect.runPromiseExit(
      runtime.fetch("opencode", { sourceMode: "auto", includeCredits: false }),
      { signal: controller.signal },
    );
    await started;
    controller.abort(new DOMException("cancelled", "AbortError"));
    const exit = await pending;
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    expect(calls).toBe(hangAt);
  });
});
