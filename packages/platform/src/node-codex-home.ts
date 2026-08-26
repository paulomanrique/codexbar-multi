import { posix, win32 } from "node:path";

const pathsFor = (platform: NodeJS.Platform) => (platform === "win32" ? win32 : posix);

export const normalizeNodeCodexProfileHome = (
  rawPath: string | undefined,
  homeDirectory: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined => {
  let path = rawPath?.trim();
  if (path === undefined || path === "") return undefined;
  const paths = pathsFor(platform);
  if (path === "~") {
    path = homeDirectory;
  } else if (path.startsWith("~/") || path.startsWith("~\\")) {
    path = paths.join(homeDirectory, path.slice(2));
  } else if (path.startsWith("~")) {
    return undefined;
  }
  if (!paths.isAbsolute(path)) return undefined;
  return paths.normalize(path);
};

export const resolveNodeCodexHome = (
  environment: Readonly<Record<string, string | undefined>>,
  homeDirectory: string,
  platform: NodeJS.Platform = process.platform,
  workingDirectory?: string,
): string => {
  const paths = pathsFor(platform);
  const configured = environment.CODEX_HOME?.trim();
  if (configured === undefined || configured === "") return paths.join(homeDirectory, ".codex");
  if (configured === "~") return homeDirectory;
  if (configured.startsWith("~/") || configured.startsWith("~\\")) {
    return paths.join(homeDirectory, configured.slice(2));
  }
  return workingDirectory === undefined
    ? paths.resolve(configured)
    : paths.resolve(workingDirectory, configured);
};
