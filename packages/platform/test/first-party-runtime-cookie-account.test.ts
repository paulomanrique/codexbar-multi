import { describe, expect, it } from "vite-plus/test";
import { Cause, Effect, Exit } from "effect";
import { InfrastructureError, type HttpRequest, type HttpResponse } from "@codexbar/core";
import { abacus, augment, cursor, mistral } from "@codexbar/providers";
import { makeFirstPartyProviderRuntime } from "../src/first-party-runtime.ts";

const clock = { now: Effect.succeed(Date.parse("2026-08-25T12:00:00Z")), sleep: () => Effect.void };

const json = (request: HttpRequest, body: unknown, status = 200): HttpResponse => ({
  status,
  headers: { "content-type": "application/json" },
  body: new TextEncoder().encode(JSON.stringify(body)),
  url: request.url,
});

const cases = [
  {
    id: "abacus",
    provider: abacus,
    setting: "ABACUS_COOKIE_HEADER",
    cookie: "session=abacus-secret; csrf=abacus-csrf",
    response: (request: HttpRequest) =>
      request.method === "GET"
        ? json(request, {
            success: true,
            result: { totalComputePoints: 1000, computePointsLeft: 750 },
          })
        : json(request, {
            success: true,
            result: { currentTier: "Pro", nextBillingDate: "2026-09-01T00:00:00Z" },
          }),
    requestCount: 2,
  },
  {
    id: "augment",
    provider: augment,
    setting: "AUGMENT_COOKIE_HEADER",
    cookie: "session=augment-secret; csrf=augment-csrf",
    response: (request: HttpRequest) => json(request, { plan: "Pro", usage: { usedPercent: 30 } }),
    requestCount: 1,
  },
  {
    id: "cursor",
    provider: cursor,
    setting: "CURSOR_COOKIE",
    cookie: "WorkosCursorSessionToken=cursor-secret; csrf=cursor-csrf",
    response: (request: HttpRequest) =>
      new URL(request.url).pathname === "/api/auth/me"
        ? json(request, { email: "fixture@example.com", sub: "fixture" })
        : json(request, {
            billingCycleStart: "2026-08-01T00:00:00Z",
            billingCycleEnd: "2026-09-01T00:00:00Z",
            membershipType: "pro",
            individualUsage: { plan: { used: 25, limit: 100 } },
          }),
    requestCount: 2,
  },
  {
    id: "mistral",
    provider: mistral,
    setting: "MISTRAL_COOKIE_HEADER",
    cookie: "ory_session_fixture=mistral-secret; csrftoken=mistral-csrf; NEXT_LOCALE=en; consent=1",
    response: (request: HttpRequest) =>
      new URL(request.url).pathname === "/api/billing/v2/usage"
        ? json(request, { currency: "USD", completion: { models: {} }, prices: [] })
        : new URL(request.url).pathname === "/api/billing/credits"
          ? json(request, { wallet_amount: 10 })
          : json(request, [
              {
                result: {
                  data: { json: { usagePercentage: 20, resetAt: "2026-09-01T00:00:00Z" } },
                },
              },
            ]),
    requestCount: 3,
  },
] as const;

const makeRuntime = (
  entry: (typeof cases)[number],
  requests: HttpRequest[],
  execute: (request: HttpRequest) => Effect.Effect<HttpResponse, InfrastructureError> = (request) =>
    Effect.succeed(entry.response(request)),
) =>
  makeFirstPartyProviderRuntime({
    providers: [entry.provider],
    settings: {
      read: (_provider, key) =>
        key === entry.setting
          ? Effect.die("selected cookie must suppress ambient settings")
          : Effect.succeed(undefined),
    },
    selectedAccounts: {
      resolve: () =>
        Effect.succeed({
          id: `${entry.id}-selected`,
          secureSettings: { [entry.setting]: entry.cookie },
        }),
    },
    browserSessions: {
      cookieHeader: () => Effect.die("selected cookie must suppress browser sessions"),
    },
    credentials: {
      read: (key) =>
        key.endsWith(`/${entry.setting}`)
          ? Effect.die("selected cookie must suppress keyring settings")
          : Effect.succeed(undefined),
      write: () => Effect.void,
      remove: () => Effect.void,
    },
    http: {
      execute: (request) => {
        requests.push(request);
        return execute(request);
      },
    },
    clock,
  });

describe("first-party runtime selected cookie accounts", () => {
  for (const entry of cases) {
    it.each(["auto", "web"] as const)(
      `isolates the selected ${entry.id} cookie under %s source`,
      async (sourceMode) => {
        const requests: HttpRequest[] = [];
        const runtime = makeRuntime(entry, requests);
        const outcome = await Effect.runPromise(
          runtime.fetch(entry.id, { sourceMode, includeCredits: false }),
        );
        expect(outcome.strategyId).toBe(`${entry.id}.web`);
        expect(requests).toHaveLength(entry.requestCount);
        const component = entry.cookie.split("=")[1]?.split(";")[0] ?? "missing";
        expect(requests.every(({ headers }) => headers?.Cookie?.includes(component) === true)).toBe(
          true,
        );
        expect(JSON.stringify(outcome)).not.toContain(entry.cookie);
      },
    );

    it.each(["api", "cli", "oauth"] as const)(
      `keeps the selected ${entry.id} cookie terminal under %s source`,
      async (sourceMode) => {
        const requests: HttpRequest[] = [];
        const runtime = makeRuntime(entry, requests);
        await expect(
          Effect.runPromise(runtime.fetch(entry.id, { sourceMode, includeCredits: false })),
        ).rejects.toMatchObject({ name: "NoAvailableStrategy", providerId: entry.id });
        expect(requests).toHaveLength(0);
      },
    );

    it(`redacts the selected ${entry.id} cookie header and component values`, async () => {
      const requests: HttpRequest[] = [];
      const component = entry.cookie.split("=")[1]?.split(";")[0] ?? "missing";
      const runtime = makeRuntime(entry, requests, () =>
        Effect.fail(
          new InfrastructureError(
            "test transport",
            `endpoint 401 rejected ${entry.cookie} and component ${component}; locale en; consent 1`,
          ),
        ),
      );
      const error = await Effect.runPromise(
        Effect.flip(runtime.fetch(entry.id, { sourceMode: "auto", includeCredits: false })),
      );
      expect(error).toMatchObject({ kind: "network-failure" });
      expect(error.message).toContain("[REDACTED]");
      expect(error.message).not.toContain(entry.cookie);
      expect(error.message).not.toContain(component);
      expect(error.message).toContain("endpoint 401 rejected");
      expect(error.message).toContain("locale en; consent 1");
    });
  }

  for (const entry of cases) {
    it(`propagates cancellation from the required ${entry.id} request`, async () => {
      const requests: HttpRequest[] = [];
      const controller = new AbortController();
      let requestStartedResolve: (() => void) | undefined;
      const requestStarted = new Promise<void>((resolve) => {
        requestStartedResolve = resolve;
      });
      const runtime = makeRuntime(entry, requests, () =>
        Effect.tryPromise({
          try: (signal) => {
            requestStartedResolve?.();
            return new Promise<HttpResponse>((_resolve, reject) =>
              signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
            );
          },
          catch: (error) => new InfrastructureError("HTTP request", "aborted", error),
        }),
      );
      const pending = Effect.runPromiseExit(
        runtime.fetch(entry.id, { sourceMode: "auto", includeCredits: false }),
        { signal: controller.signal },
      );
      await requestStarted;
      controller.abort(new DOMException("cancelled", "AbortError"));
      const exit = await pending;
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      expect(requests).toHaveLength(1);
    });
  }

  for (const entry of cases.filter(({ id }) => id !== "augment")) {
    it(`propagates cancellation from optional ${entry.id} enrichment`, async () => {
      const requests: HttpRequest[] = [];
      const controller = new AbortController();
      let optionalStartedResolve: (() => void) | undefined;
      const optionalStarted = new Promise<void>((resolve) => {
        optionalStartedResolve = resolve;
      });
      const runtime = makeRuntime(entry, requests, (request) => {
        if (requests.length === 1) return Effect.succeed(entry.response(request));
        return Effect.tryPromise({
          try: (signal) => {
            optionalStartedResolve?.();
            return new Promise<HttpResponse>((_resolve, reject) =>
              signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
            );
          },
          catch: (error) => new InfrastructureError("HTTP request", "aborted", error),
        });
      });
      const pending = Effect.runPromiseExit(
        runtime.fetch(entry.id, { sourceMode: "auto", includeCredits: false }),
        { signal: controller.signal },
      );
      await optionalStarted;
      controller.abort(new DOMException("cancelled", "AbortError"));
      const exit = await pending;
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      expect(requests).toHaveLength(2);
    });
  }

  it("propagates cancellation from Mistral Vibe enrichment", async () => {
    const entry = cases[3];
    const requests: HttpRequest[] = [];
    const controller = new AbortController();
    let vibeStartedResolve: (() => void) | undefined;
    const vibeStarted = new Promise<void>((resolve) => {
      vibeStartedResolve = resolve;
    });
    const runtime = makeRuntime(entry, requests, (request) => {
      if (requests.length < 3) return Effect.succeed(entry.response(request));
      return Effect.tryPromise({
        try: (signal) => {
          vibeStartedResolve?.();
          return new Promise<HttpResponse>((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
          );
        },
        catch: (error) => new InfrastructureError("HTTP request", "aborted", error),
      });
    });
    const pending = Effect.runPromiseExit(
      runtime.fetch(entry.id, { sourceMode: "auto", includeCredits: false }),
      { signal: controller.signal },
    );
    await vibeStarted;
    controller.abort(new DOMException("cancelled", "AbortError"));
    const exit = await pending;
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    expect(requests).toHaveLength(3);
  });
});
