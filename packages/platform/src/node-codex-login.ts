import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, open, readdir, realpath, rm } from "node:fs/promises";
import {
  basename,
  delimiter,
  extname,
  isAbsolute,
  join,
  posix as posixPath,
  relative,
  resolve,
  win32 as win32Path,
} from "node:path";
import { Effect } from "effect";
import { InfrastructureError, type ProcessRunnerService } from "@codexbar/core";
import { parseNodeCodexAuthJson, type ParsedNodeCodexAuth } from "./node-codex-credential.ts";
import { makeNodePrivateDirectoryRestriction } from "./node-private-path-security.ts";

const MAXIMUM_AUTH_BYTES = 1024 * 1024;
const operationIdPattern = /^[A-Za-z0-9_-]{1,64}$/u;

const loginEnvironmentKeys = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  "TMPDIR",
] as const;

/** Excludes provider credentials, NODE_OPTIONS, and arbitrary parent values. */
export const nodeCodexLoginBaseEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    loginEnvironmentKeys.flatMap((key) =>
      environment[key] === undefined ? [] : ([[key, environment[key]]] as const),
    ),
  );

export interface NodeCodexLoginResult extends ParsedNodeCodexAuth {
  readonly credentialJson: string;
  readonly email: string;
}

export interface NodeCodexLoginOptions {
  readonly rootDirectory: string;
  readonly processRunner: ProcessRunnerService;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly command: string;
  readonly timeoutMs?: number;
  readonly createId?: () => string;
  readonly restrictDirectory?: (path: string) => Promise<void>;
}

export interface NodeCodexExecutableResolutionOptions {
  readonly platform?: NodeJS.Platform;
  readonly architecture?: NodeJS.Architecture;
  readonly verify?: (command: string) => Promise<boolean>;
  readonly cancelled?: () => boolean;
}

const loginError = (operation: string): InfrastructureError =>
  new InfrastructureError(
    operation,
    "Codex account login did not complete. No credential was published.",
  );

const safeChild = (rootDirectory: string, childPath: string): boolean => {
  const child = relative(rootDirectory, childPath);
  return (
    child !== "" &&
    child !== ".." &&
    !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(child)
  );
};

/** Lists only native executable locations; npm shell shims are never launched. */
export const nodeCodexLoginExecutableCandidates = (
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
  architecture: NodeJS.Architecture = process.arch,
): ReadonlyArray<string> => {
  const pathApi = platform === "win32" ? win32Path : posixPath;
  const pathDelimiter = platform === "win32" ? ";" : delimiter;
  const explicit = environment.CODEX_CLI_PATH?.trim();
  const pathRoots = (environment.PATH ?? "")
    .split(pathDelimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  const candidates = explicit === undefined || explicit === "" ? [] : [explicit];
  if (platform === "win32") {
    const target =
      architecture === "arm64"
        ? { packageName: "codex-win32-arm64", triple: "aarch64-pc-windows-msvc" }
        : architecture === "x64"
          ? { packageName: "codex-win32-x64", triple: "x86_64-pc-windows-msvc" }
          : undefined;
    if (target !== undefined) {
      const npmRoots = new Set([
        ...(environment.APPDATA === undefined ? [] : [pathApi.join(environment.APPDATA, "npm")]),
        ...pathRoots,
      ]);
      for (const npmRoot of npmRoots) {
        const globalOpenAi = pathApi.join(npmRoot, "node_modules", "@openai");
        for (const packageRoot of [
          pathApi.join(globalOpenAi, "codex", "node_modules", "@openai", target.packageName),
          pathApi.join(globalOpenAi, target.packageName),
        ]) {
          const vendorRoot = pathApi.join(packageRoot, "vendor", target.triple);
          candidates.push(
            pathApi.join(vendorRoot, "bin", "codex.exe"),
            pathApi.join(vendorRoot, "codex", "codex.exe"),
          );
        }
      }
    }
    if (environment.USERPROFILE !== undefined) {
      candidates.push(
        pathApi.join(
          environment.USERPROFILE,
          ".codex",
          "packages",
          "standalone",
          "current",
          "bin",
          "codex.exe",
        ),
      );
    }
    if (environment.LOCALAPPDATA !== undefined) {
      candidates.push(
        pathApi.join(environment.LOCALAPPDATA, "Programs", "OpenAI", "Codex", "bin", "codex.exe"),
      );
    }
    candidates.push(...pathRoots.map((entry) => pathApi.join(entry, "codex.exe")));
  } else {
    candidates.push(...pathRoots.map((entry) => pathApi.join(entry, "codex")));
  }
  return [...new Set(candidates)];
};

/** Resolves and optionally probes one concrete Codex executable before login. */
export const resolveNodeCodexLoginExecutable = async (
  environment: Readonly<Record<string, string | undefined>>,
  options: NodeCodexExecutableResolutionOptions = {},
): Promise<string | undefined> => {
  const platform = options.platform ?? process.platform;
  const candidates = nodeCodexLoginExecutableCandidates(
    environment,
    platform,
    options.architecture ?? process.arch,
  );
  for (const candidate of candidates) {
    if (options.cancelled?.() === true) return undefined;
    if (!isAbsolute(candidate)) continue;
    try {
      const resolved = await realpath(candidate);
      const info = await lstat(resolved);
      if (!info.isFile()) continue;
      if (platform === "win32") {
        if (extname(basename(resolved).toLowerCase()) !== ".exe") continue;
      } else {
        await access(resolved, constants.X_OK);
      }
      if (options.verify !== undefined && !(await options.verify(resolved))) continue;
      if (options.cancelled?.() === true) return undefined;
      return resolved;
    } catch {
      // Try the next host-owned candidate.
    }
  }
  return undefined;
};

/** Executes only `--version` in the scrubbed host environment. */
export const verifyNodeCodexLoginExecutable = (
  command: string,
  processRunner: ProcessRunnerService,
  environment: Readonly<Record<string, string | undefined>>,
): Effect.Effect<boolean> =>
  processRunner
    .run({
      command,
      args: ["--version"],
      env: nodeCodexLoginBaseEnvironment(environment),
      inheritEnvironment: false,
      timeoutMs: 5_000,
    })
    .pipe(
      Effect.map((result) => {
        if (result.exitCode !== 0 || result.signal !== undefined) return false;
        const output = new TextDecoder().decode(result.stdout).trim();
        return /\bcodex(?:-cli)?\s+\d+\.\d+\.\d+\b/iu.test(output);
      }),
      Effect.orElseSucceed(() => false),
    );

const createPrivateLoginHome = (
  options: NodeCodexLoginOptions,
): Effect.Effect<string, InfrastructureError> =>
  Effect.tryPromise({
    try: async () => {
      if (!isAbsolute(options.rootDirectory)) throw new Error("Login root must be absolute");
      const rootDirectory = resolve(options.rootDirectory);
      const operationId = (options.createId ?? randomUUID)();
      if (!operationIdPattern.test(operationId)) throw new Error("Login operation ID is invalid");
      const homeDirectory = join(rootDirectory, operationId);
      if (!safeChild(rootDirectory, homeDirectory)) throw new Error("Login home is outside root");
      const restrict = options.restrictDirectory ?? makeNodePrivateDirectoryRestriction();
      await mkdir(rootDirectory, { recursive: true, mode: 0o700 });
      const rootInfo = await lstat(rootDirectory);
      if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
        throw new Error("Login root must be a real directory");
      }
      await restrict(rootDirectory);
      await mkdir(homeDirectory, { mode: 0o700 });
      const homeInfo = await lstat(homeDirectory);
      if (homeInfo.isSymbolicLink() || !homeInfo.isDirectory()) {
        throw new Error("Login home must be a real directory");
      }
      await restrict(homeDirectory);
      return homeDirectory;
    },
    catch: () => loginError("create Codex login home"),
  });

const readLoginCredential = (
  homeDirectory: string,
): Effect.Effect<NodeCodexLoginResult, InfrastructureError> =>
  Effect.tryPromise({
    try: async () => {
      const path = join(homeDirectory, "auth.json");
      const pathInfo = await lstat(path, { bigint: true });
      if (
        pathInfo.isSymbolicLink() ||
        !pathInfo.isFile() ||
        pathInfo.size > BigInt(MAXIMUM_AUTH_BYTES)
      ) {
        throw new Error("Codex auth file is not a bounded regular file");
      }
      const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let credentialJson: string;
      try {
        const handleInfo = await handle.stat({ bigint: true });
        if (
          !handleInfo.isFile() ||
          handleInfo.size > BigInt(MAXIMUM_AUTH_BYTES) ||
          handleInfo.dev !== pathInfo.dev ||
          handleInfo.ino !== pathInfo.ino
        ) {
          throw new Error("Codex auth file changed while opening");
        }
        credentialJson = await handle.readFile({ encoding: "utf8" });
      } finally {
        await handle.close();
      }
      const parsed = parseNodeCodexAuthJson(credentialJson);
      if (parsed === undefined || parsed.email === undefined) {
        throw new Error("Codex auth identity is incomplete");
      }
      return { ...parsed, email: parsed.email, credentialJson };
    },
    catch: () => loginError("read Codex login credential"),
  });

const removeLoginHome = (rootDirectory: string, homeDirectory: string) =>
  Effect.tryPromise({
    try: async () => {
      const root = resolve(rootDirectory);
      const home = resolve(homeDirectory);
      if (!safeChild(root, home)) throw new Error("Login cleanup target is outside root");
      await rm(home, { recursive: true, force: true });
    },
    catch: () => loginError("clean up Codex login home"),
  });

/**
 * Runs the upstream-compatible `codex login` flow entirely in the Node host.
 * The transient auth file is read only after successful exit and is removed on
 * success, failure, timeout, or Effect cancellation.
 */
export const runNodeCodexLogin = (
  options: NodeCodexLoginOptions,
): Effect.Effect<NodeCodexLoginResult, InfrastructureError> =>
  Effect.acquireUseRelease(
    createPrivateLoginHome(options),
    (homeDirectory) =>
      options.processRunner
        .run({
          command: options.command,
          args: ["login"],
          env: {
            ...nodeCodexLoginBaseEnvironment(options.environment ?? process.env),
            CODEX_HOME: homeDirectory,
          },
          inheritEnvironment: false,
          timeoutMs: options.timeoutMs ?? 120_000,
        })
        .pipe(
          Effect.flatMap((result) =>
            result.exitCode === 0 && result.signal === undefined
              ? readLoginCredential(homeDirectory)
              : Effect.fail(loginError("run Codex login")),
          ),
          Effect.mapError(() => loginError("run Codex login")),
        ),
    (homeDirectory) => removeLoginHome(options.rootDirectory, homeDirectory),
  );

/** Removes crash leftovers under the dedicated login root without following caller paths. */
export const cleanupStaleNodeCodexLoginHomes = (
  rootDirectory: string,
): Effect.Effect<void, InfrastructureError> =>
  Effect.tryPromise({
    try: async () => {
      if (!isAbsolute(rootDirectory)) throw new Error("Login root must be absolute");
      const root = resolve(rootDirectory);
      let entries;
      try {
        const rootInfo = await lstat(root);
        if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
          throw new Error("Login root must be a real directory");
        }
        entries = await readdir(root, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || !operationIdPattern.test(entry.name)) continue;
        const child = join(root, entry.name);
        if (!safeChild(root, child)) throw new Error("Stale login path is outside root");
        await rm(child, { recursive: true, force: true });
      }
    },
    catch: () => loginError("clean up stale Codex login homes"),
  });
