import { describe, expect, it } from "vite-plus/test";
import { Cause, Effect, Exit } from "effect";
import { InfrastructureError, type HttpRequest, type HttpResponse } from "@codexbar/core";
import { openrouter, type FirstPartyProvider } from "@codexbar/providers";
import { makeFirstPartyProviderRuntime } from "../src/first-party-runtime.ts";

const clock = { now: Effect.succeed(Date.parse("2026-08-25T12:00:00Z")), sleep: () => Effect.void };

const selectedAccount = {
  id: "openrouter-selected",
  secureSettings: { OPENROUTER_API_KEY: "selected-key" },
} as const;

const response = (request: HttpRequest, body: unknown, status = 200): HttpResponse => ({
  status,
  headers: { "content-type": "application/json" },
  body: new TextEncoder().encode(JSON.stringify(body)),
  url: request.url,
});

const fixtureResponse = (request: HttpRequest): HttpResponse => {
  const url = new URL(request.url);
  if (url.pathname.endsWith("/credits")) {
    return response(request, { data: { total_credits: 100, total_usage: 25 } });
  }
  if (url.pathname.endsWith("/key")) {
    return response(request, {
      data: {
        limit: 100,
        limit_remaining: 75,
        usage: 25,
        usage_daily: 1,
        usage_weekly: 2,
        usage_monthly: 3,
        limit_reset: "monthly",
        rate_limit: { requests: 100, interval: "10s" },
      },
    });
  }
  return response(request, { data: [] });
};

const makeRuntime = (
  requests: HttpRequest[],
  options: {
    readonly managementKey?: string;
    readonly provider?: FirstPartyProvider;
    readonly execute?: (request: HttpRequest) => Effect.Effect<HttpResponse, InfrastructureError>;
  } = {},
) => {
  const settingsReads: string[] = [];
  const credentialReads: string[] = [];
  const settings: Readonly<Record<string, string | undefined>> = {
    OPENROUTER_MANAGEMENT_API_KEY: options.managementKey,
    OPENROUTER_API_URL: "https://router.example.test/gateway/v1",
    OPENROUTER_HTTP_REFERER: "https://codexbar.example.test",
    OPENROUTER_X_TITLE: "CodexBar Multi",
  };
  const runtime = makeFirstPartyProviderRuntime({
    providers: [options.provider ?? openrouter],
    settings: {
      read: (_provider, key) => {
        settingsReads.push(key);
        return key === "OPENROUTER_API_KEY"
          ? Effect.die("selected account must suppress the ambient OpenRouter API key")
          : Effect.succeed(settings[key]);
      },
    },
    selectedAccounts: { resolve: () => Effect.succeed(selectedAccount) },
    browserSessions: { cookieHeader: () => Effect.succeed("") },
    credentials: {
      read: (key) => {
        credentialReads.push(key);
        return key.endsWith("/OPENROUTER_API_KEY")
          ? Effect.die("selected account must suppress the keyring OpenRouter API key")
          : Effect.succeed(undefined);
      },
      write: () => Effect.void,
      remove: () => Effect.void,
    },
    http: {
      execute: (request) => {
        requests.push(request);
        return options.execute?.(request) ?? Effect.succeed(fixtureResponse(request));
      },
    },
    clock,
  });
  return { runtime, settingsReads, credentialReads };
};

describe("first-party runtime selected OpenRouter accounts", () => {
  it.each(["auto", "api"] as const)(
    "isolates the selected key and pins global management auth under %s source",
    async (sourceMode) => {
      const requests: HttpRequest[] = [];
      const { runtime, settingsReads, credentialReads } = makeRuntime(requests, {
        managementKey: "management-key",
      });
      const outcome = await Effect.runPromise(
        runtime.fetch("openrouter", { sourceMode, includeCredits: false }),
      );
      expect(outcome.strategyId).toBe("openrouter.api");
      expect(outcome.snapshot).toMatchObject({
        primary: { usedPercent: 25 },
        identity: { providerId: "openrouter", loginMethod: "Balance: $75.00" },
      });
      expect(requests).toHaveLength(4);
      const accountRequests = requests.filter(
        ({ url }) => new URL(url).hostname === "router.example.test",
      );
      const activityRequests = requests.filter(
        ({ url }) => new URL(url).pathname === "/api/v1/activity",
      );
      expect(accountRequests.map(({ url }) => new URL(url).pathname)).toEqual([
        "/gateway/v1/credits",
        "/gateway/v1/key",
      ]);
      expect(
        accountRequests.every(({ headers }) => headers?.Authorization === "Bearer selected-key"),
      ).toBe(true);
      expect(activityRequests).toHaveLength(2);
      expect(
        activityRequests.every(
          ({ url, headers }) =>
            new URL(url).origin === "https://openrouter.ai" &&
            headers?.Authorization === "Bearer management-key",
        ),
      ).toBe(true);
      expect(settingsReads).not.toContain("OPENROUTER_API_KEY");
      expect(credentialReads).not.toContain("provider/openrouter/secret/OPENROUTER_API_KEY");
      expect(JSON.stringify(outcome)).not.toContain("selected-key");
      expect(JSON.stringify(outcome)).not.toContain("management-key");
    },
  );

  it.each(["web", "cli", "oauth"] as const)(
    "keeps a selected OpenRouter API account terminal under %s source",
    async (sourceMode) => {
      const requests: HttpRequest[] = [];
      const { runtime } = makeRuntime(requests, { managementKey: "management-key" });
      await expect(
        Effect.runPromise(runtime.fetch("openrouter", { sourceMode, includeCredits: false })),
      ).rejects.toMatchObject({ name: "NoAvailableStrategy", providerId: "openrouter" });
      expect(requests).toHaveLength(0);
    },
  );

  it("keeps Activity disabled when the independent management key is absent", async () => {
    const requests: HttpRequest[] = [];
    const { runtime } = makeRuntime(requests);
    const outcome = await Effect.runPromise(
      runtime.fetch("openrouter", { sourceMode: "auto", includeCredits: false }),
    );
    expect(requests).toHaveLength(2);
    expect(requests.every(({ headers }) => headers?.Authorization === "Bearer selected-key")).toBe(
      true,
    );
    expect(outcome.snapshot.details).toContainEqual({
      title: "Spend history",
      rows: [
        {
          label: "Last 30 days",
          value: "Unavailable right now",
          secondaryValue: "Management API key not configured",
        },
      ],
    });
  });

  it("redacts selected and global management credentials from transport failures", async () => {
    const requests: HttpRequest[] = [];
    const { runtime } = makeRuntime(requests, {
      managementKey: "management-key",
      execute: () =>
        Effect.fail(
          new InfrastructureError(
            "test transport",
            "selected-key and management-key were rejected",
          ),
        ),
    });
    const error = await Effect.runPromise(
      Effect.flip(runtime.fetch("openrouter", { sourceMode: "auto", includeCredits: false })),
    );
    expect(requests).toHaveLength(1);
    expect(error).toMatchObject({ kind: "network-failure" });
    expect(error.message).toContain("[REDACTED]");
    expect(error.message).not.toContain("selected-key");
    expect(error.message).not.toContain("management-key");
  });

  it("rejects management auth outside the pinned official Activity endpoint", async () => {
    const probe: FirstPartyProvider = {
      id: "openrouter.api",
      kind: "api",
      descriptor: {
        id: "openrouter",
        name: "OpenRouter management auth probe",
        status: "partial",
        endpoints: ["https://proxy.example.test"],
        auth: { type: "bearer", secret: "OPENROUTER_API_KEY" },
        settings: [
          { key: "OPENROUTER_API_KEY", title: "API key", type: "secure" },
          {
            key: "OPENROUTER_MANAGEMENT_API_KEY",
            title: "Management key",
            type: "secure",
          },
        ],
      },
      fetchUsage: async (context) => {
        await context.http.get("https://proxy.example.test/api/v1/activity", {
          openRouterManagementAuth: true,
        });
        return {};
      },
    };
    const requests: HttpRequest[] = [];
    const { runtime } = makeRuntime(requests, { managementKey: "management-key", provider: probe });
    await expect(
      Effect.runPromise(runtime.fetch("openrouter", { sourceMode: "auto", includeCredits: false })),
    ).rejects.toMatchObject({ kind: "permission-denied" });
    expect(requests).toHaveLength(0);
  });

  it("rejects OpenRouter management auth requested by another provider", async () => {
    const probe: FirstPartyProvider = {
      id: "deepseek.api",
      kind: "api",
      descriptor: {
        id: "deepseek",
        name: "Foreign management auth probe",
        status: "partial",
        endpoints: ["https://openrouter.ai"],
        auth: { type: "bearer", secret: "DEEPSEEK_API_KEY" },
        settings: [
          { key: "DEEPSEEK_API_KEY", title: "API key", type: "secure" },
          {
            key: "OPENROUTER_MANAGEMENT_API_KEY",
            title: "Management key",
            type: "secure",
          },
        ],
      },
      fetchUsage: async (context) => {
        await context.http.get("https://openrouter.ai/api/v1/activity", {
          openRouterManagementAuth: true,
        });
        return {};
      },
    };
    const requests: HttpRequest[] = [];
    const runtime = makeFirstPartyProviderRuntime({
      providers: [probe],
      settings: {
        read: (_provider, key) =>
          Effect.succeed(
            key === "DEEPSEEK_API_KEY"
              ? "foreign-key"
              : key === "OPENROUTER_MANAGEMENT_API_KEY"
                ? "management-key"
                : undefined,
          ),
      },
      browserSessions: { cookieHeader: () => Effect.succeed("") },
      credentials: {
        read: () => Effect.succeed(undefined),
        write: () => Effect.void,
        remove: () => Effect.void,
      },
      http: {
        execute: (request) => {
          requests.push(request);
          return Effect.succeed(fixtureResponse(request));
        },
      },
      clock,
    });
    await expect(
      Effect.runPromise(runtime.fetch("deepseek", { sourceMode: "auto", includeCredits: false })),
    ).rejects.toMatchObject({ kind: "permission-denied" });
    expect(requests).toHaveLength(0);
  });

  it("rejects OpenRouter management auth on the binary transport", async () => {
    const probe: FirstPartyProvider = {
      id: "openrouter.api",
      kind: "api",
      descriptor: {
        id: "openrouter",
        name: "OpenRouter binary management auth probe",
        status: "partial",
        endpoints: ["https://openrouter.ai"],
        auth: { type: "bearer", secret: "OPENROUTER_API_KEY" },
        settings: [
          { key: "OPENROUTER_API_KEY", title: "API key", type: "secure" },
          {
            key: "OPENROUTER_MANAGEMENT_API_KEY",
            title: "Management key",
            type: "secure",
          },
        ],
      },
      fetchUsage: async (context) => {
        await (
          context.http.postBinary as unknown as (
            url: string,
            options: Record<string, unknown>,
          ) => Promise<unknown>
        )("https://openrouter.ai/api/v1/activity", {
          body: new Uint8Array(),
          openRouterManagementAuth: true,
        });
        return {};
      },
    };
    const requests: HttpRequest[] = [];
    const { runtime } = makeRuntime(requests, { managementKey: "management-key", provider: probe });
    await expect(
      Effect.runPromise(runtime.fetch("openrouter", { sourceMode: "auto", includeCredits: false })),
    ).rejects.toMatchObject({ kind: "permission-denied" });
    expect(requests).toHaveLength(0);
  });

  it("degrades an Activity timeout without treating it as cancellation", async () => {
    const requests: HttpRequest[] = [];
    const { runtime } = makeRuntime(requests, {
      managementKey: "management-key",
      execute: (request) =>
        new URL(request.url).hostname === "router.example.test"
          ? Effect.succeed(fixtureResponse(request))
          : Effect.fail(new InfrastructureError("HTTP request", "Activity request timed out")),
    });
    const outcome = await Effect.runPromise(
      runtime.fetch("openrouter", { sourceMode: "auto", includeCredits: false }),
    );
    expect(requests).toHaveLength(4);
    expect(outcome.snapshot.details).toContainEqual({
      title: "Spend history",
      rows: [
        {
          label: "Last 30 days",
          value: "Unavailable right now",
          secondaryValue: "Request timed out",
        },
      ],
    });
  });

  it("cancels the selected account request without starting optional enrichment", async () => {
    const requests: HttpRequest[] = [];
    const controller = new AbortController();
    let startedResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const { runtime } = makeRuntime(requests, {
      managementKey: "management-key",
      execute: () =>
        Effect.tryPromise({
          try: (signal) => {
            startedResolve?.();
            return new Promise<HttpResponse>((_resolve, reject) =>
              signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
            );
          },
          catch: (error) => new InfrastructureError("HTTP request", "aborted", error),
        }),
    });
    const pending = Effect.runPromiseExit(
      runtime.fetch("openrouter", { sourceMode: "auto", includeCredits: false }),
      { signal: controller.signal },
    );
    await started;
    controller.abort(new DOMException("cancelled", "AbortError"));
    const exit = await pending;
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    expect(requests).toHaveLength(1);
  });

  it("propagates cancellation during key enrichment without starting Activity", async () => {
    const requests: HttpRequest[] = [];
    const controller = new AbortController();
    let keyStartedResolve: (() => void) | undefined;
    const keyStarted = new Promise<void>((resolve) => {
      keyStartedResolve = resolve;
    });
    const { runtime } = makeRuntime(requests, {
      managementKey: "management-key",
      execute: (request) => {
        if (new URL(request.url).pathname.endsWith("/credits")) {
          return Effect.succeed(fixtureResponse(request));
        }
        return Effect.tryPromise({
          try: (signal) => {
            keyStartedResolve?.();
            return new Promise<HttpResponse>((_resolve, reject) =>
              signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
            );
          },
          catch: (error) => new InfrastructureError("HTTP request", "aborted", error),
        });
      },
    });
    const pending = Effect.runPromiseExit(
      runtime.fetch("openrouter", { sourceMode: "auto", includeCredits: false }),
      { signal: controller.signal },
    );
    await keyStarted;
    controller.abort(new DOMException("cancelled", "AbortError"));
    const exit = await pending;
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    expect(requests.map(({ url }) => new URL(url).pathname)).toEqual([
      "/gateway/v1/credits",
      "/gateway/v1/key",
    ]);
  });

  it("propagates cancellation during Activity instead of returning a degraded snapshot", async () => {
    const requests: HttpRequest[] = [];
    const controller = new AbortController();
    let activityStartedCount = 0;
    let activityStartedResolve: (() => void) | undefined;
    const activityStarted = new Promise<void>((resolve) => {
      activityStartedResolve = resolve;
    });
    const { runtime } = makeRuntime(requests, {
      managementKey: "management-key",
      execute: (request) => {
        if (new URL(request.url).hostname === "router.example.test") {
          return Effect.succeed(fixtureResponse(request));
        }
        return Effect.tryPromise({
          try: (signal) => {
            activityStartedCount += 1;
            if (activityStartedCount === 2) activityStartedResolve?.();
            return new Promise<HttpResponse>((_resolve, reject) =>
              signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
            );
          },
          catch: (error) => new InfrastructureError("HTTP request", "aborted", error),
        });
      },
    });
    const pending = Effect.runPromiseExit(
      runtime.fetch("openrouter", { sourceMode: "auto", includeCredits: false }),
      { signal: controller.signal },
    );
    await activityStarted;
    controller.abort(new DOMException("cancelled", "AbortError"));
    const exit = await pending;
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    expect(requests.map(({ url }) => new URL(url).pathname)).toEqual([
      "/gateway/v1/credits",
      "/gateway/v1/key",
      "/api/v1/activity",
      "/api/v1/activity",
    ]);
  });
});
