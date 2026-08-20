import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  inspectPlugin,
  type LoadedPlugin,
  type PluginSandboxCapabilities,
} from "@codexbar/plugin-runtime";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { NodeCLIPluginStore } from "../src/node-plugin-store.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const source = (id = "fixture-meter", endpoint = '"https://api.example.test"'): string => `
  defineProvider({
    id: "${id}",
    name: "Fixture Meter",
    endpoints: [${endpoint}],
    settings: [],
    async fetchUsage() { return { primary: { usedPercent: 42 } }; },
  });
`;

async function fixture(
  options: {
    readonly execute?: (
      plugin: Pick<LoadedPlugin, "transpiledSource" | "manifest">,
      capabilities?: PluginSandboxCapabilities,
    ) => Promise<Record<string, unknown>>;
    readonly readCookie?: (id: string, domain: string) => Promise<string | undefined>;
    readonly removeSource?: (path: string) => Promise<void>;
  } = {},
): Promise<{
  readonly root: string;
  readonly store: NodeCLIPluginStore;
  readonly secrets: Map<string, string>;
}> {
  const root = await mkdtemp(join(tmpdir(), "codexbar-multi-cli-plugins-"));
  roots.push(root);
  const secrets = new Map<string, string>();
  return {
    root,
    secrets,
    store: new NodeCLIPluginStore({
      storageRoot: root,
      reservedIds: new Set(["codex", "claude"]),
      sandbox: {
        inspect: (value, inspectOptions) => inspectPlugin(value, inspectOptions),
        execute: async (plugin, _broker, _context, capabilities) =>
          options.execute === undefined
            ? { primary: { usedPercent: 42 } }
            : options.execute(plugin, capabilities),
      },
      readSecret: async (id, key) => secrets.get(`${id}/${key}`),
      writeSecret: async (id, key, value) => {
        secrets.set(`${id}/${key}`, value);
      },
      removeSecret: async (id, key) => {
        secrets.delete(`${id}/${key}`);
      },
      ...(options.readCookie === undefined ? {} : { readBrowserCookie: options.readCookie }),
      ...(options.removeSource === undefined ? {} : { removeSource: options.removeSource }),
    }),
  };
}

describe("Node CLI plugin host", () => {
  it("installs bounded regular source, persists only approval metadata, executes and removes", async () => {
    const { root, store } = await fixture();
    const input = join(root, "input.js");
    await writeFile(input, source());

    await expect(store.install(input)).resolves.toMatchObject({
      id: "fixture-meter",
      approvalStatus: "needs-approval",
    });
    expect((await store.list()).plugins).toMatchObject([
      { id: "fixture-meter", approvalStatus: "needs-approval" },
    ]);
    await store.approve("fixture-meter", {}, {});
    await expect(store.test("fixture-meter")).resolves.toMatchObject({
      plugin: { id: "fixture-meter", approvalStatus: "approved" },
      snapshot: { primary: { usedPercent: 42 } },
    });

    const approvals = await readFile(join(root, "plugin-approvals.json"), "utf8");
    expect(approvals).not.toContain("fetchUsage");
    await store.remove("fixture-meter");
    expect(await store.list()).toEqual({ plugins: [], invalidFiles: [] });
  });

  it("rejects collisions, symlink input and duplicate cross-language ids", async () => {
    const { root, store } = await fixture();
    const codex = join(root, "codex.js");
    const normal = join(root, "normal.js");
    const duplicate = join(root, "normal.ts");
    const link = join(root, "linked.js");
    await writeFile(codex, source("codex"));
    await writeFile(normal, source());
    await writeFile(duplicate, source());
    await symlink(normal, link);
    await expect(store.install(codex)).rejects.toThrow("collides");
    await expect(store.install(link)).rejects.toThrow();
    await store.install(normal);
    await expect(store.install(duplicate)).rejects.toThrow("already installed");
  });

  it("rejects a symlinked storage-root chain before discovery on every platform", async () => {
    const root = await mkdtemp(join(tmpdir(), "codexbar-multi-cli-plugin-links-"));
    roots.push(root);
    const outside = join(root, "outside");
    const linkedRoot = join(root, "linked-root");
    await writeFile(outside, "not a directory");
    await symlink(outside, linkedRoot);
    const store = new NodeCLIPluginStore({
      storageRoot: linkedRoot,
      reservedIds: new Set(),
      sandbox: {
        inspect: (value, options) => inspectPlugin(value, options),
        execute: async () => ({ primary: { usedPercent: 1 } }),
      },
    });
    await expect(store.list()).rejects.toThrow("symbolic links");
  });

  it("requires exact typed confirmation and never stores secure settings in approvals", async () => {
    const { root, store } = await fixture();
    const input = join(root, "private.js");
    await writeFile(
      input,
      source(
        "private-meter",
        '{ setting: "ENDPOINT", policy: "https-or-private-network-http" }',
      ).replace(
        "settings: [],",
        'settings: [{ key: "ENDPOINT", title: "Endpoint", type: "plain" }, { key: "TOKEN", title: "Token", type: "secure" }],',
      ),
    );
    await store.install(input);
    const settings = { ENDPOINT: "http://127.0.0.1:8080" };
    await expect(store.approve("private-meter", settings, {})).rejects.toThrow("exact typed");
    await expect(
      store.approve("private-meter", { ...settings, TOKEN: "must-not-persist" }, {}),
    ).rejects.toThrow("plain settings");
    await store.approve("private-meter", settings, {
      "http://127.0.0.1:8080": "http://127.0.0.1:8080",
    });
    const approval = await readFile(join(root, "plugin-approvals.json"), "utf8");
    expect(approval).not.toContain("must-not-persist");
  });

  it("rechecks approval drift and fails closed for browser cookies with no desktop export", async () => {
    const { root, store } = await fixture({
      execute: async (_plugin, capabilities) => {
        await capabilities?.getCookie("api.example.test");
        return { primary: { usedPercent: 10 } };
      },
    });
    const dynamic = join(root, "dynamic.js");
    await writeFile(
      dynamic,
      source("dynamic-meter", '{ setting: "ENDPOINT", policy: "https" }').replace(
        "settings: [],",
        'settings: [{ key: "ENDPOINT", title: "Endpoint", type: "plain" }],',
      ),
    );
    await store.install(dynamic);
    await store.approve("dynamic-meter", { ENDPOINT: "https://api.example.test" }, {});
    const approvalsPath = join(root, "plugin-approvals.json");
    const approvals = JSON.parse(await readFile(approvalsPath, "utf8")) as {
      approvals: { "dynamic-meter": { settings: Record<string, string> } };
    };
    approvals.approvals["dynamic-meter"].settings.ENDPOINT = "https://other.example.test";
    await writeFile(approvalsPath, JSON.stringify(approvals));
    await expect(store.test("dynamic-meter")).rejects.toThrow("approval no longer matches");

    const browser = join(root, "browser.js");
    await writeFile(
      browser,
      source("browser-meter").replace(
        "settings: [],",
        'capabilities: ["browser-cookies"], cookieDomains: ["api.example.test"], settings: [],',
      ),
    );
    await store.install(browser);
    await store.approve("browser-meter", {}, {});
    await expect(store.test("browser-meter")).rejects.toThrow("exported by the desktop");
  });

  it("passes only a declared desktop-exported browser cookie through the approved capability", async () => {
    const { root, store } = await fixture({
      readCookie: async (pluginId, domain) =>
        pluginId === "exported-browser" && domain === "api.example.test"
          ? "session=exported"
          : undefined,
      execute: async (_plugin, capabilities) => ({
        primary: {
          usedPercent:
            (await capabilities?.getCookie("api.example.test")) === "session=exported" ? 7 : 0,
        },
      }),
    });
    const input = join(root, "exported-browser.js");
    await writeFile(
      input,
      source("exported-browser").replace(
        "settings: [],",
        'capabilities: ["browser-cookies"], cookieDomains: ["api.example.test"], settings: [],',
      ),
    );
    await store.install(input);
    await store.approve("exported-browser", {}, {});
    await expect(store.test("exported-browser")).resolves.toMatchObject({
      snapshot: { primary: { usedPercent: 7 } },
    });
  });

  it("uses the keyring abstraction for declared secure settings and clears previous approvals on remove", async () => {
    const { root, secrets, store } = await fixture();
    const input = join(root, "secret.js");
    await writeFile(
      input,
      source("secret-meter").replace(
        "settings: [],",
        'auth: { type: "bearer", secret: "TOKEN" }, settings: [{ key: "TOKEN", title: "Token", type: "secure" }],',
      ),
    );
    await store.install(input);
    await store.setSecret("secret-meter", "TOKEN", "fixture-secret");
    expect(secrets.get("secret-meter/TOKEN")).toBe("fixture-secret");
    await store.remove("secret-meter");
    expect(secrets.has("secret-meter/TOKEN")).toBe(false);
  });

  it("withdraws approval before a source-removal failure leaves an inert file", async () => {
    const { root, store } = await fixture({
      removeSource: async () => {
        throw new Error("simulated source delete failure");
      },
    });
    const input = join(root, "remove-failure.js");
    await writeFile(input, source("remove-failure"));
    await store.install(input);
    await store.approve("remove-failure", {}, {});
    await expect(store.remove("remove-failure")).rejects.toThrow("simulated source delete failure");
    expect((await store.list()).plugins).toMatchObject([
      { id: "remove-failure", approvalStatus: "needs-approval" },
    ]);
  });
});
