import { describe, expect, it, vi } from "vite-plus/test";

import {
  createApprovalBinding,
  decodePluginResponse,
  parsePluginManifest,
  PluginBrokerHost,
  PluginBrokerProtocolClient,
  PluginBrokerProtocolServer,
  PluginRuntimeError,
  PluginRuntimeLimits,
  type PluginBrokerHostOptions,
  type PluginHttpRequest,
} from "../src/index.js";

function manifest(capabilities: readonly string[] = [], cookieDomains: readonly string[] = []) {
  return parsePluginManifest(
    {
      id: "sample-plugin",
      name: "Sample",
      endpoints: ["https://api.example.com"],
      settings: [{ key: "apiKey", title: "API key", type: "secure" }],
      auth: { type: "bearer", secret: "apiKey" },
      capabilities,
      cookieDomains,
    },
    { allowsDynamicId: true },
  );
}

function hostOptions(overrides: Partial<PluginBrokerHostOptions> = {}): PluginBrokerHostOptions {
  const pluginManifest = overrides.manifest ?? manifest();
  const endpointSettings = overrides.endpointSettings ?? {};
  return {
    manifest: pluginManifest,
    endpointSettings,
    approvedBinding:
      overrides.approvedBinding ?? createApprovalBinding(pluginManifest, endpointSettings),
    resolveSecret: overrides.resolveSecret ?? (() => "very-secret-value"),
    fetch: overrides.fetch ?? (async () => new Response("ok")),
    ...(overrides.readBrowserCookies === undefined
      ? {}
      : { readBrowserCookies: overrides.readBrowserCookies }),
    ...(overrides.limits === undefined ? {} : { limits: overrides.limits }),
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
  };
}

function expectRuntimeError(kind: PluginRuntimeError["kind"]) {
  return expect.objectContaining({ kind });
}

describe("plugin broker security boundary", () => {
  it("blocks redirects and directs fetch to reject redirects", async () => {
    const fetch = vi.fn(
      async () => new Response(null, { status: 302, headers: { Location: "/next" } }),
    );
    const host = new PluginBrokerHost(hostOptions({ fetch }));

    await expect(host.request({ url: "https://api.example.com/v1" })).rejects.toMatchObject(
      expectRuntimeError("http"),
    );
    expect(fetch).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ redirect: "error" }),
    );
    host.terminate();
  });

  it("keeps authentication, cookies, and sensitive response headers host-controlled", async () => {
    const fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer very-secret-value");
      expect(headers.get("Cookie")).toBe("session=host-only");
      return new Response("ok", {
        headers: {
          Authorization: "Bearer reflected-secret",
          "Set-Cookie": "session=reflected",
          "X-Trace": "safe",
        },
      });
    });
    const pluginManifest = manifest(["browser-cookies"], ["example.com"]);
    const host = new PluginBrokerHost(
      hostOptions({
        manifest: pluginManifest,
        readBrowserCookies: (domains) => {
          expect(domains).toEqual(["example.com"]);
          return "session=host-only";
        },
        fetch,
      }),
    );

    await expect(
      host.request({
        url: "https://api.example.com/v1",
        headers: { Authorization: "guest-value" },
      }),
    ).rejects.toMatchObject(expectRuntimeError("network-policy"));
    expect(fetch).not.toHaveBeenCalled();

    const response = await host.request({
      url: "https://api.example.com/v1",
      includeBrowserCookies: true,
    });
    expect(decodePluginResponse(response)).toBe("ok");
    expect(response.headers).toMatchObject({
      authorization: "[REDACTED]",
      "set-cookie": "[REDACTED]",
      "x-trace": "safe",
    });
    host.terminate();
  });

  it("rejects a response above the 1 MiB limit without returning its body", async () => {
    const host = new PluginBrokerHost(
      hostOptions({
        fetch: async () => new Response("x".repeat(PluginRuntimeLimits.maximumResponseBytes + 1)),
      }),
    );

    await expect(host.request({ url: "https://api.example.com/large" })).rejects.toMatchObject(
      expectRuntimeError("response-too-large"),
    );
    host.terminate();
  });

  it("enforces request timeout and supports explicit cancellation", async () => {
    const pendingFetch: typeof globalThis.fetch = async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    const timedOut = new PluginBrokerHost(
      hostOptions({
        fetch: pendingFetch,
        limits: { requestTimeoutMs: 5, executionTimeoutMs: 100 },
      }),
    );
    await expect(timedOut.request({ url: "https://api.example.com/slow" })).rejects.toMatchObject(
      expectRuntimeError("timed-out"),
    );
    expect(timedOut.needsRecreation).toBe(false);
    timedOut.terminate();

    const globallyTimedOut = new PluginBrokerHost(
      hostOptions({
        fetch: pendingFetch,
        limits: { requestTimeoutMs: 100, executionTimeoutMs: 5 },
      }),
    );
    await expect(
      globallyTimedOut.request({ url: "https://api.example.com/slow" }),
    ).rejects.toMatchObject(expectRuntimeError("timed-out"));
    expect(globallyTimedOut.needsRecreation).toBe(true);

    const cancellable = new PluginBrokerHost(hostOptions({ fetch: pendingFetch }));
    const controller = new AbortController();
    const request = cancellable.request({ url: "https://api.example.com/slow" }, controller.signal);
    controller.abort();
    await expect(request).rejects.toMatchObject(expectRuntimeError("cancelled"));
    cancellable.terminate();
  });

  it("fails closed when the approved binding drifts and recreates after termination", async () => {
    const endpointSettings: Record<string, string> = { baseUrl: "https://api.example.com" };
    const pluginManifest = parsePluginManifest(
      {
        id: "sample-plugin",
        name: "Sample",
        endpoints: [{ setting: "baseUrl", policy: "https" }],
        settings: [{ key: "baseUrl", title: "Base URL", type: "plain" }],
      },
      { allowsDynamicId: true },
    );
    const approvedBinding = createApprovalBinding(pluginManifest, endpointSettings);
    const host = new PluginBrokerHost(
      hostOptions({ manifest: pluginManifest, endpointSettings, approvedBinding }),
    );
    endpointSettings.baseUrl = "https://other.example.com";

    await expect(host.request({ url: "https://api.example.com/v1" })).rejects.toMatchObject(
      expectRuntimeError("approval-drift"),
    );
    host.terminate();
    await expect(host.request({ url: "https://api.example.com/v1" })).rejects.toMatchObject(
      expectRuntimeError("terminated"),
    );
    expect(host.recreate()).toBeInstanceOf(PluginBrokerHost);
  });

  it("cancels an in-flight transport-neutral protocol request", async () => {
    const pendingFetch: typeof globalThis.fetch = async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    const host = new PluginBrokerHost(hostOptions({ fetch: pendingFetch }));
    const server = new PluginBrokerProtocolServer(host);
    let client: PluginBrokerProtocolClient;
    client = new PluginBrokerProtocolClient({
      postMessage(message) {
        void server.receive(message).then((response) => {
          if (response !== undefined) client.receive(response);
        });
      },
    });
    const controller = new AbortController();
    const request: PluginHttpRequest = { url: "https://api.example.com/slow" };
    const result = client.request(request, controller.signal);
    controller.abort();
    await expect(result).rejects.toMatchObject(expectRuntimeError("cancelled"));
    host.terminate();
  });
});
