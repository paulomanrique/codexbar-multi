import { execFileSync } from "node:child_process";
import { access, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertDesktopArtifactNodeVersion,
  desktopArtifactOutputDirectoryName,
  expectedDesktopArtifactName,
  getHostDesktopTarget,
} from "./desktop-artifact.ts";

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

const hasNativeKeyring = async (unpackedResources: string): Promise<boolean> => {
  try {
    const entries = await readdir(unpackedResources, { recursive: true });
    return entries.some(
      (entry) =>
        typeof entry === "string" &&
        entry.startsWith("node_modules/@napi-rs/keyring-") &&
        entry.endsWith(".node"),
    );
  } catch {
    return false;
  }
};

await rm(artifactDirectory, { recursive: true, force: true });
await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });

run(process.execPath, [npmExecPath, "--filter", "@codexbar/desktop", "run", "build"]);
run(process.execPath, [
  npmExecPath,
  "--filter",
  "@codexbar/desktop",
  "exec",
  "electron-builder",
  ...target.electronBuilderArgs,
  `--config.directories.output=${artifactDirectory}`,
]);

const manifest = JSON.parse(await readFile(join(desktopRoot, "package.json"), "utf8")) as {
  readonly version?: unknown;
};
if (typeof manifest.version !== "string") throw new Error("Desktop package version is invalid.");
const artifact = join(artifactDirectory, expectedDesktopArtifactName(manifest.version, target));
const unpacked = join(artifactDirectory, target.unpackedDirectory);
const executable = join(unpacked, ...target.executableRelativePath);
const unpackedResources = join(unpacked, "resources", "app.asar.unpacked");

await regularFile(artifact, "Desktop artifact");
await existingDirectory(unpacked, "Unpacked desktop artifact");
await regularFile(executable, "Unpacked Electron executable");
await access(join(unpacked, "resources", "app.asar"));
if (!(await hasNativeKeyring(unpackedResources)))
  throw new Error(
    "The packaged desktop artifact is missing its unpacked native credential module.",
  );

// This asks the Electron binary for its version without starting our main
// process. It therefore cannot open a provider, a credential store, or the
// application database.
run(executable, ["--version"], unpacked, { ...process.env, ELECTRON_RUN_AS_NODE: "1" });

console.log(`Built host-native desktop artifact: ${resolve(artifact)}`);
