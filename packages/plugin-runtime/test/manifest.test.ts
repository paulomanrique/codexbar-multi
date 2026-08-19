import { describe, expect, it } from "vite-plus/test";

import {
  approvalMatches,
  createApprovalBinding,
  endpointRequiresTypedConfirmation,
  inspectPlugin,
  normalizeConfiguredOrigin,
  parsePluginManifest,
  PluginRuntimeError,
  PluginRuntimeLimits,
} from "../src/index.js";

const definition = {
  id: "sample-plugin",
  name: "Sample",
  endpoints: ["https://api.example.com/"],
  settings: [{ key: "apiKey", title: "API key", type: "secure" }],
  auth: { type: "bearer", secret: "apiKey" },
};

describe("provider plugin manifest parity", () => {
  it("normalizes the security surface used by approvals", () => {
    const manifest = parsePluginManifest(definition, { allowsDynamicId: true });
    expect(createApprovalBinding(manifest, {})).toEqual({
      instanceId: "sample-plugin",
      origins: ["https://api.example.com"],
      authMode: "bearer",
      authHeader: "Authorization",
      authSecret: "apiKey",
      secretNames: ["apiKey"],
      capabilities: [],
      cookieDomains: [],
    });
  });

  it("rejects undeclared cookie access", () => {
    expect(() =>
      parsePluginManifest(
        { ...definition, cookieDomains: ["example.com"] },
        { allowsDynamicId: true },
      ),
    ).toThrowError(PluginRuntimeError);
  });

  it("evaluates TypeScript in QuickJS without exposing Node", async () => {
    const source = `
      type Definition = Record<string, unknown>;
      defineProvider({
        id: "sample-plugin",
        name: "Sample",
        endpoints: ["https://api.example.com"],
        settings: [],
        seesProcess: typeof process !== "undefined"
      } satisfies Definition);
    `;
    const plugin = await inspectPlugin(source, { language: "typescript", allowsDynamicId: true });
    expect(plugin.manifest.id).toBe("sample-plugin");
    expect(plugin.transpiledSource).not.toContain("type Definition");
  });

  it("keeps approval tied to the complete authentication surface", () => {
    const original = parsePluginManifest(
      {
        ...definition,
        settings: [
          { key: "firstKey", title: "First API key", type: "secure" },
          { key: "secondKey", title: "Second API key", type: "secure" },
        ],
        auth: { type: "authorization-scheme", secret: "firstKey", scheme: "Token" },
      },
      { allowsDynamicId: true },
    );
    const changed = parsePluginManifest(
      {
        ...definition,
        settings: original.settings,
        auth: { type: "authorization-scheme", secret: "secondKey", scheme: "Bearer" },
      },
      { allowsDynamicId: true },
    );

    expect(
      approvalMatches(createApprovalBinding(original, {}), createApprovalBinding(changed, {})),
    ).toBe(false);
  });

  it("normalizes and requires typed confirmation for IPv6 endpoints", () => {
    expect(normalizeConfiguredOrigin("http://[::1]:80", "https-or-loopback-http")).toBe(
      "http://[::1]",
    );
    expect(normalizeConfiguredOrigin("http://[fd00::1]", "https-or-private-network-http")).toBe(
      "http://[fd00::1]",
    );
    expect(
      normalizeConfiguredOrigin("http://printer.local.", "https-or-private-network-http"),
    ).toBe("http://printer.local.");
    expect(endpointRequiresTypedConfirmation("https://[::1]")).toBe(true);
  });

  it("rejects public and non-loopback HTTP endpoint settings", () => {
    expect(() =>
      normalizeConfiguredOrigin("http://example.com", "https-or-private-network-http"),
    ).toThrowError(PluginRuntimeError);
    expect(() =>
      normalizeConfiguredOrigin("http://10.0.0.1", "https-or-loopback-http"),
    ).toThrowError(PluginRuntimeError);
  });

  it("keeps the portable runtime limits at the security contract values", async () => {
    expect(PluginRuntimeLimits).toMatchObject({
      maximumSourceBytes: 1024 * 1024,
      maximumResponseBytes: 1024 * 1024,
      memoryBytes: 64 * 1024 * 1024,
      stackBytes: 2 * 1024 * 1024,
      executionTimeoutMs: 20_000,
      requestTimeoutMs: 15_000,
    });
    await expect(
      inspectPlugin(" ".repeat(PluginRuntimeLimits.maximumSourceBytes + 1)),
    ).rejects.toMatchObject({ kind: "load" });
  });

  it("does not provide guest code with host process, timers, or module imports", async () => {
    const plugin = await inspectPlugin(
      `
      if (
        typeof process !== "undefined" ||
        typeof require !== "undefined" ||
        typeof setTimeout !== "undefined" ||
        typeof fetch !== "undefined"
      ) throw new Error("host globals leaked");
      defineProvider({
        id: "sample-plugin",
        name: "Sample",
        endpoints: ["https://api.example.com"],
        settings: []
      });
    `,
      { allowsDynamicId: true },
    );
    expect(plugin.manifest.id).toBe("sample-plugin");

    await expect(
      inspectPlugin(
        `
      import "node:fs";
      defineProvider({ id: "sample-plugin", name: "Sample", endpoints: ["https://api.example.com"], settings: [] });
    `,
        { allowsDynamicId: true },
      ),
    ).rejects.toMatchObject({ kind: "script" });
  });
});
