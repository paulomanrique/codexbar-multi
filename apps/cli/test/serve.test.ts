import { describe, expect, it } from "vite-plus/test";
import type { ProviderFetchOutcome } from "@codexbar/core";
import type { UsageSnapshot } from "@codexbar/contracts";
import {
  authorizeServeBearer,
  isLoopbackServeHost,
  makeServeHandler,
  normalizeServeHost,
  parseServeArguments,
  serveCacheKey,
  ServeOperationCoordinator,
  ServeResponseCache,
  startServeServer,
  type ServeResponse,
  type ServeRequest,
  type ServeRuntime,
} from "../src/serve.ts";

const snapshot: UsageSnapshot = {
  primary: { usedPercent: 25, windowMinutes: 300, resetsAt: "2026-08-20T15:00:00Z" },
  updatedAt: "2026-08-20T12:00:00Z",
  identity: {
    providerId: "codex",
    accountEmail: "secret@example.com",
    accountId: "account-secret",
    loginMethod: "OAuth",
  },
};

const runtime = (fetch?: ServeRuntime["fetch"]): ServeRuntime => ({
  providers: [{ id: "codex", name: "Codex", status: "partial", isPrimaryProvider: true }],
  fetch:
    fetch ??
    (async (): Promise<ProviderFetchOutcome> => ({
      snapshot,
      source: "api-token",
      strategyId: "codex.test",
      attempts: [],
    })),
  costs: { list: async () => [] },
  now: () => 1_700_000_000_000,
  configFingerprint: () => "test-config",
  version: "0.1.0-test",
});

const request = (
  path: string,
  options: Partial<Omit<ServeRequest, "path" | "query" | "signal">> = {},
): ServeRequest => ({
  method: "GET",
  query: new URLSearchParams(),
  host: "127.0.0.1",
  hasDuplicateAuthorization: false,
  hasDuplicateHost: false,
  bodyBytes: 0,
  signal: new AbortController().signal,
  ...options,
  path,
});

describe("CLI serve", () => {
  it("coalesces equal route fingerprints into one source operation", async () => {
    const coordinator = new ServeOperationCoordinator<string>();
    let starts = 0;
    let release: (() => void) | undefined;
    const source = () =>
      new Promise<string>((resolve) => {
        starts += 1;
        release = () => resolve("shared");
      });
    const first = coordinator.value({
      key: "usage:all",
      fingerprint: "config-a",
      timeoutValue: "timeout",
      operation: async () => source(),
    });
    const second = coordinator.value({
      key: "usage:all",
      fingerprint: "config-a",
      timeoutValue: "timeout",
      operation: async () => source(),
    });
    expect(starts).toBe(1);
    release?.();
    await expect(first).resolves.toBe("shared");
    await expect(second).resolves.toBe("shared");
    expect(coordinator.snapshot().operationCount).toBe(0);
  });

  it("settles an already-aborted waiter immediately without retaining it", async () => {
    const coordinator = new ServeOperationCoordinator<string>();
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));
    const result = await coordinator.value({
      key: "usage:all",
      fingerprint: "config-a",
      timeoutValue: "cancelled",
      signal: controller.signal,
      operation: async () => new Promise<string>(() => {}),
    });
    expect(result).toBe("cancelled");
    expect(coordinator.snapshot()).toMatchObject({ waiterCount: 0, operationCount: 1 });
    coordinator.shutdown();
  });

  it("keeps a timed-out source owned and gives a same-fingerprint successor its late result", async () => {
    const coordinator = new ServeOperationCoordinator<string>();
    let starts = 0;
    let release: (() => void) | undefined;
    const source = () =>
      new Promise<string>((resolve) => {
        starts += 1;
        release = () => resolve("late-success");
      });
    const first = coordinator.value({
      key: "usage:all",
      fingerprint: "config-a",
      timeoutMs: 5,
      timeoutValue: "timeout",
      operation: async () => source(),
    });
    await expect(first).resolves.toBe("timeout");
    const successor = coordinator.value({
      key: "usage:all",
      fingerprint: "config-a",
      timeoutValue: "timeout",
      operation: async () => source(),
    });
    expect(starts).toBe(1);
    release?.();
    await expect(successor).resolves.toBe("late-success");
    expect(starts).toBe(1);
  });

  it("serializes a changed fingerprint behind timed-out work and cancels waiters on shutdown", async () => {
    const coordinator = new ServeOperationCoordinator<string>();
    let active = 0;
    let peak = 0;
    let release: (() => void) | undefined;
    const slow = () =>
      new Promise<string>((resolve) => {
        active += 1;
        peak = Math.max(peak, active);
        release = () => {
          active -= 1;
          resolve("old");
        };
      });
    const first = coordinator.value({
      key: "usage:all",
      fingerprint: "config-a",
      timeoutMs: 5,
      timeoutValue: "timeout-a",
      operation: async () => slow(),
    });
    await expect(first).resolves.toBe("timeout-a");
    const successor = coordinator.value({
      key: "usage:all",
      fingerprint: "config-b",
      timeoutValue: "timeout-b",
      operation: async () => "new",
    });
    expect(peak).toBe(1);
    release?.();
    await expect(successor).resolves.toBe("new");
    const shutdown = coordinator.value({
      key: "cost:all",
      fingerprint: "config-a",
      timeoutValue: "shutdown",
      operation: async () => new Promise<string>(() => {}),
    });
    coordinator.shutdown();
    await expect(shutdown).resolves.toBe("shutdown");
    expect(coordinator.snapshot()).toMatchObject({
      operationCount: 0,
      waiterCount: 0,
      isShutdown: true,
    });
  });

  it("does not start a pending operation after all of its waiters timed out", async () => {
    const coordinator = new ServeOperationCoordinator<string>();
    let releaseActive: (() => void) | undefined;
    let secondStarts = 0;
    const first = coordinator.value({
      key: "usage:all",
      fingerprint: "config-a",
      timeoutMs: 100,
      timeoutValue: "timeout-a",
      operation: async () =>
        new Promise<string>((resolve) => {
          releaseActive = () => resolve("active");
        }),
    });
    const pending = coordinator.value({
      key: "usage:all",
      fingerprint: "config-b",
      timeoutMs: 5,
      timeoutValue: "timeout-b",
      operation: async () => {
        secondStarts += 1;
        return "should-not-run";
      },
    });
    await expect(pending).resolves.toBe("timeout-b");
    releaseActive?.();
    await expect(first).resolves.toBe("active");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(secondStarts).toBe(0);
    expect(coordinator.snapshot().operationCount).toBe(0);
  });

  it("uses fresh, stale-while-revalidate, and last-good cache windows without caching failures", async () => {
    let now = 1_000;
    const cache = new ServeResponseCache(() => now);
    let count = 0;
    let releaseRefresh: (() => void) | undefined;
    const fresh = (body: string): ServeResponse => ({ status: 200, body });
    const first = await cache.response({
      key: "dashboard:all",
      fingerprint: "config-a",
      refreshIntervalSeconds: 1,
      signal: new AbortController().signal,
      makeResponse: async () => {
        count += 1;
        return fresh('{"value":"first"}');
      },
    });
    expect(first.body).toContain("first");
    now += 1_001;
    const stale = await cache.response({
      key: "dashboard:all",
      fingerprint: "config-a",
      refreshIntervalSeconds: 1,
      signal: new AbortController().signal,
      makeResponse: async () => {
        count += 1;
        return new Promise<ServeResponse>((resolve) => {
          releaseRefresh = () => resolve(fresh('{"value":"refreshed"}'));
        });
      },
    });
    expect(stale.body).toContain("first");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(count).toBe(2);
    releaseRefresh?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      (
        await cache.response({
          key: "dashboard:all",
          fingerprint: "config-a",
          refreshIntervalSeconds: 1,
          signal: new AbortController().signal,
          makeResponse: async () => fresh('{"value":"unexpected"}'),
        })
      ).body,
    ).toContain("refreshed");
    now += 300_001;
    const failure = await cache.response({
      key: "dashboard:all",
      fingerprint: "config-a",
      refreshIntervalSeconds: 1,
      signal: new AbortController().signal,
      makeResponse: async () => ({ status: 500, body: '{"error":"failed"}' }),
    });
    expect(failure.status).toBe(500);
  });

  it("does not replay last-good state across a changed effective config fingerprint", async () => {
    let now = 1_000;
    const cache = new ServeResponseCache(() => now);
    const accountA = serveCacheKey("account-a", "/usage", undefined, undefined);
    const accountB = serveCacheKey("account-b", "/usage", undefined, undefined);
    expect(accountA).not.toBe(accountB);
    await cache.response({
      key: accountA,
      fingerprint: "account-a",
      refreshIntervalSeconds: 1,
      signal: new AbortController().signal,
      makeResponse: async () => ({ status: 200, body: '{"account":"a"}' }),
    });
    now += 1_001;
    const second = await cache.response({
      key: accountB,
      fingerprint: "account-b",
      refreshIntervalSeconds: 1,
      signal: new AbortController().signal,
      makeResponse: async () => ({ status: 200, body: '{"account":"b"}' }),
    });
    expect(second.body).toContain('"b"');
    cache.shutdown();
  });

  it("defaults to loopback and enforces the upstream non-loopback token matrix", () => {
    expect(normalizeServeHost(" localhost ")).toBe("127.0.0.1");
    expect(normalizeServeHost("01.2.3.4")).toBeUndefined();
    expect(isLoopbackServeHost("127.0.0.2")).toBe(true);
    expect(parseServeArguments([])).toMatchObject({
      ok: true,
      value: { host: "127.0.0.1", port: 8080 },
    });
    expect(parseServeArguments(["--host", "0.0.0.0"])).toMatchObject({ ok: false });
    expect(parseServeArguments(["--host", "0.0.0.0", "--dashboard-token", "a"])).toMatchObject({
      ok: false,
    });
    expect(
      parseServeArguments(["--host", "0.0.0.0", "--dashboard-token", "a", "--allow-plain-http"]),
    ).toMatchObject({ ok: true });
  });

  it("prefers an environment token, rejects blanks, and compares bearer digests", () => {
    expect(
      parseServeArguments(["--dashboard-token", "flag"], { CODEXBAR_DASHBOARD_TOKEN: "env" }),
    ).toMatchObject({ ok: true, value: { dashboardToken: "env" } });
    expect(parseServeArguments([], { CODEXBAR_DASHBOARD_TOKEN: "  " })).toMatchObject({
      ok: false,
    });
    expect(authorizeServeBearer("Bearer secret", "secret")).toBe(true);
    expect(authorizeServeBearer("Bearer wrong", "secret")).toBe(false);
    expect(authorizeServeBearer(undefined, "secret")).toBe(false);
  });

  it("keeps health open, requires a bearer token for dashboard snapshots, and never accepts query tokens", async () => {
    const parsed = parseServeArguments(["--dashboard-token", "secret"]);
    if (!parsed.ok) throw new Error(parsed.message);
    const handler = makeServeHandler(parsed.value, runtime());
    expect((await handler(request("/health"))).status).toBe(200);
    expect((await handler(request("/dashboard/v1/snapshot"))).status).toBe(401);
    const query = new URLSearchParams("token=secret");
    expect((await handler({ ...request("/dashboard/v1/snapshot"), query })).status).toBe(401);
    const response = await handler(
      request("/dashboard/v1/snapshot", { authorization: "Bearer secret" }),
    );
    expect(response.status).toBe(200);
    expect(response.headers?.["Cache-Control"]).toBe("no-store");
  });

  it("gates every data route on a non-loopback bind while health remains open", async () => {
    const parsed = parseServeArguments([
      "--host",
      "0.0.0.0",
      "--dashboard-token",
      "secret",
      "--allow-plain-http",
    ]);
    if (!parsed.ok) throw new Error(parsed.message);
    const handler = makeServeHandler(parsed.value, runtime());
    expect((await handler(request("/usage"))).status).toBe(401);
    expect((await handler(request("/cost"))).status).toBe(401);
    expect((await handler(request("/health"))).status).toBe(200);
    expect((await handler(request("/usage", { authorization: "Bearer secret" }))).status).toBe(200);
  });

  it("redacts dashboard identity and keeps account responses out of HTTP caches", async () => {
    const parsed = parseServeArguments(["--dashboard-token", "secret", "--identity", "redacted"]);
    if (!parsed.ok) throw new Error(parsed.message);
    const handler = makeServeHandler(parsed.value, runtime());
    const dashboard = await handler(
      request("/dashboard/v1/snapshot", { authorization: "Bearer secret" }),
    );
    expect(dashboard.body).toContain("<redacted>");
    expect(dashboard.body).not.toContain("secret@example.com");
    const usage = await handler(request("/usage"));
    expect(usage.headers?.["Cache-Control"]).toBe("no-store");
  });

  it("rejects non-GET, invalid hosts, duplicate authorization, and request bodies before a provider fetch", async () => {
    let calls = 0;
    const parsed = parseServeArguments([]);
    if (!parsed.ok) throw new Error(parsed.message);
    const handler = makeServeHandler(
      parsed.value,
      runtime(async () => {
        calls += 1;
        throw new Error("unreachable");
      }),
    );
    expect((await handler(request("/usage", { method: "POST" }))).status).toBe(405);
    expect((await handler(request("/usage", { host: "evil.test" }))).status).toBe(400);
    expect((await handler(request("/usage", { hasDuplicateAuthorization: true }))).status).toBe(
      400,
    );
    expect((await handler(request("/usage", { bodyBytes: 4_097 }))).status).toBe(413);
    expect(calls).toBe(0);
  });

  it("bounds provider work below the outer serve deadline", async () => {
    let aborted = false;
    const parsed = parseServeArguments(["--request-timeout", "0.01"]);
    if (!parsed.ok) throw new Error(parsed.message);
    const handler = makeServeHandler(
      parsed.value,
      runtime(
        (_provider, _context, signal) =>
          new Promise((_, reject) => {
            signal?.addEventListener(
              "abort",
              () => {
                aborted = true;
                reject(signal.reason);
              },
              { once: true },
            );
          }),
      ),
    );
    const response = await handler(request("/usage"));
    expect(response.status).toBe(504);
    expect(aborted).toBe(true);
  });

  it("redacts provider failures and honors an already-cancelled request", async () => {
    let calls = 0;
    const parsed = parseServeArguments([]);
    if (!parsed.ok) throw new Error(parsed.message);
    const handler = makeServeHandler(
      parsed.value,
      runtime(async () => {
        calls += 1;
        throw new Error("upstream failed with token=must-not-cross-http");
      }),
    );
    const failed = await handler(request("/usage"));
    expect(failed.body).toContain("Provider request failed");
    expect(failed.body).not.toContain("must-not-cross-http");

    const controller = new AbortController();
    controller.abort(new Error("cancelled with secret=must-not-cross-http"));
    const cancelled = await handler({ ...request("/usage"), signal: controller.signal });
    expect(cancelled.status).toBe(500);
    expect(cancelled.body).toBe('{"error":"Request failed"}');
    expect(calls).toBe(1);
  });

  it("adapts the bounded router to a loopback Node listener", async () => {
    const started = await startServeServer(
      {
        host: "127.0.0.1",
        port: 0,
        refreshIntervalSeconds: 60,
        requestTimeoutSeconds: 1,
        allowPlainHttp: false,
        identity: "full",
      },
      runtime(),
    );
    try {
      const response = await fetch(`http://127.0.0.1:${started.port}/health`);
      expect(response.status).toBe(200);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      await expect(response.json()).resolves.toMatchObject({ status: "ok", version: "0.1.0-test" });
    } finally {
      await started.close();
    }
  });

  it("cancels live serve operations when the server lifecycle closes", async () => {
    let aborted = false;
    let sourceStarted: (() => void) | undefined;
    const waitForSource = new Promise<void>((resolve) => {
      sourceStarted = resolve;
    });
    const started = await startServeServer(
      {
        host: "127.0.0.1",
        port: 0,
        refreshIntervalSeconds: 60,
        requestTimeoutSeconds: 10,
        allowPlainHttp: false,
        identity: "full",
      },
      runtime(
        (_provider, _context, signal) =>
          new Promise((_, reject) => {
            sourceStarted?.();
            signal?.addEventListener(
              "abort",
              () => {
                aborted = true;
                reject(signal.reason);
              },
              { once: true },
            );
          }),
      ),
    );
    try {
      const response = fetch(`http://127.0.0.1:${started.port}/usage`);
      await waitForSource;
      await started.close();
      expect(aborted).toBe(true);
      await expect(response).resolves.toHaveProperty("status", 504);
    } finally {
      await started.close();
    }
  });
});
