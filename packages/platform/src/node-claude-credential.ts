import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const MAXIMUM_CREDENTIAL_BYTES = 1024 * 1024;
const MAXIMUM_CREDENTIAL_SIZE = BigInt(MAXIMUM_CREDENTIAL_BYTES);

export interface NodeClaudeCredential {
  readonly accessToken?: string;
}

export interface NodeClaudePathApi {
  readonly join: (...paths: string[]) => string;
  readonly isAbsolute: (path: string) => boolean;
}

export interface NodeClaudeFileStat {
  readonly isFile: () => boolean;
  readonly isSymbolicLink: () => boolean;
  readonly size: bigint;
  readonly dev: bigint;
  readonly ino: bigint;
}

export interface NodeClaudeFileHandle {
  readonly stat: (options: { readonly bigint: true }) => NodeClaudeFileStat;
  readonly readFile: () => string;
  readonly close: () => void;
}

export interface NodeClaudeCredentialOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory?: string;
  readonly workingDirectory?: string;
  readonly path?: NodeClaudePathApi;
  readonly platform?: NodeJS.Platform;
  readonly lstat?: (path: string) => NodeClaudeFileStat;
  readonly open?: (path: string, flags: number) => NodeClaudeFileHandle;
}

/**
 * Resolves Claude's `.credentials.json` using Swift `credentialsURL` precedence:
 * `CLAUDE_SECURESTORAGE_CONFIG_DIR` wins when present (empty → default `~/.claude`);
 * otherwise `CLAUDE_CONFIG_DIR` (empty → default). Nonempty values are literal.
 */
export function discoverNodeClaudeCredential(
  options: NodeClaudeCredentialOptions = {},
): NodeClaudeCredential {
  const environment = options.environment ?? process.env;
  const pathApi = options.path ?? { join, isAbsolute };
  const workingDirectory = options.workingDirectory ?? process.cwd();
  const configuredHome = environment.HOME;
  const home =
    options.homeDirectory ??
    (configuredHome !== undefined && configuredHome !== ""
      ? pathApi.isAbsolute(configuredHome)
        ? configuredHome
        : pathApi.join(workingDirectory, configuredHome)
      : homedir());
  const authPath = credentialsPath(environment, home, workingDirectory, pathApi);
  try {
    const sourceText = readPrivateClaudeFile(authPath, options);
    const parsed: unknown = JSON.parse(sourceText);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const claude = (parsed as Record<string, unknown>).claudeAiOauth;
    if (typeof claude !== "object" || claude === null || Array.isArray(claude)) return {};
    const accessToken = nonEmptyString((claude as Record<string, unknown>).accessToken);
    if (accessToken === undefined) return {};
    return { accessToken };
  } catch {
    return {};
  }
}

const credentialsPath = (
  environment: Readonly<Record<string, string | undefined>>,
  home: string,
  workingDirectory: string,
  pathApi: NodeClaudePathApi,
): string => {
  const defaultRoot = pathApi.join(home, ".claude");
  const resolveRoot = (raw: string): string =>
    pathApi.isAbsolute(raw) ? raw : pathApi.join(workingDirectory, raw);
  const secure = environment.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  let root: string;
  if (secure !== undefined) {
    root = secure === "" ? defaultRoot : resolveRoot(secure);
  } else {
    const configured = environment.CLAUDE_CONFIG_DIR;
    root = configured !== undefined && configured !== "" ? resolveRoot(configured) : defaultRoot;
  }
  return pathApi.join(root, ".credentials.json");
};

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

const openFlags = (platform: NodeJS.Platform): number =>
  platform === "win32" || constants.O_NOFOLLOW === undefined
    ? constants.O_RDONLY
    : constants.O_RDONLY | constants.O_NOFOLLOW;

const readPrivateClaudeFile = (path: string, options: NodeClaudeCredentialOptions): string => {
  const lstat = options.lstat ?? lstatClaudeFile;
  const openFile = options.open ?? openClaudeFile;
  const before = lstat(path);
  if (before.isSymbolicLink() || !before.isFile())
    throw new Error("Claude credentials file is not regular");
  if (before.size > MAXIMUM_CREDENTIAL_SIZE)
    throw new Error("Claude credentials file exceeds 1 MiB");
  const handle = openFile(path, openFlags(options.platform ?? process.platform));
  try {
    const after = handle.stat({ bigint: true });
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino)
      throw new Error("Claude credentials file changed before read");
    if (after.size > MAXIMUM_CREDENTIAL_SIZE)
      throw new Error("Claude credentials file exceeds 1 MiB");
    return handle.readFile();
  } finally {
    handle.close();
  }
};

const lstatClaudeFile = (path: string): NodeClaudeFileStat => lstatSync(path, { bigint: true });

const openClaudeFile = (path: string, flags: number): NodeClaudeFileHandle => {
  const fd = openSync(path, flags);
  return {
    stat: () => fstatSync(fd, { bigint: true }),
    readFile: () => {
      const buffer = Buffer.alloc(MAXIMUM_CREDENTIAL_BYTES + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const chunk = readSync(fd, buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (chunk === 0) break;
        bytesRead += chunk;
      }
      if (bytesRead > MAXIMUM_CREDENTIAL_BYTES)
        throw new Error("Claude credentials file exceeds 1 MiB");
      return buffer.subarray(0, bytesRead).toString("utf8");
    },
    close: () => closeSync(fd),
  };
};
