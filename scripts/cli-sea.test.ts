import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSeaBundlePath,
  assertSeaNodeVersion,
  cliSeaAssetName,
  cliSeaManifestAssetName,
  detectMusl,
  makeSeaConfig,
  makePostjectArguments,
  selectKeyringPackage,
} from "./cli-sea.ts";

test("selects the exact host-native keyring package", () => {
  assert.deepEqual(selectKeyringPackage({ platform: "win32", arch: "x64", isMusl: false }), {
    packageName: "@napi-rs/keyring-win32-x64-msvc",
    fileName: "keyring.win32-x64-msvc.node",
  });
  assert.deepEqual(selectKeyringPackage({ platform: "darwin", arch: "arm64", isMusl: false }), {
    packageName: "@napi-rs/keyring-darwin-arm64",
    fileName: "keyring.darwin-arm64.node",
  });
  assert.deepEqual(selectKeyringPackage({ platform: "darwin", arch: "x64", isMusl: false }), {
    packageName: "@napi-rs/keyring-darwin-x64",
    fileName: "keyring.darwin-x64.node",
  });
  assert.deepEqual(selectKeyringPackage({ platform: "linux", arch: "x64", isMusl: true }), {
    packageName: "@napi-rs/keyring-linux-x64-musl",
    fileName: "keyring.linux-x64-musl.node",
  });
  assert.throws(
    () => selectKeyringPackage({ platform: "linux", arch: "ppc64", isMusl: false }),
    /cross-compilation|not supported/i,
  );
});

test("detects musl only when the report lacks glibc and names a musl loader", () => {
  assert.equal(detectMusl({ header: { glibcVersionRuntime: "2.39" } }), false);
  assert.equal(detectMusl({ sharedObjects: ["/lib/ld-musl-x86_64.so.1"] }), true);
  assert.equal(detectMusl({ sharedObjects: ["/lib64/ld-linux-x86-64.so.2"] }), false);
});

test("requires the exact pinned Node runtime for SEA blobs", () => {
  assert.equal(assertSeaNodeVersion("v24.13.1"), "24.13.1");
  assert.throws(() => assertSeaNodeVersion("v24.18.0"), /require Node 24\.13\.1 exactly/);
});

test("uses the Node SEA Mach-O segment only on macOS", () => {
  const base = {
    postjectCli: "/tmp/postject.js",
    executable: "/tmp/codexbar-multi",
    seaBlob: "/tmp/sea.blob",
  };
  assert.deepEqual(makePostjectArguments({ ...base, platform: "linux" }), [
    "/tmp/postject.js",
    "/tmp/codexbar-multi",
    "NODE_SEA_BLOB",
    "/tmp/sea.blob",
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ]);
  assert.deepEqual(makePostjectArguments({ ...base, platform: "darwin" }), [
    "/tmp/postject.js",
    "/tmp/codexbar-multi",
    "NODE_SEA_BLOB",
    "/tmp/sea.blob",
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    "--macho-segment-name",
    "NODE_SEA",
  ]);
});

test("writes a CommonJS-only SEA config with the native assets", () => {
  assert.equal(assertSeaBundlePath("/tmp/cli.cjs"), "/tmp/cli.cjs");
  assert.throws(() => assertSeaBundlePath("/tmp/cli.mjs"), /CommonJS/);
  assert.deepEqual(
    makeSeaConfig({
      main: "/tmp/cli.cjs",
      output: "/tmp/cli.blob",
      nativeAddon: "/tmp/keyring.node",
      manifest: "/tmp/manifest.json",
    }),
    {
      main: "/tmp/cli.cjs",
      output: "/tmp/cli.blob",
      disableExperimentalSEAWarning: true,
      useCodeCache: false,
      useSnapshot: false,
      assets: {
        [cliSeaAssetName]: "/tmp/keyring.node",
        [cliSeaManifestAssetName]: "/tmp/manifest.json",
      },
    },
  );
});
