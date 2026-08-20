/**
 * The desktop artifact builder is deliberately host-native. electron-builder
 * can cross-package many targets, but those outputs are not a substitute for
 * running the product on that OS (and native credential modules make that
 * distinction security relevant).
 */
export interface DesktopArtifactHost {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
}

export const desktopArtifactNodeVersion = "24.13.1";

export const assertDesktopArtifactNodeVersion = (version: string): string => {
  const normalized = version.startsWith("v") ? version.slice(1) : version;
  if (normalized !== desktopArtifactNodeVersion) {
    throw new Error(
      `Desktop artifacts require Node ${desktopArtifactNodeVersion} exactly; received ${version}.`,
    );
  }
  return normalized;
};

export interface DesktopArtifactTarget {
  readonly platform: "darwin" | "linux" | "win32";
  readonly arch: "arm64" | "x64";
  /** electron-builder's artifact macros use target labels, not Node platform IDs. */
  readonly artifactOs: "linux" | "mac" | "win";
  readonly artifactArch: "arm64" | "x64" | "x86_64";
  readonly electronBuilderArgs: readonly string[];
  readonly expectedExtension: ".dmg" | ".AppImage" | ".exe";
  readonly unpackedDirectory: string;
  readonly executableRelativePath: readonly string[];
}

const unpackedDirectoryFor = (
  platform: DesktopArtifactTarget["platform"],
  arch: DesktopArtifactTarget["arch"],
): string => {
  const suffix = arch === "x64" ? "" : `-${arch}`;
  return platform === "darwin"
    ? `mac${suffix}`
    : `${platform === "win32" ? "win" : "linux"}${suffix}-unpacked`;
};

const targetForPlatform = (
  platform: DesktopArtifactHost["platform"],
  arch: DesktopArtifactTarget["arch"],
): DesktopArtifactTarget => {
  switch (platform) {
    case "linux":
      return {
        platform,
        arch,
        artifactOs: "linux",
        artifactArch: arch === "x64" ? "x86_64" : arch,
        electronBuilderArgs: ["--linux", "AppImage", `--${arch}`, "--dir", "--publish", "never"],
        expectedExtension: ".AppImage",
        unpackedDirectory: unpackedDirectoryFor(platform, arch),
        executableRelativePath: ["codexbar-multi"],
      };
    case "win32":
      return {
        platform,
        arch,
        artifactOs: "win",
        artifactArch: arch,
        electronBuilderArgs: ["--win", "nsis", `--${arch}`, "--dir", "--publish", "never"],
        expectedExtension: ".exe",
        unpackedDirectory: unpackedDirectoryFor(platform, arch),
        executableRelativePath: ["CodexBar Multi.exe"],
      };
    case "darwin":
      return {
        platform,
        arch,
        artifactOs: "mac",
        artifactArch: arch,
        electronBuilderArgs: ["--mac", "dmg", `--${arch}`, "--dir", "--publish", "never"],
        expectedExtension: ".dmg",
        unpackedDirectory: unpackedDirectoryFor(platform, arch),
        executableRelativePath: ["CodexBar Multi.app", "Contents", "MacOS", "CodexBar Multi"],
      };
    default:
      throw new Error(
        `Desktop artifacts are only supported on native Windows, Linux, or macOS hosts; received ${platform}.`,
      );
  }
};

export const getHostDesktopTarget = (host: DesktopArtifactHost): DesktopArtifactTarget => {
  if (host.arch !== "x64" && host.arch !== "arm64")
    throw new Error(
      `Desktop artifact cross-build is disabled: ${host.platform}/${host.arch} is not a supported native artifact host.`,
    );
  return targetForPlatform(host.platform, host.arch);
};

/** The expected final filename is intentionally host-specific and deterministic. */
export const expectedDesktopArtifactName = (
  version: string,
  target: DesktopArtifactTarget,
): string =>
  `CodexBar Multi-${version}-${target.artifactOs}-${target.artifactArch}${target.expectedExtension}`;

export const desktopArtifactOutputDirectoryName = (target: DesktopArtifactTarget): string =>
  `${target.platform}-${target.arch}`;
