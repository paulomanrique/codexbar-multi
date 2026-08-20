import { describe, expect, it, vi } from "vite-plus/test";

import {
  approvalMatches,
  createApprovalBinding,
  decodePluginResponse,
  inspectPlugin,
  parsePluginManifest,
  PluginBrokerHost,
  PluginRuntimeLimits,
  QuickJsPluginExecution,
  type PluginBrokerHostOptions,
} from "../src/index.js";
import {
  fixtureApprovalBinding,
  fixtureSnapshotGolden,
  typedFixtureSource,
} from "./fixtures/upstream-plugin-goldens.js";

function baseManifest() {
  return {
    id: "fixture-meter",
    name: "Fixture Meter",
    endpoints: ["https://api.fixture.test"],
    settings: [{ key: "API_KEY", title: "API key", type: "secure" }],
    auth: { type: "bearer", secret: "API_KEY" },
  };
}

function hostOptions(overrides: Partial<PluginBrokerHostOptions> = {}): PluginBrokerHostOptions {
  const manifest = overrides.manifest ?? requireManifest();
  const endpointSettings = overrides.endpointSettings ?? {};
  return {
    manifest,
    endpointSettings,
    approvedBinding: overrides.approvedBinding ?? createApprovalBinding(manifest, endpointSettings),
    resolveSecret:
      overrides.resolveSecret ?? ((name) => (name === "API_KEY" ? "fixture-secret" : undefined)),
    fetch: overrides.fetch ?? (async () => new Response("ok")),
    ...(overrides.readBrowserCookies === undefined
      ? {}
      : { readBrowserCookies: overrides.readBrowserCookies }),
    ...(overrides.limits === undefined ? {} : { limits: overrides.limits }),
  };
}

function requireManifest() {
  return parsePluginManifest(baseManifest(), { allowsDynamicId: true });
}

describe("Swift plugin oracle parity fixtures", () => {
  it("keeps the TypeScript source golden's manifest, approval binding, and output stable", async () => {
    const loaded = await inspectPlugin(typedFixtureSource, {
      language: "typescript",
      allowsDynamicId: true,
    });
    expect(loaded.transpiledSource).not.toContain("FixtureSettings");
    expect(loaded.manifest).toMatchObject({
      id: "fixture-meter",
      name: "Fixture Meter",
      icon: { monogram: "FM", tint: "#336699" },
      endpoints: [{ kind: "fixed", origin: "https://api.fixture.test" }],
    });

    const binding = createApprovalBinding(loaded.manifest, {});
    expect(binding).toEqual(fixtureApprovalBinding);

    const execution = new QuickJsPluginExecution("fixture-execution", () => undefined);
    await expect(
      execution.execute(loaded.transpiledSource, {
        settings: { plain: {}, secure: { API_KEY: "fixture-only" } },
        settingKinds: { API_KEY: "secure" },
        nowMillis: Date.parse("2026-08-20T12:00:00Z"),
      }),
    ).resolves.toEqual(fixtureSnapshotGolden);
  });

  it("keeps the public context deterministic and isolated from host globals", async () => {
    const execution = new QuickJsPluginExecution("context-fixture", () => undefined);
    await expect(
      execution.execute(`
        defineProvider({ fetchUsage(ctx) {
          const token = ctx.jwt.decode("eyJhbGciOiJub25lIn0.eyJzdWIiOiJmaXh0dXJlIn0.");
          const html = '<meta name="csrf" content="csrf-fixture"><p>credits: 37</p>';
          return { details: [{ rows: [
            { label: "jwt", value: token.sub },
            { label: "meta", value: ctx.html.metaContent(html, "csrf") },
            { label: "match", value: ctx.html.matchFirst(html, "credits: *([0-9]+)") },
            { label: "number", value: ctx.format.number(1234.5, { maximumFractionDigits: 1 }) },
            { label: "pct", value: String(ctx.pct(3, 10)) },
            { label: "globals", value: [typeof process, typeof require, typeof fetch, typeof setTimeout].join(",") },
          ] }] };
        } });
      `),
    ).resolves.toMatchObject({
      details: [
        {
          rows: [
            { value: "fixture" },
            { value: "csrf-fixture" },
            { value: "37" },
            { value: "1,234.5" },
            { value: "30" },
            { value: "undefined,undefined,undefined,undefined" },
          ],
        },
      ],
    });
  });
});

describe("plugin security parity matrix", () => {
  it.each([
    "authorization",
    "host",
    "proxy-authorization",
    "set-cookie",
    "connection",
    "content-length",
    "transfer-encoding",
    "x-api-key",
  ])("rejects guest-controlled %s request headers", async (header) => {
    const fetch = vi.fn(async () => new Response("ok"));
    const host = new PluginBrokerHost(hostOptions({ fetch }));
    await expect(
      host.request({ url: "https://api.fixture.test/usage", headers: { [header]: "guest" } }),
    ).rejects.toMatchObject({ kind: "network-policy" });
    expect(fetch).not.toHaveBeenCalled();
    host.terminate();
  });

  it("rejects URL credentials, unapproved origins, and undeclared cookie access before transport", async () => {
    const fetch = vi.fn(async () => new Response("ok"));
    const host = new PluginBrokerHost(hostOptions({ fetch }));
    for (const url of [
      "https://user:password@api.fixture.test/usage",
      "https://other.fixture.test/usage",
    ]) {
      await expect(host.request({ url })).rejects.toMatchObject({ kind: "network-policy" });
    }
    await expect(
      host.request({ url: "https://api.fixture.test/usage", includeBrowserCookies: true }),
    ).rejects.toMatchObject({ kind: "network-policy" });
    expect(fetch).not.toHaveBeenCalled();
    host.terminate();
  });

  it("fails closed on a streamed response that crosses the body limit", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(8)));
        controller.enqueue(new TextEncoder().encode("y".repeat(8)));
        controller.close();
      },
    });
    const host = new PluginBrokerHost(
      hostOptions({
        limits: { maximumResponseBytes: 10 },
        fetch: async () => new Response(body),
      }),
    );
    await expect(host.request({ url: "https://api.fixture.test/usage" })).rejects.toMatchObject({
      kind: "response-too-large",
    });
    host.terminate();
  });

  it("does not accept a stale approval binding after auth or origin changes", () => {
    const original = requireManifest();
    const binding = createApprovalBinding(original, {});
    const changedAuth = parsePluginManifest(
      {
        ...baseManifest(),
        auth: { type: "authorization-scheme", scheme: "Token", secret: "API_KEY" },
      },
      { allowsDynamicId: true },
    );
    expect(approvalMatches(binding, createApprovalBinding(changedAuth, {}))).toBe(false);
    const changedOrigin = parsePluginManifest(
      { ...baseManifest(), endpoints: ["https://other.fixture.test"] },
      { allowsDynamicId: true },
    );
    expect(approvalMatches(binding, createApprovalBinding(changedOrigin, {}))).toBe(false);
  });

  it("retains the contractual sandbox limits as a checked-in golden", () => {
    expect(PluginRuntimeLimits).toEqual({
      maximumSourceBytes: 1_048_576,
      maximumResponseBytes: 1_048_576,
      memoryBytes: 67_108_864,
      stackBytes: 2_097_152,
      executionTimeoutMs: 20_000,
      requestTimeoutMs: 15_000,
    });
  });

  it("terminates guest allocations beyond the QuickJS heap cap", async () => {
    const execution = new QuickJsPluginExecution("heap-fixture", () => undefined);
    await expect(
      execution.execute(`
        defineProvider({ fetchUsage() {
          const allocation = new Uint8Array(80 * 1024 * 1024);
          return { primary: { usedPercent: allocation[0] } };
        } });
      `),
    ).rejects.toMatchObject({ kind: "script" });
  });
});

describe("plugin transport protocol parity", () => {
  it("rejects malformed and duplicate broker messages without invoking transport twice", async () => {
    let release: ((response: Response) => void) | undefined;
    const fetch = vi.fn(
      async () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const host = new PluginBrokerHost(hostOptions({ fetch }));
    const server = new (await import("../src/index.js")).PluginBrokerProtocolServer(host);
    await expect(server.receive({ version: 1, type: "http", id: "bad" })).resolves.toBeUndefined();
    const message = {
      version: 1 as const,
      type: "http" as const,
      id: "same",
      request: { url: "https://api.fixture.test/usage" },
    };
    const first = server.receive(message);
    await Promise.resolve();
    const second = await server.receive(message);
    expect(second).toMatchObject({ ok: false, error: { kind: "network-policy" } });
    release?.(new Response("ok"));
    await first;
    expect(fetch).toHaveBeenCalledTimes(1);
    host.terminate();
  });

  it("redacts authentication response headers while preserving safe diagnostics", async () => {
    const host = new PluginBrokerHost(
      hostOptions({
        fetch: async () =>
          new Response("fixture-body", {
            headers: {
              Authorization: "Bearer fixture-secret",
              "Set-Cookie": "session=fixture-secret",
              "X-Request-ID": "request-1",
            },
          }),
      }),
    );
    const response = await host.request({ url: "https://api.fixture.test/usage" });
    expect(decodePluginResponse(response)).toBe("fixture-body");
    expect(response.headers).toEqual({
      authorization: "[REDACTED]",
      "content-type": "text/plain;charset=UTF-8",
      "set-cookie": "[REDACTED]",
      "x-request-id": "request-1",
    });
    host.terminate();
  });
});
