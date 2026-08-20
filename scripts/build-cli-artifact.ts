import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, rm, stat, writeFile, chmod } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertSeaBundlePath,
  assertSeaNodeVersion,
  cliSeaAssetName,
  cliSeaManifestAssetName,
  detectMusl,
  getHostSeaTarget,
  makePostjectArguments,
  resolveKeyringNativeAsset,
  type SeaHost,
  makeSeaConfig,
} from "./cli-sea.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const cliRoot = join(root, "apps", "cli");
const host: SeaHost = {
  platform: process.platform,
  arch: process.arch,
  isMusl:
    process.platform === "linux" &&
    detectMusl(process.report?.getReport() as Parameters<typeof detectMusl>[0]),
};
assertSeaNodeVersion(process.version);
if (process.platform === "darwin")
  throw new Error(
    "macOS Node SEA artifacts are deliberately disabled until the build-only ad-hoc codesign step after postject injection is implemented and validated. No signing, notarization, or release flow is enabled.",
  );
const target = getHostSeaTarget(host);
const artifactDirectory = join(root, "artifacts", "cli", target);
const intermediateDirectory = join(root, ".codexbar-multi", "sea", target);
const executableName = process.platform === "win32" ? "codexbar-multi.exe" : "codexbar-multi";
const executable = join(artifactDirectory, executableName);
const npmExecPath = process.env.npm_execpath;
if (npmExecPath === undefined || npmExecPath.length === 0)
  throw new Error("build-cli-artifact must be launched through pnpm.");

const run = (program: string, arguments_: readonly string[], cwd = root) => {
  execFileSync(program, arguments_, { cwd, stdio: "inherit" });
};

const sha256 = (contents: Uint8Array) => createHash("sha256").update(contents).digest("hex");

const postjectCli = () => {
  const localRequire = createRequire(import.meta.url);
  return localRequire.resolve("postject/dist/cli.js");
};

const ensureRegularFile = async (path: string, description: string) => {
  const file = await stat(path);
  if (!file.isFile()) throw new Error(`${description} is not a regular file: ${path}`);
};

await rm(intermediateDirectory, { recursive: true, force: true });
await rm(artifactDirectory, { recursive: true, force: true });
await mkdir(intermediateDirectory, { recursive: true, mode: 0o700 });
await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });

// This is deliberately a separate CJS build. The regular `vp build` remains
// ESM for development; Node SEA embeds CommonJS only.
run(process.execPath, [
  npmExecPath,
  "--filter",
  "@codexbar/cli",
  "exec",
  "vite",
  "build",
  "--config",
  "vite.sea.config.ts",
]);

const seaBundle = assertSeaBundlePath(join(cliRoot, "dist-sea", "sea.cjs"));
await ensureRegularFile(seaBundle, "SEA CommonJS bundle");
const nativeAddon = resolveKeyringNativeAsset(root, host);
await ensureRegularFile(nativeAddon.path, "host-native keyring addon");
const nativeContents = await readFile(nativeAddon.path);
const manifestPath = join(intermediateDirectory, "manifest.json");
await writeFile(
  manifestPath,
  `${JSON.stringify(
    {
      asset: cliSeaAssetName,
      sha256: sha256(nativeContents),
      platform: host.platform,
      arch: host.arch,
      package: nativeAddon.asset.packageName,
    },
    undefined,
    2,
  )}\n`,
  { mode: 0o600 },
);

const seaBlob = join(intermediateDirectory, "sea-prep.blob");
const seaConfigPath = join(intermediateDirectory, "sea-config.json");
await writeFile(
  seaConfigPath,
  `${JSON.stringify(
    makeSeaConfig({
      main: seaBundle,
      output: seaBlob,
      nativeAddon: nativeAddon.path,
      manifest: manifestPath,
    }),
    undefined,
    2,
  )}\n`,
  { mode: 0o600 },
);
run(process.execPath, [`--experimental-sea-config=${seaConfigPath}`]);
await ensureRegularFile(seaBlob, "SEA preparation blob");

await copyFile(process.execPath, executable);
if (process.platform !== "win32") await chmod(executable, 0o755);
run(
  process.execPath,
  makePostjectArguments({
    postjectCli: postjectCli(),
    executable,
    seaBlob,
    platform: process.platform,
  }),
);

const outputManifest = {
  name: "codexbar-multi",
  target,
  node: process.version,
  executable: executableName,
  nativeAddon: {
    asset: cliSeaAssetName,
    package: nativeAddon.asset.packageName,
    sha256: sha256(nativeContents),
  },
  seaManifestAsset: cliSeaManifestAssetName,
  crossCompiled: false,
};
await writeFile(
  join(artifactDirectory, "manifest.json"),
  `${JSON.stringify(outputManifest, undefined, 2)}\n`,
  {
    mode: 0o600,
  },
);

// These exercises load the extracted native module but never read/write a
// credential or execute a provider request. Keep them deliberately narrow.
run(executable, ["--help"]);
run(executable, ["providers", "--format", "json"]);

console.log(`Built host-native Node SEA CLI artifact: ${resolve(executable)}`);
