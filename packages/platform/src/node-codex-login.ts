import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Effect } from "effect";
import { InfrastructureError, type ProcessRunnerService } from "@codexbar/core";
import { parseNodeCodexAuthJson, type ParsedNodeCodexAuth } from "./node-codex-credential.ts";
import { makeNodePrivateDirectoryRestriction } from "./node-private-path-security.ts";

const MAXIMUM_AUTH_BYTES = 1024 * 1024;

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
}

export interface NodeCodexLoginOptions {
  readonly rootDirectory: string;
  readonly processRunner: ProcessRunnerService;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly command?: string;
  readonly timeoutMs?: number;
  readonly createId?: () => string;
  readonly restrictDirectory?: (path: string) => Promise<void>;
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

const createPrivateLoginHome = (
  options: NodeCodexLoginOptions,
): Effect.Effect<string, InfrastructureError> =>
  Effect.tryPromise({
    try: async () => {
      if (!isAbsolute(options.rootDirectory)) throw new Error("Login root must be absolute");
      const rootDirectory = resolve(options.rootDirectory);
      const homeDirectory = join(rootDirectory, (options.createId ?? randomUUID)());
      if (!safeChild(rootDirectory, homeDirectory)) throw new Error("Login home is outside root");
      const restrict = options.restrictDirectory ?? makeNodePrivateDirectoryRestriction();
      await mkdir(rootDirectory, { recursive: true, mode: 0o700 });
      await restrict(rootDirectory);
      await mkdir(homeDirectory, { mode: 0o700 });
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
      const info = await lstat(path, { bigint: true });
      if (info.isSymbolicLink() || !info.isFile() || info.size > BigInt(MAXIMUM_AUTH_BYTES)) {
        throw new Error("Codex auth file is not a bounded regular file");
      }
      const credentialJson = await readFile(path, "utf8");
      const parsed = parseNodeCodexAuthJson(credentialJson);
      if (parsed === undefined || parsed.email === undefined) {
        throw new Error("Codex auth identity is incomplete");
      }
      return { ...parsed, credentialJson };
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
          command: options.command ?? "codex",
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
        entries = await readdir(root, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        const child = join(root, entry.name);
        if (!safeChild(root, child)) throw new Error("Stale login path is outside root");
        await rm(child, { recursive: true, force: true });
      }
    },
    catch: () => loginError("clean up stale Codex login homes"),
  });
