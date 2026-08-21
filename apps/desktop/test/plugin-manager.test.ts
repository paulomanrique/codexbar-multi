import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  inspectPlugin,
  type LoadedPlugin,
  type PluginBrokerProtocolServer,
  type PluginSandboxCapabilities,
  type PluginSandboxExecutionContext,
} from "@codexbar/plugin-runtime";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { DesktopPluginManager } from "../src/main/plugin-manager.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

type FixtureExecute = (
  plugin: Pick<LoadedPlugin, "transpiledSource" | "manifest">,
  broker: PluginBrokerProtocolServer,
  context?: PluginSandboxExecutionContext,
  capabilities?: PluginSandboxCapabilities,
) => Promise<Record<string, unknown>>;

type FixtureOptions = Pick<
  ConstructorParameters<typeof DesktopPluginManager>[0],
  | "readCookie"
  | "persistSnapshot"
  | "removeSnapshot"
  | "removeConfig"
  | "removeHistory"
  | "removeBrowserSessions"
  | "cleanupCredentials"
>;

async function fixture(
  execute: FixtureExecute = async () => ({
    primary: { usedPercent: 42 },
    identity: { loginMethod: "plugin" },
  }),
  options: FixtureOptions = {},
): Promise<{ root: string; manager: DesktopPluginManager; secrets: Map<string, string> }> {
  const root = await mkdtemp(join(tmpdir(), "codexbar-multi-plugin-manager-"));
  roots.push(root);
  const secrets = new Map<string, string>();
  return {
    root,
    secrets,
    manager: new DesktopPluginManager({
      storageRoot: root,
      sandbox: {
        inspect: inspectPlugin,
        execute,
      },
      reservedIds: new Set(["codex", "claude"]),
      readSecret: async (pluginId, key) => secrets.get(`${pluginId}/${key}`),
      writeSecret: async (pluginId, key, value) => {
        secrets.set(`${pluginId}/${key}`, value);
      },
      removeSecret: async (pluginId, key) => {
        secrets.delete(`${pluginId}/${key}`);
      },
      ...options,
    }),
  };
}

function source(id = "fixture-meter", endpoint = '"https://api.example.test"'): string {
  return `
    defineProvider({
      id: "${id}",
      name: "Fixture Meter",
      endpoints: [${endpoint}],
      settings: [],
      async fetchUsage() { return { primary: { usedPercent: 42 } }; },
    });
  `;
}

describe("desktop plugin lifecycle", () => {
  it("installs, validates, lists, approves, and removes a plugin without exposing its source", async () => {
    const { root, manager } = await fixture();
    const installed = await manager.install(source(), "javascript");
    expect(installed).toMatchObject({ id: "fixture-meter", approvalStatus: "needs-approval" });
    expect(installed).not.toHaveProperty("source");

    const preview = await manager.previewApproval("fixture-meter", {});
    expect(preview.binding.origins).toEqual(["https://api.example.test"]);
    expect(preview.typedConfirmationOrigins).toEqual([]);
    await manager.approve({ pluginId: "fixture-meter", settings: {}, typedConfirmations: {} });
    expect((await manager.list()).plugins).toMatchObject([
      { id: "fixture-meter", approvalStatus: "approved" },
    ]);
    await expect(manager.test("fixture-meter")).resolves.toMatchObject({
      pluginId: "fixture-meter",
      snapshot: {
        primary: { usedPercent: 42 },
        identity: { providerId: "fixture-meter" },
      },
    });

    const approvals = await readFile(join(root, "plugin-approvals.json"), "utf8");
    expect(approvals).not.toContain("fetchUsage");
    await manager.remove("fixture-meter");
    expect(await manager.list()).toEqual({ plugins: [], invalidFiles: [] });
  });

  it("rejects first-party collisions and duplicate ids across source languages", async () => {
    const { manager } = await fixture();
    await expect(manager.install(source("codex"), "javascript")).rejects.toThrow("collides");
    await manager.install(source(), "javascript");
    await expect(manager.install(source(), "typescript")).rejects.toThrow("already installed");
    await expect(manager.remove("../escape")).rejects.toThrow("plugin id is invalid");
  });

  it("discovers a Swift-compatible flat plugin file whose name differs from its provider id", async () => {
    const { root, manager } = await fixture();
    await mkdir(join(root, "plugins"), { recursive: true });
    await writeFile(join(root, "plugins", "Legacy Meter.ts"), source("legacy-meter"));

    await expect(manager.list()).resolves.toMatchObject({
      plugins: [{ id: "legacy-meter", language: "typescript", approvalStatus: "needs-approval" }],
      invalidFiles: [],
    });
    await manager.approve({ pluginId: "legacy-meter", settings: {}, typedConfirmations: {} });
    await expect(manager.remove("legacy-meter")).resolves.toBeUndefined();
    await expect(readFile(join(root, "plugins", "Legacy Meter.ts"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("requires exact typed confirmation for local and private-network origins", async () => {
    const { manager } = await fixture();
    const dynamicEndpoint = `{
      setting: "ENDPOINT",
      policy: "https-or-private-network-http",
    }`;
    const dynamicSource = `
      defineProvider({
        id: "private-meter",
        name: "Private Meter",
        endpoints: [${dynamicEndpoint}],
        settings: [{ key: "ENDPOINT", title: "Endpoint", type: "plain" }],
        async fetchUsage() { return { primary: { usedPercent: 1 } }; },
      });
    `;
    await manager.install(dynamicSource, "javascript");
    const settings = { ENDPOINT: "http://127.0.0.1:8080" };
    const preview = await manager.previewApproval("private-meter", settings);
    expect(preview.typedConfirmationOrigins).toEqual(["http://127.0.0.1:8080"]);
    await expect(
      manager.approve({ pluginId: "private-meter", settings, typedConfirmations: {} }),
    ).rejects.toThrow("exact typed confirmation");
    await manager.approve({
      pluginId: "private-meter",
      settings,
      typedConfirmations: { "http://127.0.0.1:8080": "http://127.0.0.1:8080" },
    });
    expect((await manager.list()).plugins[0]?.approvalStatus).toBe("approved");
  });

  it("ignores symlinks in the installed plugin directory", async () => {
    const { root, manager } = await fixture();
    await manager.list();
    const outside = join(root, "outside.js");
    await manager.install(source("outside-meter"), "javascript");
    await symlink(outside, join(root, "plugins", "linked-meter.js"));
    const result = await manager.list();
    expect(result.plugins.map((plugin) => plugin.id)).toEqual(["outside-meter"]);
  });

  it("rejects an empty sandbox result before it can cross IPC", async () => {
    const { manager } = await fixture(async () => ({}));
    await manager.install(source(), "javascript");
    await manager.approve({ pluginId: "fixture-meter", settings: {}, typedConfirmations: {} });
    await expect(manager.test("fixture-meter")).rejects.toThrow(
      "snapshot must contain at least one",
    );
  });

  it("persists only snapshots that passed the host schema mapper", async () => {
    const stored: Array<{ pluginId: string; usedPercent: number | undefined }> = [];
    const { manager } = await fixture(undefined, {
      persistSnapshot: async (pluginId, snapshot) => {
        stored.push({ pluginId, usedPercent: snapshot.primary?.usedPercent });
      },
    });
    await manager.install(source(), "javascript");
    await manager.approve({ pluginId: "fixture-meter", settings: {}, typedConfirmations: {} });
    await manager.test("fixture-meter");
    expect(stored).toEqual([{ pluginId: "fixture-meter", usedPercent: 42 }]);

    const invalid = await fixture(async () => ({}), {
      persistSnapshot: async (pluginId) => {
        stored.push({ pluginId, usedPercent: 0 });
      },
    });
    await invalid.manager.install(source("invalid-meter"), "javascript");
    await invalid.manager.approve({
      pluginId: "invalid-meter",
      settings: {},
      typedConfirmations: {},
    });
    await expect(invalid.manager.test("invalid-meter")).rejects.toThrow("snapshot must contain");
    expect(stored).toEqual([{ pluginId: "fixture-meter", usedPercent: 42 }]);
  });

  it("composes declared browser sessions only after approval and only for their domain", async () => {
    const reads: Array<{ pluginId: string; domain: string }> = [];
    const { manager } = await fixture(
      async (_plugin, _broker, _context, capabilities) => ({
        primary: {
          usedPercent:
            (await capabilities?.getCookie("api.example.test")) === "session=fixture" ? 7 : 0,
        },
      }),
      {
        readCookie: async (pluginId, domain) => {
          reads.push({ pluginId, domain });
          return "session=fixture";
        },
      },
    );
    const browserSource = `
      defineProvider({
        id: "browser-meter",
        name: "Browser Meter",
        endpoints: ["https://api.example.test"],
        capabilities: ["browser-cookies"],
        cookieDomains: ["api.example.test"],
        settings: [],
        async fetchUsage() { return { primary: { usedPercent: 1 } }; },
      });
    `;
    await manager.install(browserSource, "javascript");
    await expect(manager.test("browser-meter")).rejects.toThrow("approval");
    expect(reads).toEqual([]);
    await manager.approve({ pluginId: "browser-meter", settings: {}, typedConfirmations: {} });
    await expect(manager.test("browser-meter")).resolves.toMatchObject({
      snapshot: { primary: { usedPercent: 7 } },
    });
    expect(reads).toEqual([{ pluginId: "browser-meter", domain: "api.example.test" }]);
  });

  it("writes declared secrets without returning values and clears them on removal", async () => {
    const { manager, secrets } = await fixture();
    const secureSource = `
      defineProvider({
        id: "secret-meter",
        name: "Secret Meter",
        endpoints: ["https://api.example.test"],
        auth: { type: "bearer", secret: "TOKEN" },
        settings: [{ key: "TOKEN", title: "Token", type: "secure" }],
        async fetchUsage() { return { primary: { usedPercent: 1 } }; },
      });
    `;
    await manager.install(secureSource, "javascript");
    const configured = await manager.configureSecret({
      pluginId: "secret-meter",
      key: "TOKEN",
      operation: "set",
      value: "fixture-secret",
    });
    expect(configured).toEqual({ pluginId: "secret-meter", key: "TOKEN", configured: true });
    expect(configured).not.toHaveProperty("value");
    expect(secrets.get("secret-meter/TOKEN")).toBe("fixture-secret");
    await manager.remove("secret-meter");
    expect(secrets.has("secret-meter/TOKEN")).toBe(false);
  });

  it("removes only this plugin's state, credentials, browser sessions, config, and history", async () => {
    const cleaned: string[] = [];
    const { manager } = await fixture(undefined, {
      cleanupCredentials: async (pluginId, keys) => {
        cleaned.push(`credentials:${pluginId}:${keys.join(",")}`);
      },
      removeBrowserSessions: async (pluginId, domains) => {
        cleaned.push(`sessions:${pluginId}:${domains.join(",")}`);
      },
      removeSnapshot: async (pluginId) => {
        cleaned.push(`snapshot:${pluginId}`);
      },
      removeConfig: async (pluginId) => {
        cleaned.push(`config:${pluginId}`);
      },
      removeHistory: async (pluginId) => {
        cleaned.push(`history:${pluginId}`);
      },
    });
    const removable = `
      defineProvider({
        id: "delete-meter",
        name: "Delete Meter",
        endpoints: ["https://api.example.test"],
        capabilities: ["browser-cookies"],
        cookieDomains: ["api.example.test"],
        auth: { type: "bearer", secret: "TOKEN" },
        settings: [{ key: "TOKEN", title: "Token", type: "secure" }],
        async fetchUsage() { return { primary: { usedPercent: 1 } }; },
      });
    `;
    await manager.install(removable, "javascript");
    await manager.approve({ pluginId: "delete-meter", settings: {}, typedConfirmations: {} });
    await manager.remove("delete-meter");
    expect(cleaned.sort()).toEqual([
      "config:delete-meter",
      "credentials:delete-meter:TOKEN",
      "history:delete-meter",
      "sessions:delete-meter:api.example.test",
      "snapshot:delete-meter",
    ]);
  });

  it("keeps the installed source and approval when cleanup cannot complete", async () => {
    const { manager } = await fixture(undefined, {
      removeHistory: async () => {
        throw new Error("disk unavailable");
      },
    });
    await manager.install(source(), "javascript");
    await manager.approve({ pluginId: "fixture-meter", settings: {}, typedConfirmations: {} });
    await expect(manager.remove("fixture-meter")).rejects.toThrow("cleanup failed");
    await expect(manager.list()).resolves.toMatchObject({
      plugins: [{ id: "fixture-meter", approvalStatus: "approved" }],
    });
  });

  it("cleans credential names and domains retained by an older approval after source drift", async () => {
    const cleaned: string[] = [];
    const { root, manager } = await fixture(undefined, {
      cleanupCredentials: async (_pluginId, keys) => {
        cleaned.push(...keys);
      },
      removeBrowserSessions: async (_pluginId, domains) => {
        cleaned.push(...domains);
      },
    });
    const approvedSource = `
      defineProvider({
        id: "drift-meter",
        name: "Drift Meter",
        endpoints: ["https://api.example.test"],
        capabilities: ["browser-cookies"],
        cookieDomains: ["api.example.test"],
        auth: { type: "bearer", secret: "OLD_TOKEN" },
        settings: [{ key: "OLD_TOKEN", title: "Token", type: "secure" }],
        async fetchUsage() { return { primary: { usedPercent: 1 } }; },
      });
    `;
    await manager.install(approvedSource, "javascript");
    await manager.approve({ pluginId: "drift-meter", settings: {}, typedConfirmations: {} });
    await writeFile(
      join(root, "plugins", "drift-meter.js"),
      source("drift-meter", '"https://replacement.example.test"'),
    );
    await manager.remove("drift-meter");
    expect(cleaned).toContain("OLD_TOKEN");
    expect(cleaned).toContain("api.example.test");
  });
});
