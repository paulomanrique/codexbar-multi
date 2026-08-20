import { homedir } from "node:os";
import { posix, win32 } from "node:path";

/**
 * Resolve the CLI configuration location at the Node composition boundary.
 *
 * `CODEXBAR_CONFIG` is deliberately an explicit opt-in override. The default
 * namespace is CodexBar Multi and does not discover the legacy CodexBar
 * location, which keeps an import from the Swift application intentional.
 */
export const resolveCLIConfigPath = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
): string => {
  const path = platform === "win32" ? win32 : posix;
  const override = environment.CODEXBAR_CONFIG?.trim();
  if (override !== undefined && override.length > 0) {
    const expanded = override.startsWith("~")
      ? path.join(home, override.slice(1).replace(/^[/\\]/u, ""))
      : override;
    return path.isAbsolute(expanded) ? expanded : path.resolve(expanded);
  }

  const configRoot =
    platform === "win32"
      ? environment.APPDATA?.trim() || path.join(home, "AppData", "Roaming")
      : environment.XDG_CONFIG_HOME?.trim() || path.join(home, ".config");
  return path.join(configRoot, "codexbar-multi", "config.json");
};
