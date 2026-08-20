import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertDesktopArtifactNodeVersion,
  desktopArtifactOutputDirectoryName,
  expectedDesktopArtifactName,
  getHostDesktopTarget,
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
});

test("rejects unsupported architectures and synthetic cross-build hosts", () => {
  assert.throws(
    () => getHostDesktopTarget({ platform: "linux", arch: "ppc64" }),
    /cross-build is disabled/i,
  );
  assert.throws(() => getHostDesktopTarget({ platform: "aix", arch: "x64" }), /only supported/i);
});

test("preserves a native arm64 target instead of cross-building x64", () => {
  const target = getHostDesktopTarget({ platform: "linux", arch: "arm64" });
  assert.deepEqual(target.electronBuilderArgs.slice(0, 4), [
    "--linux",
    "AppImage",
    "--arm64",
    "--dir",
  ]);
  assert.equal(
    expectedDesktopArtifactName("0.1.0", target),
    "CodexBar Multi-0.1.0-linux-arm64.AppImage",
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
  assert.deepEqual(packageJson.dependencies, { "@napi-rs/keyring": "catalog:" });
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
    signAndEditExecutable: false,
    target: ["nsis"],
  });
  assert.deepEqual(build.mac, {
    category: "public.app-category.utilities",
    icon: "build/icon.icns",
    identity: null,
    target: ["dmg"],
  });
});
