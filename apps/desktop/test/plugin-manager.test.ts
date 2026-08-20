import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { inspectPlugin } from "@codexbar/plugin-runtime";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { DesktopPluginManager } from "../src/main/plugin-manager.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(
  execute: () => Promise<Record<string, unknown>> = async () => ({
    primary: { usedPercent: 42 },
    identity: { loginMethod: "plugin" },
  }),
): Promise<{ root: string; manager: DesktopPluginManager }> {
  const root = await mkdtemp(join(tmpdir(), "codexbar-multi-plugin-manager-"));
  roots.push(root);
  return {
    root,
    manager: new DesktopPluginManager({
      storageRoot: root,
      sandbox: {
        inspect: inspectPlugin,
        execute,
      },
      reservedIds: new Set(["codex", "claude"]),
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
});
