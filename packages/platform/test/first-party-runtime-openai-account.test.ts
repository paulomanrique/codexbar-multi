import { describe, expect, it } from "vite-plus/test";
import { Cause, Effect, Exit } from "effect";
import { InfrastructureError, type HttpRequest, type HttpResponse } from "@codexbar/core";
import { openai } from "@codexbar/providers";
import { makeFirstPartyProviderRuntime } from "../src/first-party-runtime.ts";

const clock = { now: Effect.succeed(Date.parse("2026-08-25T12:00:00Z")), sleep: () => Effect.void };

const selectedAccount = {
  id: "openai-selected",
  secureSettings: {
    OPENAI_ADMIN_KEY: "selected-key",
    OPENAI_API_KEY: null,
  },
  plainSettings: { OPENAI_PROJECT_ID: null },
} as const;

const response = (request: HttpRequest, body: unknown, status = 200): HttpResponse => ({
  status,
  headers: { "content-type": "application/json" },
  body: new TextEncoder().encode(JSON.stringify(body)),
  url: request.url,
});

const emptyPage = { data: [], has_more: false, next_page: null };

const runtime = (
  requests: HttpRequest[],
  execute: (request: HttpRequest) => Effect.Effect<HttpResponse, InfrastructureError> = (request) =>
    Effect.succeed(response(request, emptyPage)),
) =>
  makeFirstPartyProviderRuntime({
    providers: [openai],
    settings: {
      read: (_provider, key) =>
        key === "OPENAI_HISTORY_DAYS"
          ? Effect.succeed("1")
          : Effect.die("selected account must suppress ambient OpenAI credentials and project"),
    },
    selectedAccounts: { resolve: () => Effect.succeed(selectedAccount) },
    browserSessions: { cookieHeader: () => Effect.succeed("") },
    credentials: {
      read: () => Effect.die("selected account must suppress keyring OpenAI credentials"),
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

describe("first-party runtime selected OpenAI accounts", () => {
  it.each(["auto", "api"] as const)(
    "uses only the selected unscoped Admin key under %s source",
    async (sourceMode) => {
      const requests: HttpRequest[] = [];
      const outcome = await Effect.runPromise(
        runtime(requests).fetch("openai", { sourceMode, includeCredits: false }),
      );
      expect(outcome.strategyId).toBe("openai.api");
      expect(outcome.snapshot.identity).toMatchObject({
        providerId: "openai",
        loginMethod: "Admin API",
      });
      expect(requests).toHaveLength(2);
      expect(requests.map(({ url }) => new URL(url).pathname)).toEqual([
        "/v1/organization/costs",
        "/v1/organization/usage/completions",
      ]);
      expect(requests.every(({ url }) => !new URL(url).searchParams.has("project_ids"))).toBe(true);
      expect(
        requests.every(
          ({ headers, timeoutMs }) =>
            headers?.Authorization === "Bearer selected-key" && timeoutMs === 20_000,
        ),
      ).toBe(true);
      expect(JSON.stringify(outcome)).not.toContain("selected-key");
    },
  );

  it.each(["web", "cli", "oauth"] as const)(
    "keeps a selected OpenAI API account terminal under %s source",
    async (sourceMode) => {
      const requests: HttpRequest[] = [];
      await expect(
        Effect.runPromise(runtime(requests).fetch("openai", { sourceMode, includeCredits: false })),
      ).rejects.toMatchObject({ name: "NoAvailableStrategy", providerId: "openai" });
      expect(requests).toHaveLength(0);
    },
  );

  it("preserves the Swift billing fallback for a selected unscoped Admin key", async () => {
    const requests: HttpRequest[] = [];
    const outcome = await Effect.runPromise(
      runtime(requests, (request) =>
        Effect.succeed(
          new URL(request.url).pathname === "/v1/dashboard/billing/credit_grants"
            ? response(request, {
                total_granted: 100,
                total_used: 25,
                total_available: 75,
                grants: { data: [] },
              })
            : response(request, { error: "usage unavailable" }, 500),
        ),
      ).fetch("openai", { sourceMode: "auto", includeCredits: false }),
    );
    expect(requests.map(({ url }) => new URL(url).pathname)).toEqual([
      "/v1/organization/costs",
      "/v1/dashboard/billing/credit_grants",
    ]);
    expect(requests[1]?.timeoutMs).toBe(15_000);
    expect(requests.every(({ headers }) => headers?.Authorization === "Bearer selected-key")).toBe(
      true,
    );
    expect(outcome.snapshot).toMatchObject({
      primary: { usedPercent: 25 },
      providerCost: { used: 25, limit: 100, currencyCode: "USD" },
      identity: { providerId: "openai", loginMethod: "API balance: $75.00" },
    });
  });

  it("redacts selected OpenAI material from transport failures", async () => {
    const requests: HttpRequest[] = [];
    const error = await Effect.runPromise(
      Effect.flip(
        runtime(requests, () =>
          Effect.fail(new InfrastructureError("test transport", "selected-key rejected")),
        ).fetch("openai", { sourceMode: "auto", includeCredits: false }),
      ),
    );
    expect(requests).toHaveLength(2);
    expect(error).toMatchObject({ kind: "network-failure" });
    expect(error.message).toContain("[REDACTED]");
    expect(error.message).not.toContain("selected-key");
  });

  it("does not expose a provider HTTP error body that echoes the selected key", async () => {
    const requests: HttpRequest[] = [];
    const error = await Effect.runPromise(
      Effect.flip(
        runtime(requests, (request) =>
          Effect.succeed(response(request, { error: "Bearer selected-key rejected" }, 401)),
        ).fetch("openai", { sourceMode: "auto", includeCredits: false }),
      ),
    );
    expect(requests).toHaveLength(2);
    expect(error).toMatchObject({ kind: "api-failure" });
    expect(error.message).not.toContain("selected-key");
  });

  it("cancels the first selected request without starting billing fallback", async () => {
    const requests: HttpRequest[] = [];
    const controller = new AbortController();
    let startedResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const pending = Effect.runPromiseExit(
      runtime(requests, () =>
        Effect.tryPromise({
          try: (signal) => {
            startedResolve?.();
            return new Promise<HttpResponse>((_resolve, reject) =>
              signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
            );
          },
          catch: (error) => new InfrastructureError("HTTP request", "aborted", error),
        }),
      ).fetch("openai", { sourceMode: "auto", includeCredits: false }),
      { signal: controller.signal },
    );
    await started;
    controller.abort(new DOMException("cancelled", "AbortError"));
    const exit = await pending;
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    expect(requests).toHaveLength(1);
  });
});
