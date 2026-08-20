import { describe, expect, it } from "vite-plus/test";
import type { ProviderFetchOutcome } from "@codexbar/core";
import type { UsageSnapshot } from "@codexbar/contracts";
import {
  authorizeServeBearer,
  isLoopbackServeHost,
  makeServeHandler,
  normalizeServeHost,
  parseServeArguments,
  startServeServer,
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
});
