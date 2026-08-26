import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, posix, relative, resolve, win32 } from "node:path";
import { Entry } from "@napi-rs/keyring";
import { Effect } from "effect";
import type { AppPaths } from "@codexbar/core";
import {
  type ClockService,
  type CredentialStoreService,
  type HttpRequest,
  type HttpResponse,
  type HttpTransportService,
  InfrastructureError,
  MissingBrowserCredentialError,
  type ProcessResult,
  type ProcessRunnerService,
  type ProcessSpec,
  type PrivateFileStoreService,
} from "@codexbar/core";
import type {
  DefaultBrowserSessionStatusesDTO,
  DefaultBrowserSessionStatusStateDTO,
  ProviderId,
} from "@codexbar/contracts";
import type {
  FirstPartyBrowserSessions,
  FirstPartyLocalCapabilities,
  FirstPartySettings,
} from "./first-party-runtime.ts";
import {
  browserSessionCredentialKeys,
  usesAccountScopedBrowserSession,
} from "./account-scoped-browser-session.ts";
import {
  parseGrokAuthJson,
  parseGrokLocalSessionSignal,
  summarizeGrokLocalSessions,
  type ProviderLocalCommand,
} from "@codexbar/providers";
import { resolveClaudeSwapExecutablePath } from "./claude-swap.ts";
import {
  scanNodeGrokLocalSessions,
  type NodeGrokLocalSessionScanOptions,
} from "./node-grok-local-session.ts";
import {
  isNodeGrokCliCommand,
  nodeGrokCliEnvironment,
  runNodeGrokCliBilling,
} from "./node-grok-rpc.ts";
import {
  makeNodePrivateDirectoryRestriction,
  makeNodePrivateFileRestriction,
  type NodePrivatePathRestrictionOptions,
} from "./node-private-path-security.ts";
import {
  fetchNodeAntigravityLocalSnapshot,
  makeNodeAntigravityLocalDependencies,
} from "./node-antigravity-local.ts";
import { discoverNodeClaudeCredential } from "./node-claude-credential.ts";
import { discoverNodeCodexCredential } from "./node-codex-credential.ts";
import { terminateProcessTree } from "./node-process-terminator.ts";

export * from "./node-persistence.ts";
export * from "./node-token-account-migration-lock.ts";
export * from "./token-account-vault-config.ts";
export * from "./browser-session-cleanup-journal.ts";
export * from "./node-antigravity-local.ts";
export * from "./node-persistence-worker-client.ts";
export * from "./first-party-runtime.ts";
export * from "./node-process-terminator.ts";
export * from "./legacy-import.ts";
export * from "./node-cost-jsonl.ts";
export * from "./node-codex-priority.ts";
export * from "./node-codex-login.ts";
export * from "./node-local-cost-scan.ts";
export * from "./node-grok-local-session.ts";
export * from "./node-grok-local-token-scan.ts";
export * from "./node-grok-rpc.ts";
export * from "./node-private-path-security.ts";
export * from "./persisted-provider-settings.ts";

/** Node's explicit equivalent of Swift's `NSString.expandingTildeInPath`. */
export const resolveNodeClaudeSwapExecutablePath = (configuredPath: string): string => {
  const resolved = resolveClaudeSwapExecutablePath(configuredPath);
  if (resolved === "~") return homedir();
  if (resolved.startsWith("~/") || resolved.startsWith("~\\"))
    return join(homedir(), resolved.slice(2));
  return resolved;
};

const claudeSwapEnvironmentKeys = [
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

/**
 * The Claude Swap helper inherits only the OS/session values it needs to find
 * its own credential store. Provider tokens and arbitrary parent environment
 * values are deliberately excluded.
 */
export const claudeSwapProcessEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    claudeSwapEnvironmentKeys.flatMap((key) =>
      environment[key] === undefined ? [] : ([[key, environment[key]]] as const),
    ),
  );

/**
 * Node exposes POSIX modes but no safe, dependency-free API for editing a
 * Windows DACL. Hosts that own a native Windows ACL adapter can inject it
 * here; the private-store algorithm applies it to the staged inode before it
 * is atomically published. This keeps OS policy at the platform boundary.
 */
export interface NodePrivateFileStoreOptions {
  readonly restrictFile?: (path: string) => Promise<void>;
  readonly restrictDirectory?: (path: string) => Promise<void>;
  /** Injectable native policy. Defaults to a real Windows DACL on win32. */
  readonly pathRestrictionOptions?: NodePrivatePathRestrictionOptions;
}

/**
 * Node-only file/path adapter. It is intentionally isolated from core so a
 * renderer or another host can provide the same capabilities without Node.
 */
export const makeNodePrivateFileStore = (options: NodePrivateFileStoreOptions = {}) => {
  const restrictFile =
    options.restrictFile ?? makeNodePrivateFileRestriction(options.pathRestrictionOptions);
  const restrictDirectory =
    options.restrictDirectory ??
    makeNodePrivateDirectoryRestriction(options.pathRestrictionOptions);
  return {
    read: (path: string) =>
      Effect.tryPromise({
        try: async () => {
          try {
            return new Uint8Array(await readFile(path));
          } catch (error: unknown) {
            if (isMissing(error)) return undefined;
            throw error;
          }
        },
        catch: (error) =>
          new InfrastructureError(
            "read private file",
            `Unable to read private file: ${path}`,
            error,
          ),
      }),
    writeAtomic: (path: string, content: Uint8Array) =>
      Effect.tryPromise({
        try: async () => {
          await mkdir(dirname(path), { recursive: true, mode: 0o700 });
          const directory = dirname(path);
          await restrictDirectory(directory);
          const temporary = join(directory, `.${randomUUID()}.tmp`);
          const previous = await preserveExistingPrivateFile(path, directory, restrictFile);
          let preservePreviousRecovery = false;
          try {
            const file = await open(temporary, "w", 0o600);
            try {
              await restrictFile(temporary);
              await file.writeFile(content);
              await file.sync();
            } finally {
              await file.close();
            }
            await rename(temporary, path);
            // NTFS may assign a new descriptor while publishing a rename.
            // The directory is already private, then the final name is
            // restricted again before the operation is reported as complete.
            try {
              await restrictFile(path);
            } catch (error) {
              await removeUnsafePublishedFile(path);
              preservePreviousRecovery = !(await restorePreviousPrivateFile(
                previous,
                path,
                restrictFile,
              ));
              throw error;
            }
            await syncDirectory(directory);
          } finally {
            await rm(temporary, { force: true });
            if (previous !== undefined && !preservePreviousRecovery)
              await rm(previous, { force: true });
          }
        },
        catch: (error) =>
          new InfrastructureError(
            "write private file",
            `Unable to atomically write private file: ${path}`,
            error,
          ),
      }),
    /**
     * Publishes a private file only when no entry already exists at `path`.
     *
     * `rename` intentionally is not used here: on the platforms we support it
     * replaces an existing destination and turns a prior `exists` check into a
     * TOCTOU bug. A same-directory hard link is an atomic create-or-exists
     * operation on the local filesystems supported by Node. The staged inode is
     * fsynced before publication, and only the directory entry survives after
     * the staging name is removed.
     */
    writeAtomicIfAbsent: (path: string, content: Uint8Array) =>
      Effect.tryPromise({
        try: async () => {
          const directory = dirname(path);
          await mkdir(directory, { recursive: true, mode: 0o700 });
          await restrictDirectory(directory);
          const temporary = join(directory, `.${randomUUID()}.tmp`);
          try {
            const file = await open(temporary, "wx", 0o600);
            try {
              await restrictFile(temporary);
              await file.writeFile(content);
              await file.sync();
            } finally {
              await file.close();
            }

            try {
              await link(temporary, path);
            } catch (error) {
              if (isAlreadyExists(error)) return false;
              throw error;
            }
            await syncDirectory(directory);
            return true;
          } finally {
            await rm(temporary, { force: true });
          }
        },
        catch: (error) =>
          new InfrastructureError(
            "create private file",
            `Unable to atomically create private file: ${path}`,
            error,
          ),
      }),
    remove: (path: string) =>
      Effect.tryPromise({
        try: async () => {
          await rm(path, { force: true });
        },
        catch: (error) =>
          new InfrastructureError(
            "remove private file",
            `Unable to remove private file: ${path}`,
            error,
          ),
      }),
  };
};

export const makeNodePlatformPaths = (
  root: string,
): { readonly resolve: Effect.Effect<AppPaths> } => ({
  resolve: Effect.succeed({
    appData: join(root, "data"),
    cache: join(root, "cache"),
    config: join(root, "config"),
    logs: join(root, "logs"),
    temporary: join(root, "tmp"),
  }),
});

const isMissing = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

const isAlreadyExists = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";

/**
 * A post-rename ACL failure must never leave the new private content exposed.
 * A hard link keeps the prior inode available without copying its contents,
 * so rollback does not depend on reading or reserializing a config value.
 */
const preserveExistingPrivateFile = async (
  path: string,
  directory: string,
  restrictFile: (path: string) => Promise<void>,
): Promise<string | undefined> => {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  // `rename` safely replaces a symlink, but it is never safe to retain one as
  // a rollback target. The directory has already been restricted above.
  if (info.isSymbolicLink() || !info.isFile()) return undefined;
  await restrictFile(path);
  const backup = join(directory, `.${randomUUID()}.previous`);
  await link(path, backup);
  return backup;
};

const removeUnsafePublishedFile = async (path: string): Promise<void> => {
  try {
    await rm(path, { force: true });
  } catch {
    // The caller is already failing closed. A retry below can restore only if
    // the unsafe name was removed; otherwise the original ACL error remains.
  }
};

const restorePreviousPrivateFile = async (
  previous: string | undefined,
  path: string,
  restrictFile: (path: string) => Promise<void>,
): Promise<boolean> => {
  if (previous === undefined) return true;
  try {
    await link(previous, path);
    await restrictFile(path);
    return true;
  } catch {
    // Do not leave an uncertain final name after a failed recovery. The
    // private previous inode remains under its staging name for recovery.
    await rm(path, { force: true });
    return false;
  }
};

/** Directory fsync makes the rename durable on filesystems that support it. */
const syncDirectory = async (path: string): Promise<void> => {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } catch (error) {
    // Windows does not permit fsync on directory handles. The rename remains atomic there.
    if (!isUnsupportedDirectorySync(error)) throw error;
  } finally {
    await directory.close();
  }
};

const isUnsupportedDirectorySync = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error.code === "EINVAL" || error.code === "EPERM" || error.code === "ENOTSUP");

interface NativeKeyringEntry {
  readonly getPassword: () => string | null;
  readonly setPassword: (value: string) => void;
  readonly deletePassword: () => unknown;
}

/**
 * Shared desktop/CLI credential store backed by Keychain, Credential Manager,
 * Secret Service, or KWallet through the platform keyring. A missing or locked
 * Linux keyring is reported as an InfrastructureError; plaintext is never used.
 */
export const makeNativeCredentialStore = (
  service = "com.paulomanrique.codexbar-multi",
  makeEntry: (service: string, key: string) => NativeKeyringEntry = (name, key) =>
    new Entry(name, key),
) => ({
  read: (key: string) =>
    Effect.try({
      try: () => makeEntry(service, key).getPassword() ?? undefined,
      catch: (error) =>
        new InfrastructureError(
          "read credential",
          `Native credential storage is unavailable or locked for '${key}'. No plaintext fallback is permitted.`,
          error,
        ),
    }),
  write: (key: string, value: string) =>
    Effect.try({
      try: () => makeEntry(service, key).setPassword(value),
      catch: (error) =>
        new InfrastructureError(
          "write credential",
          `Native credential storage is unavailable or locked for '${key}'. No plaintext fallback is permitted.`,
          error,
        ),
    }),
  remove: (key: string) =>
    Effect.try({
      try: () => {
        makeEntry(service, key).deletePassword();
      },
      catch: (error) =>
        new InfrastructureError(
          "remove credential",
          `Native credential storage is unavailable or locked for '${key}'.`,
          error,
        ),
    }),
});

const maximumLocalOutputBytes = 1024 * 1024;

/**
 * Node process adapter used only at the platform boundary. It never invokes a
 * shell, bounds output, and terminates its child when the Effect is aborted.
 */
export interface NodeProcessRunnerOptions {
  readonly maximumOutputBytes?: number;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly terminateProcessTreeImpl?: (pid: number) => Promise<void>;
}

const abortError = (message = "Process execution was cancelled."): Error => {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
};

export const makeNodeProcessRunner = (
  options: NodeProcessRunnerOptions = {},
): ProcessRunnerService => {
  const maximumOutputBytes = options.maximumOutputBytes ?? maximumLocalOutputBytes;
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const terminator =
    options.terminateProcessTreeImpl ??
    ((pid: number) => terminateProcessTree(pid, { platform, environment }));
  return {
    run: (spec) =>
      Effect.tryPromise({
        try: (signal) =>
          runNodeProcess(spec, signal, maximumOutputBytes, environment, platform, terminator),
        catch: (error) =>
          new InfrastructureError("run process", `Unable to run '${spec.command}'.`, error),
      }),
  };
};

const runNodeProcess = (
  spec: ProcessSpec,
  signal: AbortSignal,
  maximumOutputBytes: number,
  baseEnvironment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
  terminator: (pid: number) => Promise<void>,
): Promise<ProcessResult> =>
  new Promise((resolvePromise, rejectPromise) => {
    type Outcome = "running" | "killing" | "settled";
    let outcome: Outcome = "running";
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let child: ReturnType<typeof spawn> | undefined;
    const abortHandler = (): void => {
      void fail(abortError());
    };
    const settle = (callback: () => void): void => {
      if (outcome === "settled") return;
      outcome = "settled";
      if (timeout !== undefined) clearTimeout(timeout);
      signal.removeEventListener("abort", abortHandler);
      callback();
    };
    const killTree = async (): Promise<void> => {
      if (child?.pid !== undefined) await terminator(child.pid);
      else child?.kill("SIGKILL");
    };
    const fail = async (error: Error): Promise<void> => {
      if (outcome !== "running") return;
      outcome = "killing";
      if (timeout !== undefined) clearTimeout(timeout);
      signal.removeEventListener("abort", abortHandler);
      try {
        await killTree();
      } catch {
        try {
          child?.kill("SIGKILL");
        } catch {
          // Termination already attempted.
        }
      }
      settle(() => rejectPromise(error));
    };
    if (signal.aborted) {
      rejectPromise(abortError());
      return;
    }
    try {
      child = spawn(spec.command, [...(spec.args ?? [])], {
        cwd: spec.cwd,
        env: Object.fromEntries(
          Object.entries({
            ...(spec.inheritEnvironment === false ? {} : baseEnvironment),
            ...spec.env,
          }).filter((entry): entry is [string, string] => entry[1] !== undefined),
        ),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        // POSIX process-group kill (`-pid`) requires the child to be a leader.
        ...(platform === "win32" ? {} : { detached: true }),
      });
    } catch (error) {
      rejectPromise(error);
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    const append = (target: Buffer[], value: Buffer) => {
      size += value.byteLength;
      if (size > maximumOutputBytes) {
        void fail(new Error("Process output exceeded 1 MiB."));
        return;
      }
      target.push(value);
    };
    child.stdout?.on("data", (value: Buffer) => append(stdout, value));
    child.stderr?.on("data", (value: Buffer) => append(stderr, value));
    child.once("error", (error) => {
      void fail(error instanceof Error ? error : new Error(String(error)));
    });
    child.once("close", (exitCode, exitSignal) => {
      if (outcome !== "running") return;
      settle(() =>
        resolvePromise({
          exitCode: exitCode ?? undefined,
          signal: exitSignal ?? undefined,
          stdout: new Uint8Array(Buffer.concat(stdout)),
          stderr: new Uint8Array(Buffer.concat(stderr)),
        }),
      );
    });
    signal.addEventListener("abort", abortHandler, { once: true });
    // `spawn()` is synchronous and can take longer than a short cancellation
    // deadline on a loaded Windows host. AbortSignal does not replay an abort
    // event to listeners registered after it fired, so close that window
    // explicitly before handing any input to the child.
    if (signal.aborted) {
      abortHandler();
      return;
    }
    if (spec.stdin !== undefined) child.stdin?.end(spec.stdin);
    else child.stdin?.end();
    const timeoutMs = spec.timeoutMs;
    if (timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        void fail(new Error(`Process timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
    }
  });

const executableByCommand: Readonly<Record<ProviderLocalCommand, { readonly env: string }>> = {
  amp: { env: "AMP_CLI_PATH" },
  "kiro-cli": { env: "KIRO_CLI_PATH" },
};

const grokHomeDirectory = (
  environment: Readonly<Record<string, string | undefined>>,
  home: string,
  platform: NodeJS.Platform = process.platform,
): string => {
  const paths = platform === "win32" ? win32 : posix;
  const configured = environment.GROK_HOME?.trim();
  if (configured === undefined || configured === "") return paths.join(home, ".grok");
  if (configured === "~") return home;
  if (configured.startsWith("~/") || configured.startsWith("~\\"))
    return paths.join(home, configured.slice(2));
  return configured;
};

/** Resolves only Grok Build's documented auth file, without leaking its path to a provider. */
export const nodeGrokAuthFilePath = (
  environment: Readonly<Record<string, string | undefined>>,
  home: string,
  platform: NodeJS.Platform = process.platform,
): string => {
  const paths = platform === "win32" ? win32 : posix;
  return paths.join(grokHomeDirectory(environment, home, platform), "auth.json");
};

const jetBrainsIDEPrefixes = [
  "IntelliJIdea",
  "PyCharm",
  "WebStorm",
  "GoLand",
  "CLion",
  "DataGrip",
  "RubyMine",
  "Rider",
  "PhpStorm",
  "AppCode",
  "Fleet",
  "AndroidStudio",
  "RustRover",
  "Aqua",
  "DataSpell",
] as const;
const jetBrainsQuotaFile = join("options", "AIAssistantQuotaManager2.xml");

export interface NodeFirstPartyLocalCapabilitiesOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory?: string;
  /** Explicit roots make IDE discovery deterministic in tests and alternate hosts. */
  readonly jetBrainsRoots?: readonly string[];
  readonly processRunner?: ProcessRunnerService;
  /** Optional injected private reader; raw IDE configuration never reaches providers. */
  readonly privateFiles?: Pick<PrivateFileStoreService, "read">;
  /** Injectable transport for the fixed Kiro endpoint; tests never need live network access. */
  readonly fetchImpl?: typeof fetch;
  /** Injectable for deterministic cross-platform Kiro state-path tests. */
  readonly platform?: NodeJS.Platform;
  /** Test/alternate-host scanner options; paths remain private to this module. */
  readonly grokLocalSessionScan?: Omit<NodeGrokLocalSessionScanOptions, "signal">;
  /** Test seam for the narrow Antigravity broker; production uses native discovery. */
  readonly antigravityLocalFetch?: (
    signal: AbortSignal,
  ) => Promise<import("@codexbar/providers").ProviderAntigravityLocalSnapshot>;
  /** One-shot CLI-only opt-in for a same-user external `agy` process. */
  readonly antigravityExternalCLIPath?: string;
}

/**
 * Platform implementation of the named first-party local broker. It accepts
 * only commands and data identifiers that the provider runtime also checks;
 * neither providers nor renderers can supply a shell command or file path.
 */
export const makeNodeFirstPartyLocalCapabilities = (
  options: NodeFirstPartyLocalCapabilitiesOptions = {},
): FirstPartyLocalCapabilities => {
  const environment = options.environment ?? process.env;
  const processRunner = options.processRunner ?? makeNodeProcessRunner();
  const privateFiles = options.privateFiles ?? makeNodePrivateFileStore();
  const roots =
    options.jetBrainsRoots ?? jetBrainsConfigRoots(environment, options.homeDirectory ?? homedir());
  return {
    fetchAntigravityLocalSnapshot: (providerId) =>
      Effect.tryPromise({
        try: (signal) => {
          if (providerId !== "antigravity")
            throw new Error("Provider Antigravity local usage is not allowlisted.");
          return (
            options.antigravityLocalFetch ??
            ((operationSignal: AbortSignal) =>
              fetchNodeAntigravityLocalSnapshot(
                makeNodeAntigravityLocalDependencies({
                  processRunner,
                  environment,
                  platform: options.platform ?? process.platform,
                  ...(options.antigravityExternalCLIPath === undefined
                    ? {}
                    : { externalCLIPath: options.antigravityExternalCLIPath }),
                }),
                { signal: operationSignal, platform: options.platform ?? process.platform },
              ))
          )(signal);
        },
        catch: (error) =>
          isAbort(error)
            ? error
            : new InfrastructureError(
                "read Antigravity local usage",
                "Antigravity local usage probe failed.",
                error,
              ),
      }),
    run: (providerId, command, request) => {
      if (
        (providerId !== "amp" && providerId !== "kiro") ||
        (providerId === "amp" && command !== "amp") ||
        (providerId === "kiro" && command !== "kiro-cli")
      ) {
        return Effect.fail(
          new InfrastructureError("local command", "Provider command is not allowlisted."),
        );
      }
      const configured = environment[executableByCommand[command].env]?.trim();
      if (configured !== undefined && configured !== "" && !isSafeExecutable(configured)) {
        return Effect.fail(
          new InfrastructureError("local command", "Configured executable path is invalid."),
        );
      }
      return processRunner
        .run({
          command: configured || command,
          args: request.args,
          ...(command === "amp" ? { env: { NO_COLOR: "1" } } : {}),
          ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
        })
        .pipe(
          Effect.map((result) => ({
            exitCode: result.exitCode,
            signal: result.signal,
            stdout: decodeLocalText(result.stdout),
            stderr: decodeLocalText(result.stderr),
          })),
        );
    },
    readData: (providerId, source, request) => {
      if (providerId !== "jetbrains" || source !== "jetbrains-ai-quota")
        return Effect.fail(
          new InfrastructureError("local data", "Provider data source is not allowlisted."),
        );
      return Effect.tryPromise({
        try: () =>
          readJetBrainsQuota(roots, request?.basePath, async (path) => {
            const content = await Effect.runPromise(privateFiles.read(path));
            if (content === undefined) return undefined;
            if (content.byteLength > maximumLocalOutputBytes)
              throw new Error("JetBrains quota file exceeded 1 MiB.");
            return new TextDecoder("utf-8", { fatal: true }).decode(content);
          }),
        catch: (error) =>
          new InfrastructureError(
            "read JetBrains quota",
            "Unable to read JetBrains quota data.",
            error,
          ),
      });
    },
    fetchKiroUsageLimits: (providerId) => {
      if (providerId !== "kiro")
        return Effect.fail(
          new InfrastructureError("Kiro usage limits", "Kiro usage limits are not allowlisted."),
        );
      return Effect.tryPromise({
        try: async (signal) => {
          const identity = readKiroCLIIdentity(
            kiroStateDatabasePath(
              environment,
              options.homeDirectory ?? homedir(),
              options.platform ?? process.platform,
            ),
          );
          const timeout = AbortSignal.timeout(10_000);
          const response = await (options.fetchImpl ?? globalThis.fetch)(
            "https://codewhisperer.us-east-1.amazonaws.com/",
            {
              method: "POST",
              redirect: "error",
              signal: AbortSignal.any([signal, timeout]),
              headers: {
                "Content-Type": "application/x-amz-json-1.0",
                "X-Amz-Target": "AmazonCodeWhispererService.GetUsageLimits",
                Authorization: `Bearer ${identity.accessToken}`,
              },
              body: JSON.stringify({ profileArn: identity.profileArn }),
            },
          );
          return {
            status: response.status,
            bodyText: new TextDecoder("utf-8", { fatal: true }).decode(await boundedBody(response)),
          };
        },
        catch: (error) =>
          isAbort(error)
            ? error
            : new InfrastructureError(
                "Kiro usage limits",
                "Unable to read Kiro usage-limit data.",
                error,
              ),
      });
    },
    fetchGrokLocalSessionSummary: (providerId) =>
      Effect.tryPromise({
        try: async (signal) => {
          if (providerId !== "grok") throw new Error("Provider local activity is not allowlisted.");
          // Preserve an injected scanner clock in tests and keep both the
          // lookback cutoff and local-day publication tied to one instant.
          const now = options.grokLocalSessionScan?.now ?? new Date();
          const scanned = await scanNodeGrokLocalSessions({
            ...options.grokLocalSessionScan,
            environment,
            homeDirectory: options.homeDirectory ?? homedir(),
            platform: options.platform ?? process.platform,
            now,
            signal,
          });
          return summarizeGrokLocalSessions(
            scanned.signals.flatMap((entry) => {
              const parsed = parseGrokLocalSessionSignal(entry.json, entry.modifiedAtMs);
              return parsed === undefined ? [] : [parsed];
            }),
            { includeDaily: true, scannedAtMs: now.getTime(), truncated: scanned.truncated },
          );
        },
        catch: (error) =>
          new InfrastructureError(
            "read Grok local sessions",
            "Grok local session scan failed",
            error,
          ),
      }),
    fetchGrokCredentials: (providerId) =>
      Effect.tryPromise({
        try: async () => {
          if (providerId !== "grok") throw new Error("Provider Grok OIDC is not allowlisted.");
          const content = await Effect.runPromise(
            privateFiles.read(
              nodeGrokAuthFilePath(
                environment,
                options.homeDirectory ?? homedir(),
                options.platform ?? process.platform,
              ),
            ),
          );
          if (content === undefined) return undefined;
          if (content.byteLength > maximumLocalOutputBytes)
            throw new Error("Grok auth file exceeded 1 MiB.");
          return parseGrokAuthJson(content);
        },
        catch: (error) =>
          new InfrastructureError(
            "read Grok credentials",
            "Unable to read Grok OIDC credentials.",
            error,
          ),
      }),
    fetchGrokCliBilling: (providerId) => {
      if (providerId !== "grok")
        return Effect.fail(
          new InfrastructureError("Grok CLI billing", "Provider Grok CLI is not allowlisted."),
        );
      const configured = environment.GROK_CLI_PATH?.trim();
      if (configured !== undefined && configured !== "" && !isNodeGrokCliCommand(configured)) {
        return Effect.fail(
          new InfrastructureError(
            "Grok CLI billing",
            "Configured Grok executable path is invalid.",
          ),
        );
      }
      return Effect.tryPromise({
        try: (signal) => {
          const command = configured || "grok";
          const home = options.homeDirectory ?? homedir();
          const platform = options.platform ?? process.platform;
          return runNodeGrokCliBilling({
            command,
            environment: nodeGrokCliEnvironment(environment, home, platform, command),
            signal,
          });
        },
        catch: (error) =>
          new InfrastructureError(
            "Grok CLI billing",
            "Unable to read Grok CLI billing data.",
            error,
          ),
      });
    },
  };
};

type KiroCLIIdentity = { readonly accessToken: string; readonly profileArn: string };

/** Resolves only Kiro's documented CLI state location; no caller-controlled paths are accepted. */
export const kiroStateDatabasePath = (
  environment: Readonly<Record<string, string | undefined>>,
  home: string,
  platform: NodeJS.Platform,
): string => {
  const paths = platform === "win32" ? win32 : posix;
  const directory = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim();
    if (trimmed === undefined || trimmed === "") return undefined;
    return trimmed === "~"
      ? home
      : trimmed.startsWith("~/") || trimmed.startsWith("~\\")
        ? paths.join(home, trimmed.slice(2))
        : trimmed;
  };
  const override = directory(environment.KIRO_DATA_DIR);
  if (override !== undefined) return paths.join(override, "data.sqlite3");
  if (platform === "darwin")
    return paths.join(home, "Library", "Application Support", "kiro-cli", "data.sqlite3");
  if (platform === "win32")
    return paths.join(
      directory(environment.LOCALAPPDATA) ?? paths.join(home, "AppData", "Local"),
      "Kiro-Cli",
      "data.sqlite3",
    );
  return paths.join(
    directory(environment.XDG_DATA_HOME) ?? paths.join(home, ".local", "share"),
    "kiro-cli",
    "data.sqlite3",
  );
};

/** Reads the CLI's state database read-only and keeps both credential fields inside platform code. */
const readKiroCLIIdentity = (databasePath: string): KiroCLIIdentity => {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    // Match the CLI-side probe's short contention budget without ever taking a write lock.
    database.exec("PRAGMA busy_timeout = 250");
    const read = (sql: string, field: string): string => {
      const row = database.prepare(sql).get() as { readonly value?: unknown } | undefined;
      if (
        typeof row?.value !== "string" ||
        row.value.length === 0 ||
        row.value.length > maximumLocalOutputBytes
      )
        throw new Error(`Kiro CLI ${field} is unavailable.`);
      return row.value;
    };
    const token = JSON.parse(
      read("SELECT value FROM auth_kv WHERE key = 'kirocli:odic:token'", "token"),
    ) as { readonly access_token?: unknown };
    const profile = JSON.parse(
      read("SELECT value FROM state WHERE key = 'api.codewhisperer.profile'", "profile"),
    ) as { readonly arn?: unknown };
    if (typeof token.access_token !== "string" || token.access_token.length === 0)
      throw new Error("Kiro CLI token has no access token.");
    if (typeof profile.arn !== "string" || profile.arn.length === 0)
      throw new Error("Kiro CLI profile has no ARN.");
    return { accessToken: token.access_token, profileArn: profile.arn };
  } finally {
    database.close();
  }
};

const isAbort = (error: unknown): boolean =>
  error instanceof Error && (error.name === "AbortError" || error.name === "CanceledError");

const isSafeExecutable = (value: string): boolean =>
  !value.includes("\u0000") && (isAbsolute(value) || /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(value));

const decodeLocalText = (value: Uint8Array): string => {
  if (value.byteLength > maximumLocalOutputBytes) throw new Error("Process output exceeded 1 MiB.");
  return new TextDecoder("utf-8", { fatal: true }).decode(value);
};

const jetBrainsConfigRoots = (
  environment: Readonly<Record<string, string | undefined>>,
  home: string,
): readonly string[] =>
  [
    join(home, "Library", "Application Support", "JetBrains"),
    join(home, "Library", "Application Support", "Google"),
    join(home, ".config", "JetBrains"),
    join(home, ".local", "share", "JetBrains"),
    join(home, ".config", "Google"),
    environment.APPDATA === undefined ? undefined : join(environment.APPDATA, "JetBrains"),
    environment.APPDATA === undefined ? undefined : join(environment.APPDATA, "Google"),
    environment.LOCALAPPDATA === undefined
      ? undefined
      : join(environment.LOCALAPPDATA, "JetBrains"),
  ].filter((entry): entry is string => entry !== undefined);

const withinRoot = (candidate: string, root: string): boolean => {
  const delta = relative(resolve(root), resolve(candidate));
  return delta === "" || (!delta.startsWith("..") && !isAbsolute(delta));
};

const recognizedIDE = (directory: string): string | undefined => {
  const prefix = jetBrainsIDEPrefixes.find((candidate) =>
    directory.toLowerCase().startsWith(candidate.toLowerCase()),
  );
  if (prefix === undefined) return undefined;
  const display =
    prefix === "IntelliJIdea"
      ? "IntelliJ IDEA"
      : prefix === "AndroidStudio"
        ? "Android Studio"
        : prefix;
  return `${display} ${directory.slice(prefix.length).trim()}`.trim();
};

const readJetBrainsQuota = async (
  roots: readonly string[],
  requestedBasePath: string | undefined,
  readQuota: (path: string) => Promise<string | undefined>,
): Promise<{ readonly text: string; readonly label?: string } | undefined> => {
  const candidates: Array<{
    readonly quotaPath: string;
    readonly label: string;
    readonly modified: number;
  }> = [];
  const add = async (basePath: string) => {
    const label = recognizedIDE(basePath.split(/[\\/]/u).at(-1) ?? "");
    if (label === undefined) return;
    const quotaPath = join(basePath, jetBrainsQuotaFile);
    try {
      const baseMetadata = await lstat(basePath);
      const optionsMetadata = await lstat(join(basePath, "options"));
      const metadata = await lstat(quotaPath);
      if (
        baseMetadata.isDirectory() &&
        !baseMetadata.isSymbolicLink() &&
        optionsMetadata.isDirectory() &&
        !optionsMetadata.isSymbolicLink() &&
        metadata.isFile() &&
        !metadata.isSymbolicLink()
      )
        candidates.push({ quotaPath, label, modified: metadata.mtimeMs });
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  };
  if (requestedBasePath !== undefined) {
    if (!roots.some((root) => withinRoot(requestedBasePath, root)))
      throw new Error("JetBrains IDE base path is outside supported configuration roots.");
    const canonicalBase = await realpath(requestedBasePath);
    const canonicalRoots = await Promise.all(
      roots.map(async (root) => {
        try {
          return await realpath(root);
        } catch (error) {
          if (isMissing(error)) return undefined;
          throw error;
        }
      }),
    );
    if (!canonicalRoots.some((root) => root !== undefined && withinRoot(canonicalBase, root)))
      throw new Error("JetBrains IDE base path resolves outside supported configuration roots.");
    await add(requestedBasePath);
  } else {
    for (const root of roots) {
      try {
        const directories = await readdir(root, { encoding: "utf8", withFileTypes: true });
        for (const directory of directories)
          if (directory.isDirectory()) await add(join(root, directory.name));
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
    }
  }
  const selected = candidates.sort((left, right) => right.modified - left.modified)[0];
  if (selected === undefined) return undefined;
  const text = await readQuota(selected.quotaPath);
  return text === undefined ? undefined : { text, label: selected.label };
};

/** Node 24 fetch adapter. Redirects are rejected and response bodies are bounded before providers see them. */
export const makeFetchHttpTransport = (
  fetchImpl: typeof fetch = globalThis.fetch,
): HttpTransportService => ({
  execute: (request: HttpRequest) =>
    Effect.tryPromise({
      try: async (signal) => {
        const timeout = AbortSignal.timeout(request.timeoutMs ?? 15_000);
        const requestBody = request.body === undefined ? undefined : request.body.slice().buffer;
        const response = await fetchImpl(request.url, {
          method: request.method ?? "GET",
          redirect: "error",
          signal: AbortSignal.any([signal, timeout]),
          ...(request.headers === undefined ? {} : { headers: request.headers }),
          ...(requestBody === undefined ? {} : { body: requestBody }),
        });
        const responseBody = await boundedBody(response);
        return {
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          body: responseBody,
          url: response.url,
        } satisfies HttpResponse;
      },
      catch: (error) =>
        new InfrastructureError("HTTP request", "Provider HTTP request failed", error),
    }),
});

const boundedBody = async (response: Response): Promise<Uint8Array> => {
  const maximum = 1024 * 1024;
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maximum)
    throw new Error("Provider response exceeded 1 MiB");
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximum) {
        await reader.cancel("response limit exceeded");
        throw new Error("Provider response exceeded 1 MiB");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
};

export const makeSystemClock = (): ClockService => ({
  now: Effect.sync(() => Date.now()),
  sleep: (milliseconds) =>
    Effect.promise(() => new Promise((resolve) => setTimeout(resolve, milliseconds))),
});

/** Native provider variables remain supported, while the CodexBar namespace wins when explicitly set. */
export const makeEnvironmentProviderSettings = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): FirstPartySettings => ({
  read: (providerId, setting) =>
    Effect.sync(
      () =>
        environment[`CODEXBAR_MULTI_${providerId.toUpperCase().replaceAll("-", "_")}_${setting}`] ??
        environment[setting],
    ),
});

const discoveredSetting = (value: unknown): value is string =>
  typeof value === "string" && value !== "";

/**
 * Per-read Claude/Codex file discovery used by both Node composition roots.
 * Missing discovery values fall through to environment settings unchanged.
 */
export const makeNodeDiscoveredProviderSettings = (
  options: {
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly discoverClaudeCredential?: typeof discoverNodeClaudeCredential;
    readonly discoverCodexCredential?: typeof discoverNodeCodexCredential;
  } = {},
): FirstPartySettings => {
  const environment = options.environment ?? process.env;
  const fallback = makeEnvironmentProviderSettings(environment);
  const discoverClaude = options.discoverClaudeCredential ?? discoverNodeClaudeCredential;
  const discoverCodex = options.discoverCodexCredential ?? discoverNodeCodexCredential;
  return {
    read: (providerId, setting) => {
      if (providerId === "codex") {
        const credential = discoverCodex({ environment });
        if (setting === "CODEX_ACCESS_TOKEN" && discoveredSetting(credential.accessToken))
          return Effect.succeed(credential.accessToken);
        if (setting === "CODEX_ACCOUNT_ID" && discoveredSetting(credential.accountId))
          return Effect.succeed(credential.accountId);
        if (
          setting === "CODEX_PERSONAL_ACCESS_TOKEN" &&
          discoveredSetting(credential.personalAccessToken)
        )
          return Effect.succeed(credential.personalAccessToken);
      }
      if (providerId === "claude" && setting === "CLAUDE_OAUTH_ACCESS_TOKEN") {
        const credential = discoverClaude({ environment });
        if (discoveredSetting(credential.accessToken))
          return Effect.succeed(credential.accessToken);
      }
      return fallback.read(providerId, setting);
    },
  };
};

export {
  accountIdFromJwt,
  discoverNodeCodexCredential,
  parseNodeCodexAuthJson,
  type NodeCodexCredential,
  type ParsedNodeCodexAuth,
} from "./node-codex-credential.ts";
export {
  deriveClaudeOAuthHistoryOwnerIdentifier,
  discoverNodeClaudeCredential,
  resolveNodeClaudeOAuthHistoryOwner,
  type NodeClaudeCredential,
  type NodeClaudeOAuthHistoryOwnerOptions,
} from "./node-claude-credential.ts";

const invalidStoredBrowserCredential = () =>
  new InfrastructureError("browser session", "Stored browser credential is invalid");

const isBrowserSessionRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseSingleAllowlistedCookieHeader = (cookieHeader: string, cookieName: string): string => {
  if (
    [...cookieHeader].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new Error("Stored browser credential is invalid");
  }
  const pairs = cookieHeader.split(";");
  if (pairs.length !== 1) throw new Error("Stored browser credential is invalid");
  const pair = pairs[0]!;
  const separator = pair.indexOf("=");
  if (separator <= 0) throw new Error("Stored browser credential is invalid");
  const name = pair.slice(0, separator).trim();
  const value = pair.slice(separator + 1).trim();
  if (name !== cookieName || value === "") {
    throw new Error("Stored browser credential is invalid");
  }
  return `${cookieName}=${value}`;
};

const parseStoredBrowserSessionCookieHeader = (
  stored: string,
  providerId: ProviderId,
  accountId: string,
  normalizedDomain: string,
): string => {
  const parsed = JSON.parse(stored) as unknown;
  if (
    !isBrowserSessionRecord(parsed) ||
    parsed.version !== 1 ||
    parsed.provider !== providerId ||
    parsed.accountId !== accountId ||
    !isBrowserSessionRecord(parsed.cookieHeaders)
  ) {
    throw new Error("Stored browser credential is invalid");
  }
  const cookieHeader = parsed.cookieHeaders[normalizedDomain];
  if (typeof cookieHeader !== "string" || cookieHeader.trim() === "") {
    throw new Error("Stored browser credential is invalid");
  }
  if (
    [...cookieHeader].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new Error("Stored browser credential is invalid");
  }
  if (providerId === "claude" && normalizedDomain === "claude.ai")
    return parseSingleAllowlistedCookieHeader(cookieHeader, "sessionKey");
  return cookieHeader;
};

interface BrowserSessionStatusDescriptor {
  readonly key: string;
  readonly provider: ProviderId;
  readonly accountId: string;
  readonly domain: string;
}

const defaultBrowserSessionStatusDescriptors = [
  {
    key: "browser-session/claude/default",
    provider: "claude",
    accountId: "default",
    domain: "claude.ai",
  },
  {
    key: "browser-session/t3chat/default",
    provider: "t3chat",
    accountId: "default",
    domain: "t3.chat",
  },
  {
    key: "browser-session/grok/default",
    provider: "grok",
    accountId: "default",
    domain: "grok.com",
  },
] as const satisfies readonly BrowserSessionStatusDescriptor[];

const readDefaultBrowserSessionStatus = async (
  credentials: CredentialStoreService,
  descriptor: BrowserSessionStatusDescriptor,
): Promise<DefaultBrowserSessionStatusStateDTO> => {
  try {
    const stored = await Effect.runPromise(credentials.read(descriptor.key));
    if (stored === undefined) return "absent";
    try {
      parseStoredBrowserSessionCookieHeader(
        stored,
        descriptor.provider,
        descriptor.accountId,
        descriptor.domain,
      );
      return "persisted";
    } catch {
      return "unavailable";
    }
  } catch {
    return "unavailable";
  }
};

/** Metadata-only status for one exact account-scoped browser credential. */
export const readBrowserSessionStatus = async (
  credentials: CredentialStoreService,
  providerId: ProviderId,
  accountId: string,
  domain: string,
): Promise<DefaultBrowserSessionStatusStateDTO> => {
  const normalizedDomain = domain.trim().toLowerCase();
  if (normalizedDomain === "" || normalizedDomain.includes("/")) return "unavailable";
  for (const key of browserSessionCredentialKeys(providerId, accountId)) {
    let stored: string | undefined;
    try {
      stored = await Effect.runPromise(credentials.read(key));
    } catch {
      return "unavailable";
    }
    if (stored === undefined) continue;
    try {
      parseStoredBrowserSessionCookieHeader(stored, providerId, accountId, normalizedDomain);
      return "persisted";
    } catch {
      return "unavailable";
    }
  }
  return "absent";
};

/** Host-only status projection for the three renderer-supported default browser sessions. */
export const readDefaultBrowserSessionStatuses = async (
  credentials: CredentialStoreService,
): Promise<DefaultBrowserSessionStatusesDTO> => ({
  schemaVersion: 1,
  claudeDefault: await readDefaultBrowserSessionStatus(
    credentials,
    defaultBrowserSessionStatusDescriptors[0],
  ),
  t3chatDefault: await readDefaultBrowserSessionStatus(
    credentials,
    defaultBrowserSessionStatusDescriptors[1],
  ),
  grokDefault: await readDefaultBrowserSessionStatus(
    credentials,
    defaultBrowserSessionStatusDescriptors[2],
  ),
});

/** Only an allowlisted, encrypted cookie header is released to a declared provider domain. */
export const makeCredentialBrowserSessions = (
  credentials: CredentialStoreService,
  accountIdFor: (providerId: ProviderId) => string = () => "default",
): FirstPartyBrowserSessions => ({
  cookieHeader: (providerId, domain, selectedAccountId) => {
    if (selectedAccountId !== undefined && !usesAccountScopedBrowserSession(providerId)) {
      return Effect.fail(
        new InfrastructureError("browser session", "Selected browser session is unsupported"),
      );
    }
    const accountId = selectedAccountId ?? accountIdFor(providerId);
    const normalizedDomain = domain.trim().toLowerCase();
    return Effect.gen(function* () {
      for (const key of browserSessionCredentialKeys(providerId, accountId)) {
        const stored = yield* credentials.read(key);
        if (stored !== undefined) return stored;
      }
      return undefined;
    }).pipe(
      Effect.flatMap(
        (stored): Effect.Effect<string, InfrastructureError | MissingBrowserCredentialError> => {
          if (stored === undefined) {
            return Effect.fail(new MissingBrowserCredentialError());
          }
          return Effect.try({
            try: () =>
              parseStoredBrowserSessionCookieHeader(
                stored,
                providerId,
                accountId,
                normalizedDomain,
              ),
            catch: () => invalidStoredBrowserCredential(),
          });
        },
      ),
    );
  },
});
