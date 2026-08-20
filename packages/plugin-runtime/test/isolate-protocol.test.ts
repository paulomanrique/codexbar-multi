import { describe, expect, it, vi } from "vite-plus/test";

import {
  PluginSandboxClient,
  PluginSandboxProtocolVersion,
  PluginBrokerHost,
  PluginBrokerProtocolServer,
  PluginRuntimeError,
  createApprovalBinding,
  parsePluginManifest,
  PluginRuntimeLimits,
  type PluginSandboxRequest,
  type PluginSandboxTransport,
} from "../src/index.js";

class FakeTransport implements PluginSandboxTransport {
  readonly requests: PluginSandboxRequest[] = [];
  killed = false;
  private readonly messageListeners = new Set<(message: unknown) => void>();
  private readonly exitListeners = new Set<() => void>();

  postMessage(message: PluginSandboxRequest): void {
    this.requests.push(message);
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onExit(listener: () => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  kill(): void {
    this.killed = true;
  }

  respond(message: unknown): void {
    for (const listener of this.messageListeners) listener(message);
  }

  exit(): void {
    for (const listener of this.exitListeners) listener();
  }
}

async function posted(transport: FakeTransport, index: number) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const message = transport.requests[index];
    if (message !== undefined) return message;
    await Promise.resolve();
  }
  throw new Error("sandbox message was not posted");
}

describe("isolated plugin process protocol", () => {
  it("returns an inspected manifest from a data-only transport", async () => {
    const transport = new FakeTransport();
    const client = new PluginSandboxClient(() => transport);
    const result = client.inspect("defineProvider({})", { allowsDynamicId: true });
    const request = transport.requests[0];
    expect(request).toMatchObject({
      version: PluginSandboxProtocolVersion,
      type: "inspect",
      source: "defineProvider({})",
      options: { language: "javascript", allowsDynamicId: true },
    });
    if (request === undefined || request.type !== "inspect")
      throw new Error("inspection request was not posted");
    transport.respond({
      version: PluginSandboxProtocolVersion,
      type: "inspect-result",
      id: request.id,
      ok: true,
      plugin: {
        manifest: {
          id: "sample",
          name: "Sample",
          icon: { monogram: "S", tint: "#6B7280" },
          endpoints: [{ kind: "fixed", origin: "https://example.com" }],
          settings: [],
          capabilities: [],
          cookieDomains: [],
        },
        transpiledSource: "defineProvider({})",
      },
    });
    await expect(result).resolves.toMatchObject({ manifest: { id: "sample" } });
    client.terminate();
  });

  it("serializes inspections and execution ownership before posting to the utility transport", async () => {
    const transport = new FakeTransport();
    const client = new PluginSandboxClient(() => transport);
    const first = client.inspect("defineProvider({})", { allowsDynamicId: true });
    const second = client.inspect("defineProvider({})", { allowsDynamicId: true });
    expect(transport.requests).toHaveLength(1);
    const request = transport.requests[0];
    if (request === undefined || request.type !== "inspect")
      throw new Error("first inspection was not posted");
    transport.respond({
      version: PluginSandboxProtocolVersion,
      type: "inspect-result",
      id: request.id,
      ok: true,
      plugin: {
        manifest: {
          id: "sample",
          name: "Sample",
          icon: { monogram: "S", tint: "#6B7280" },
          endpoints: [{ kind: "fixed", origin: "https://example.com" }],
          settings: [],
          capabilities: [],
          cookieDomains: [],
        },
        transpiledSource: "defineProvider({})",
      },
    });
    await expect(first).resolves.toMatchObject({ manifest: { id: "sample" } });
    expect(transport.requests).toHaveLength(2);
    const next = transport.requests[1];
    if (next === undefined || next.type !== "inspect")
      throw new Error("second inspection was not posted");
    transport.respond({
      version: PluginSandboxProtocolVersion,
      type: "inspect-result",
      id: next.id,
      ok: true,
      plugin: {
        manifest: {
          id: "sample",
          name: "Sample",
          icon: { monogram: "S", tint: "#6B7280" },
          endpoints: [{ kind: "fixed", origin: "https://example.com" }],
          settings: [],
          capabilities: [],
          cookieDomains: [],
        },
        transpiledSource: "defineProvider({})",
      },
    });
    await expect(second).resolves.toMatchObject({ manifest: { id: "sample" } });
    client.terminate();
  });

  it("preflights declared settings into the execution request without a guest capability map", async () => {
    const transport = new FakeTransport();
    const client = new PluginSandboxClient(() => transport);
    const manifest = parsePluginManifest(
      {
        id: "sample-plugin",
        name: "Sample",
        endpoints: ["https://api.example.com"],
        settings: [{ key: "apiKey", title: "API key", type: "secure" }],
      },
      { allowsDynamicId: true },
    );
    const host = new PluginBrokerHost({
      manifest,
      endpointSettings: {},
      approvedBinding: createApprovalBinding(manifest, {}),
      resolveSecret: () => "host-secret",
      fetch: async () => new Response("ok"),
    });
    const result = client.execute(
      { manifest, transpiledSource: "defineProvider({})" },
      new PluginBrokerProtocolServer(host),
      {},
      {
        getSetting: (key, secure) => (secure && key === "apiKey" ? "host-secret" : undefined),
        getCookie: () => undefined,
      },
    );
    const execute = await posted(transport, 0);
    if (execute === undefined || execute.type !== "execute")
      throw new Error("execution was not posted");
    expect(execute.settings).toEqual({ plain: {}, secure: { apiKey: "host-secret" } });
    client.terminate();
    await expect(result).rejects.toMatchObject({ kind: "terminated" });
    host.terminate();
  });

  it("preserves an approval-drift classification across the capability protocol", async () => {
    const transport = new FakeTransport();
    const client = new PluginSandboxClient(() => transport);
    const manifest = parsePluginManifest(
      { id: "sample-plugin", name: "Sample", endpoints: ["https://api.example.com"], settings: [] },
      { allowsDynamicId: true },
    );
    const host = new PluginBrokerHost({
      manifest,
      endpointSettings: {},
      approvedBinding: createApprovalBinding(manifest, {}),
      resolveSecret: () => undefined,
      fetch: async () => new Response("ok"),
    });
    const result = client.execute(
      { manifest, transpiledSource: "defineProvider({})" },
      new PluginBrokerProtocolServer(host),
      {},
      {
        getSetting: () => {
          throw new PluginRuntimeError(
            "approval-drift",
            "plugin approval no longer matches its declared security surface",
          );
        },
        getCookie: () => undefined,
      },
    );
    const execute = await posted(transport, 0);
    if (execute === undefined || execute.type !== "execute")
      throw new Error("execution was not posted");
    transport.respond({
      version: PluginSandboxProtocolVersion,
      type: "capability-request",
      executionId: execute.id,
      id: "capability-drift",
      capability: "setting",
      key: "ignored",
      secure: false,
    });
    await Promise.resolve();
    expect(transport.requests[1]).toEqual(
      expect.objectContaining({
        type: "capability-response",
        ok: false,
        error: {
          kind: "approval-drift",
          message: "plugin approval no longer matches its declared security surface",
        },
      }),
    );
    client.terminate();
    await expect(result).rejects.toMatchObject({ kind: "terminated" });
    host.terminate();
  });

  it("does not let an active guest target queued operations by predictable IDs", async () => {
    const transport = new FakeTransport();
    const client = new PluginSandboxClient(() => transport);
    const manifest = parsePluginManifest(
      { id: "sample-plugin", name: "Sample", endpoints: ["https://api.example.com"], settings: [] },
      { allowsDynamicId: true },
    );
    const host = new PluginBrokerHost({
      manifest,
      endpointSettings: {},
      approvedBinding: createApprovalBinding(manifest, {}),
      resolveSecret: () => undefined,
      fetch: async () => new Response("ok"),
    });
    const firstSettings = vi.fn(() => "first-secret");
    const secondSettings = vi.fn(() => "second-secret");
    const first = client.execute(
      { manifest, transpiledSource: "defineProvider({})" },
      new PluginBrokerProtocolServer(host),
      {},
      { getSetting: firstSettings, getCookie: () => undefined },
    );
    const second = client.execute(
      { manifest, transpiledSource: "defineProvider({})" },
      new PluginBrokerProtocolServer(host),
      {},
      { getSetting: secondSettings, getCookie: () => undefined },
    );
    const active = await posted(transport, 0);
    if (active === undefined || active.type !== "execute")
      throw new Error("first execution was not posted");
    const queuedId = "plugin-execute-2";
    transport.respond({
      version: PluginSandboxProtocolVersion,
      type: "capability-request",
      executionId: queuedId,
      id: "forged-capability",
      capability: "setting",
      key: "apiKey",
      secure: true,
    });
    transport.respond({
      version: PluginSandboxProtocolVersion,
      type: "execute-result",
      id: queuedId,
      ok: true,
      value: { primary: { usedPercent: 1 } },
    });
    await Promise.resolve();
    expect(firstSettings).not.toHaveBeenCalled();
    expect(secondSettings).not.toHaveBeenCalled();
    expect(transport.requests).toHaveLength(1);
    client.terminate();
    await expect(first).rejects.toMatchObject({ kind: "terminated" });
    await expect(second).rejects.toMatchObject({ kind: "terminated" });
    host.terminate();
  });

  it("kills and recreates the sandbox after the global timeout", async () => {
    vi.useFakeTimers();
    try {
      const transports: FakeTransport[] = [];
      const client = new PluginSandboxClient(() => {
        const transport = new FakeTransport();
        transports.push(transport);
        return transport;
      });
      const first = client.inspect("while (true) {}", { allowsDynamicId: true });
      const sibling = client.inspect("defineProvider({})", { allowsDynamicId: true });
      const firstExpectation = expect(first).rejects.toMatchObject({ kind: "timed-out" });
      const siblingExpectation = expect(sibling).rejects.toMatchObject({ kind: "terminated" });
      await vi.advanceTimersByTimeAsync(PluginRuntimeLimits.executionTimeoutMs);
      await firstExpectation;
      await siblingExpectation;
      expect(transports[0]?.killed).toBe(true);

      const second = client.inspect("defineProvider({})", { allowsDynamicId: true });
      expect(transports).toHaveLength(2);
      transports[1]?.exit();
      await expect(second).rejects.toMatchObject({ kind: "terminated" });
      client.terminate();
    } finally {
      vi.useRealTimers();
    }
  });
});
