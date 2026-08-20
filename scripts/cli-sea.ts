import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export const cliSeaAssetName = "codexbar-multi/sea/keyring.node";
export const cliSeaManifestAssetName = "codexbar-multi/sea/manifest.json";
export const cliSeaSentinelFuse = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
export const cliSeaNodeVersion = "24.13.1";

export interface SeaHost {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly isMusl: boolean;
}

export interface SeaNativeAsset {
  readonly packageName: string;
  readonly fileName: string;
}

interface RuntimeReport {
  readonly header?: { readonly glibcVersionRuntime?: unknown };
  readonly sharedObjects?: readonly unknown[];
}

export const selectKeyringPackage = (host: SeaHost): SeaNativeAsset => {
  switch (host.platform) {
    case "darwin":
      if (host.arch === "x64" || host.arch === "arm64")
        return {
          packageName: "@napi-rs/keyring-darwin-universal",
          fileName: "keyring.darwin-universal.node",
        };
      break;
    case "linux":
      if (host.arch === "x64")
        return {
          packageName: `@napi-rs/keyring-linux-x64-${host.isMusl ? "musl" : "gnu"}`,
          fileName: `keyring.linux-x64-${host.isMusl ? "musl" : "gnu"}.node`,
        };
      if (host.arch === "arm64")
        return {
          packageName: `@napi-rs/keyring-linux-arm64-${host.isMusl ? "musl" : "gnu"}`,
          fileName: `keyring.linux-arm64-${host.isMusl ? "musl" : "gnu"}.node`,
        };
      break;
    case "win32":
      if (host.arch === "x64" || host.arch === "arm64")
        return {
          packageName: `@napi-rs/keyring-win32-${host.arch}-msvc`,
          fileName: `keyring.win32-${host.arch}-msvc.node`,
        };
      break;
  }
  throw new Error(
    `Node SEA CLI artifacts are not supported for ${host.platform}/${host.arch}. ` +
      "Supported hosts are Windows x64/arm64, Linux x64/arm64, and macOS x64/arm64.",
  );
};

export const getHostSeaTarget = (host: SeaHost) => `${host.platform}-${host.arch}`;

export const assertSeaNodeVersion = (version: string): string => {
  const normalized = version.startsWith("v") ? version.slice(1) : version;
  if (normalized !== cliSeaNodeVersion)
    throw new Error(
      `Node SEA artifacts require Node ${cliSeaNodeVersion} exactly; received ${version}. ` +
        "Use the pinned Node executable so the embedded blob and runtime match the declared artifact baseline.",
    );
  return normalized;
};

export const makePostjectArguments = (options: {
  readonly postjectCli: string;
  readonly executable: string;
  readonly seaBlob: string;
  readonly platform: NodeJS.Platform;
}): readonly string[] => [
  options.postjectCli,
  options.executable,
  "NODE_SEA_BLOB",
  options.seaBlob,
  "--sentinel-fuse",
  cliSeaSentinelFuse,
  ...(options.platform === "darwin" ? ["--macho-segment-name", "NODE_SEA"] : []),
];

export const detectMusl = (report: RuntimeReport | undefined): boolean => {
  const header = report?.header;
  if (header?.glibcVersionRuntime !== undefined) return false;
  return (
    report?.sharedObjects?.some(
      (object) => typeof object === "string" && object.includes("ld-musl-"),
    ) ?? false
  );
};

/**
 * Resolves the optional native package from the CLI workspace rather than the
 * script workspace. pnpm intentionally keeps these dependency trees isolated.
 */
export const resolveKeyringNativeAsset = (
  projectRoot: string,
  host: SeaHost,
): { readonly asset: SeaNativeAsset; readonly path: string } => {
  const asset = selectKeyringPackage(host);
  const cliRequire = createRequire(join(projectRoot, "apps", "cli", "package.json"));
  const keyringPackageJson = cliRequire.resolve("@napi-rs/keyring/package.json");
  const keyringRequire = createRequire(keyringPackageJson);
  let packageJson: string;
  try {
    packageJson = keyringRequire.resolve(`${asset.packageName}/package.json`);
  } catch (error) {
    throw new Error(
      `The host-native keyring package ${asset.packageName} is unavailable. ` +
        "Install dependencies on the target host; cross-compilation is deliberately unsupported.",
      { cause: error },
    );
  }
  return { asset, path: join(dirname(packageJson), asset.fileName) };
};

export const makeSeaConfig = (options: {
  readonly main: string;
  readonly output: string;
  readonly nativeAddon: string;
  readonly manifest: string;
}) => ({
  main: options.main,
  output: options.output,
  disableExperimentalSEAWarning: true,
  useCodeCache: false,
  useSnapshot: false,
  assets: {
    [cliSeaAssetName]: options.nativeAddon,
    [cliSeaManifestAssetName]: options.manifest,
  },
});

/** Kept explicit so scripts and tests never accidentally package ESM into SEA. */
export const assertSeaBundlePath = (path: string) => {
  if (!path.endsWith(".cjs"))
    throw new Error(`Node SEA needs a CommonJS bundle; received ${path}.`);
  return path;
};
