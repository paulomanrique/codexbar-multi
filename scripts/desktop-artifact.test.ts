import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  assertDesktopArtifactNodeVersion,
  collectPtyGraphHits,
  desktopArtifactOutputDirectoryName,
  expectedDesktopArtifactName,
  getHostDesktopTarget,
  nodePtyAsarUnpackGlob,
  nodePtyCompanionSubpaths,
  nodePtyNativeModuleSubpath,
} from "./desktop-artifact.ts";

test("requires the pinned Node runtime before packaging", () => {
  assert.equal(assertDesktopArtifactNodeVersion("v24.13.1"), "24.13.1");
  assert.throws(
    () => assertDesktopArtifactNodeVersion("v24.18.0"),
    /require Node 24\.13\.1 exactly/,
  );
});

test("selects only current-host electron-builder targets", () => {
  const linux = getHostDesktopTarget({ platform: "linux", arch: "x64" });
  assert.deepEqual(linux.electronBuilderArgs, [
    "--linux",
    "AppImage",
    "--x64",
    "--dir",
    "--publish",
    "never",
  ]);
  assert.equal(linux.unpackedDirectory, "linux-unpacked");
  assert.equal(
    expectedDesktopArtifactName("0.1.0", linux),
    "CodexBar Multi-0.1.0-linux-x86_64.AppImage",
  );
  assert.equal(desktopArtifactOutputDirectoryName(linux), "linux-x64");

  const windows = getHostDesktopTarget({ platform: "win32", arch: "x64" });
  assert.deepEqual(windows.electronBuilderArgs.slice(0, 4), ["--win", "nsis", "--x64", "--dir"]);
  assert.equal(expectedDesktopArtifactName("0.1.0", windows), "CodexBar Multi-0.1.0-win-x64.exe");
  assert.deepEqual(windows.executableRelativePath, ["codexbar-multi.exe"]);
});

test("rejects unsupported architectures and synthetic cross-build hosts", () => {
  assert.throws(
    () => getHostDesktopTarget({ platform: "linux", arch: "ppc64" }),
    /cross-build is disabled/i,
  );
  assert.throws(() => getHostDesktopTarget({ platform: "aix", arch: "x64" }), /only supported/i);
});

test("preserves a native arm64 target instead of cross-building x64", () => {
  const linux = getHostDesktopTarget({ platform: "linux", arch: "arm64" });
  assert.deepEqual(linux.electronBuilderArgs.slice(0, 4), [
    "--linux",
    "AppImage",
    "--arm64",
    "--dir",
  ]);
  assert.equal(
    expectedDesktopArtifactName("0.1.0", linux),
    "CodexBar Multi-0.1.0-linux-arm64.AppImage",
  );
  assert.equal(linux.unpackedDirectory, "linux-arm64-unpacked");
  assert.equal(
    getHostDesktopTarget({ platform: "win32", arch: "arm64" }).unpackedDirectory,
    "win-arm64-unpacked",
  );
  assert.equal(
    getHostDesktopTarget({ platform: "darwin", arch: "arm64" }).unpackedDirectory,
    "mac-arm64",
  );
});

test("declares a non-publishing desktop package with the fixed product identity", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../apps/desktop/package.json", import.meta.url), "utf8"),
  ) as {
    readonly build?: Record<string, unknown>;
    readonly desktopName?: unknown;
    readonly dependencies?: Record<string, unknown>;
    readonly optionalDependencies?: Record<string, unknown>;
  };
  const build = packageJson.build;
  assert.ok(build);
  assert.equal(build.appId, "com.paulomanrique.codexbar-multi");
  assert.equal(build.productName, "CodexBar Multi");
  assert.equal(packageJson.desktopName, "codexbar-multi.desktop");
  assert.equal(build.publish, null);
  assert.equal(build.asar, true);
  assert.equal(build.forceCodeSigning, false);
  assert.equal(build.npmRebuild, false);
  assert.deepEqual(build.extraResources, [
    { from: "build/icon.png", to: "tray.png" },
    { from: "build/icon.ico", to: "tray.ico" },
  ]);
  assert.deepEqual(packageJson.dependencies, {
    "@napi-rs/keyring": "catalog:",
    "node-pty": "catalog:",
  });
  assert.ok(Array.isArray(build.asarUnpack));
  assert.ok((build.asarUnpack as string[]).includes("node_modules/@napi-rs/**/*.node"));
  assert.ok((build.asarUnpack as string[]).includes(nodePtyAsarUnpackGlob));
  assert.equal(
    nodePtyNativeModuleSubpath(getHostDesktopTarget({ platform: "linux", arch: "x64" })),
    "prebuilds/linux-x64/pty.node",
  );
  assert.equal(
    nodePtyNativeModuleSubpath(getHostDesktopTarget({ platform: "win32", arch: "x64" })),
    "prebuilds/win32-x64/conpty.node",
  );
  assert.equal(
    nodePtyNativeModuleSubpath(getHostDesktopTarget({ platform: "win32", arch: "arm64" })),
    "prebuilds/win32-arm64/conpty.node",
  );
  assert.equal(
    nodePtyNativeModuleSubpath(getHostDesktopTarget({ platform: "darwin", arch: "arm64" })),
    "prebuilds/darwin-arm64/pty.node",
  );
  assert.deepEqual(
    nodePtyCompanionSubpaths(getHostDesktopTarget({ platform: "win32", arch: "x64" })),
    ["prebuilds/win32-x64/conpty/conpty.dll", "prebuilds/win32-x64/conpty/OpenConsole.exe"],
  );
  assert.deepEqual(
    nodePtyCompanionSubpaths(getHostDesktopTarget({ platform: "darwin", arch: "arm64" })),
    ["prebuilds/darwin-arm64/spawn-helper"],
  );
  assert.deepEqual(
    nodePtyCompanionSubpaths(getHostDesktopTarget({ platform: "linux", arch: "x64" })),
    [],
  );
  assert.deepEqual(Object.keys(packageJson.optionalDependencies ?? {}).sort(), [
    "@napi-rs/keyring-darwin-arm64",
    "@napi-rs/keyring-darwin-x64",
    "@napi-rs/keyring-linux-arm64-gnu",
    "@napi-rs/keyring-linux-arm64-musl",
    "@napi-rs/keyring-linux-x64-gnu",
    "@napi-rs/keyring-linux-x64-musl",
    "@napi-rs/keyring-win32-arm64-msvc",
    "@napi-rs/keyring-win32-x64-msvc",
  ]);
  assert.deepEqual(build.protocols, [{ name: "CodexBar Multi", schemes: ["codexbar-multi"] }]);
  assert.deepEqual(build.linux, {
    category: "Utility",
    executableName: "codexbar-multi",
    icon: "build/icon.png",
    syncDesktopName: true,
    target: ["AppImage"],
  });
  assert.deepEqual(build.win, {
    executableName: "codexbar-multi",
    icon: "build/icon.ico",
    signExecutable: false,
    target: ["nsis"],
  });
  assert.deepEqual(build.mac, {
    category: "public.app-category.utilities",
    icon: "build/icon.icns",
    identity: null,
    target: ["dmg"],
  });
});

test("keeps PTY desktop-only and SEA unchanged", async () => {
  const cliPackageJson = JSON.parse(
    await readFile(new URL("../apps/cli/package.json", import.meta.url), "utf8"),
  ) as {
    readonly dependencies?: Record<string, unknown>;
    readonly optionalDependencies?: Record<string, unknown>;
  };
  assert.equal(cliPackageJson.dependencies?.["node-pty"], undefined);
  assert.equal(cliPackageJson.optionalDependencies?.["node-pty"], undefined);
  const platformPackageJson = JSON.parse(
    await readFile(new URL("../packages/platform/package.json", import.meta.url), "utf8"),
  ) as {
    readonly dependencies?: Record<string, unknown>;
    readonly optionalDependencies?: Record<string, unknown>;
  };
  assert.equal(platformPackageJson.dependencies?.["node-pty"], undefined);
  assert.equal(platformPackageJson.optionalDependencies?.["node-pty"], undefined);
  const sea = await readFile(new URL("./cli-sea.ts", import.meta.url), "utf8");
  assert.equal(sea.includes("node-pty"), false);
  const cliRunner = await readFile(new URL("../apps/cli/src/runner.ts", import.meta.url), "utf8");
  assert.equal(cliRunner.includes("node-pty"), false);
  assert.equal(cliRunner.includes("fetchClaudeCliUsage"), false);
  const nodeHost = await readFile(
    new URL("../packages/platform/src/node.ts", import.meta.url),
    "utf8",
  );
  assert.equal(nodeHost.includes("node-pty"), false);
  assert.equal(nodeHost.includes("fetchClaudeCliUsage"), false);
  const viteMain = await readFile(
    new URL("../apps/desktop/vite.main.config.ts", import.meta.url),
    "utf8",
  );
  assert.match(viteMain, /["']node-pty["']/);
  const pnpmWorkspace = await readFile(new URL("../pnpm-workspace.yaml", import.meta.url), "utf8");
  assert.ok(pnpmWorkspace.includes("node-pty: 1.2.0-beta.15"));
  assert.ok(pnpmWorkspace.includes("node-pty: true"));
});

test("detects forbidden PTY graph needles in a bundle", () => {
  assert.deepEqual(collectPtyGraphHits("plain cli host"), []);
  assert.deepEqual(collectPtyGraphHits('import "node-pty"'), ["node-pty"]);
  assert.deepEqual(collectPtyGraphHits("makeNodePtyRunner(); makeNodeClaudeCliLocalCapability()"), [
    "makeNodePtyRunner",
    "makeNodeClaudeCliLocalCapability",
  ]);
});

test("node-pty 1.2.0-beta.15 archive contains exact per-target prebuild paths", async () => {
  const pkg = fileURLToPath(new URL("../apps/desktop/node_modules/node-pty", import.meta.url));
  const mustBeFile = async (relative: string) => {
    const info = await stat(join(pkg, relative));
    assert.equal(info.isFile(), true, relative);
  };
  const mustBeAbsent = async (relative: string) => {
    await assert.rejects(stat(join(pkg, relative)), { code: "ENOENT" });
  };
  await mustBeFile("prebuilds/linux-x64/pty.node");
  await mustBeFile("prebuilds/linux-arm64/pty.node");
  await mustBeFile("prebuilds/darwin-arm64/pty.node");
  await mustBeFile("prebuilds/darwin-arm64/spawn-helper");
  await mustBeFile("prebuilds/darwin-x64/pty.node");
  await mustBeFile("prebuilds/darwin-x64/spawn-helper");
  await mustBeFile("prebuilds/win32-x64/conpty.node");
  await mustBeFile("prebuilds/win32-x64/conpty/conpty.dll");
  await mustBeFile("prebuilds/win32-x64/conpty/OpenConsole.exe");
  await mustBeFile("prebuilds/win32-arm64/conpty.node");
  await mustBeFile("prebuilds/win32-arm64/conpty/conpty.dll");
  await mustBeFile("prebuilds/win32-arm64/conpty/OpenConsole.exe");
  await mustBeAbsent("prebuilds/win32-x64/pty.node");
  await mustBeAbsent("prebuilds/win32-arm64/pty.node");
});

test("built CLI output has no node-pty graph", async (t) => {
  const distRoot = fileURLToPath(new URL("../apps/cli/dist", import.meta.url));
  let entries: string[];
  try {
    entries = await readdir(distRoot);
  } catch {
    t.skip("CLI dist is not built yet");
    return;
  }
  const hits: string[] = [];
  for (const name of entries) {
    if (!name.endsWith(".js") && !name.endsWith(".mjs") && !name.endsWith(".cjs")) continue;
    const source = await readFile(join(distRoot, name), "utf8");
    for (const needle of collectPtyGraphHits(source)) hits.push(`${name}:${needle}`);
  }
  assert.deepEqual(hits, []);
});
