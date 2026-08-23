import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { access, mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertDesktopArtifactNodeVersion,
  desktopArtifactOutputDirectoryName,
  expectedDesktopArtifactName,
  getHostDesktopTarget,
  nodePtyCompanionSubpaths,
  nodePtyNativeModuleSubpath,
} from "./desktop-artifact.ts";
import { detectMusl, selectKeyringPackage } from "./cli-sea.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
assertDesktopArtifactNodeVersion(process.version);
const desktopRoot = join(root, "apps", "desktop");
const target = getHostDesktopTarget({ platform: process.platform, arch: process.arch });
const artifactDirectory = join(
  root,
  "artifacts",
  "desktop",
  desktopArtifactOutputDirectoryName(target),
);
const npmExecPath = process.env.npm_execpath;
if (npmExecPath === undefined || npmExecPath.length === 0)
  throw new Error("build-desktop-artifact must be launched through pnpm.");

// Give electron-builder's Node module collector a deterministic pinned pnpm.
// The outer process is already running via corepack pnpm 11.10.0; the collector
// otherwise finds a global pnpm (11.17.0 on the Windows gate) via `which` and
// fails the packageManager pin without bypassing any version check.
const pnpmShimDir = mkdtempSync(join(tmpdir(), "codexbar-pnpm-shim-"));

const run = (program: string, arguments_: readonly string[], cwd = root, env?: NodeJS.ProcessEnv) =>
  execFileSync(program, arguments_, { cwd, env, stdio: "inherit" });

const regularFile = async (path: string, description: string): Promise<void> => {
  const file = await stat(path);
  if (!file.isFile()) throw new Error(`${description} is not a regular file: ${path}`);
};

const existingDirectory = async (path: string, description: string): Promise<void> => {
  const directory = await stat(path);
  if (!directory.isDirectory()) throw new Error(`${description} is not a directory: ${path}`);
};

await rm(artifactDirectory, { recursive: true, force: true });
await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });

try {
  writeFileSync(
    join(pnpmShimDir, "pnpm"),
    `#!/bin/sh\nexec "${process.execPath}" "${npmExecPath}" "$@"\n`,
  );
  chmodSync(join(pnpmShimDir, "pnpm"), 0o700);
  writeFileSync(
    join(pnpmShimDir, "pnpm.cmd"),
    `@echo off\r\n"${process.execPath}" "${npmExecPath}" %*\r\n`,
  );
  const shimEnv: NodeJS.ProcessEnv = {
    ...process.env,
    npm_execpath: npmExecPath,
    PATH: `${pnpmShimDir}${delimiter}${process.env.PATH ?? ""}`,
  };

  run(
    process.execPath,
    [npmExecPath, "--filter", "@codexbar/desktop", "run", "build"],
    root,
    shimEnv,
  );
  run(
    process.execPath,
    [
      npmExecPath,
      "--filter",
      "@codexbar/desktop",
      "exec",
      "electron-builder",
      ...target.electronBuilderArgs,
      `--config.directories.output=${artifactDirectory}`,
    ],
    root,
    shimEnv,
  );
} finally {
  rmSync(pnpmShimDir, { recursive: true, force: true });
}

const manifest = JSON.parse(await readFile(join(desktopRoot, "package.json"), "utf8")) as {
  readonly version?: unknown;
};
if (typeof manifest.version !== "string") throw new Error("Desktop package version is invalid.");
const artifact = join(artifactDirectory, expectedDesktopArtifactName(manifest.version, target));
const unpacked = join(artifactDirectory, target.unpackedDirectory);
const executable = join(unpacked, ...target.executableRelativePath);
const unpackedResources = join(unpacked, "resources", "app.asar.unpacked");
const nativeKeyring = selectKeyringPackage({
  platform: process.platform,
  arch: process.arch,
  isMusl: detectMusl(process.report?.getReport()),
});
const nativeKeyringPath = join(
  unpackedResources,
  "node_modules",
  nativeKeyring.packageName,
  nativeKeyring.fileName,
);

await regularFile(artifact, "Desktop artifact");
await existingDirectory(unpacked, "Unpacked desktop artifact");
await regularFile(executable, "Unpacked Electron executable");
await access(join(unpacked, "resources", "app.asar"));
await regularFile(nativeKeyringPath, "Host-native unpacked credential module");
const nodePtyPackageRoot = join(unpackedResources, "node_modules", "node-pty");
const nodePtyNativePath = join(nodePtyPackageRoot, nodePtyNativeModuleSubpath(target));
await regularFile(nodePtyNativePath, "Host-native unpacked PTY module");
for (const companion of nodePtyCompanionSubpaths(target)) {
  await regularFile(
    join(nodePtyPackageRoot, companion),
    `Host-native unpacked PTY companion ${companion}`,
  );
}

// This asks the Electron binary for its version without starting our main
// process. It therefore cannot open a provider, a credential store, or the
// application database.
run(executable, ["--version"], unpacked, { ...process.env, ELECTRON_RUN_AS_NODE: "1" });
// Load the host-native PTY addon through Electron's Node without starting
// providers or touching credentials. spawn is not invoked. Windows
// conpty.node / conpty.dll load is an orchestrator gate on a Windows host.
if (target.platform !== "win32") {
  run(
    executable,
    [
      "-e",
      "process.dlopen({ exports: {} }, process.argv[1]); process.stdout.write('pty-native-ok');",
      nodePtyNativePath,
    ],
    unpacked,
    { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  );
}

console.log(`Built host-native desktop artifact: ${resolve(artifact)}`);
