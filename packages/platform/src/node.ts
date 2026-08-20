import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
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
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
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
  type ProcessResult,
  type ProcessRunnerService,
  type ProcessSpec,
  type PrivateFileStoreService,
} from "@codexbar/core";
import type { ProviderId } from "@codexbar/contracts";
import type {
  FirstPartyBrowserSessions,
  FirstPartyLocalCapabilities,
  FirstPartySettings,
} from "./first-party-runtime.ts";
import type { ProviderLocalCommand } from "@codexbar/providers";
import {
  makeNodePrivateDirectoryRestriction,
  makeNodePrivateFileRestriction,
  type NodePrivatePathRestrictionOptions,
} from "./node-private-path-security.ts";

export * from "./node-persistence.ts";
export * from "./node-persistence-worker-client.ts";
export * from "./first-party-runtime.ts";
export * from "./legacy-import.ts";
export * from "./node-cost-jsonl.ts";
export * from "./node-private-path-security.ts";

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
export const makeNodeProcessRunner = (
  options: {
    readonly maximumOutputBytes?: number;
    readonly environment?: Readonly<Record<string, string | undefined>>;
  } = {},
): ProcessRunnerService => {
  const maximumOutputBytes = options.maximumOutputBytes ?? maximumLocalOutputBytes;
  const environment = options.environment ?? process.env;
  return {
    run: (spec) =>
      Effect.tryPromise({
        try: (signal) => runNodeProcess(spec, signal, maximumOutputBytes, environment),
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
): Promise<ProcessResult> =>
  new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      callback();
    };
    const abort = () => {
      child.kill("SIGKILL");
      finish(() => rejectPromise(new Error("Process execution was cancelled.")));
    };
    if (signal.aborted) {
      rejectPromise(new Error("Process execution was cancelled."));
      return;
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(spec.command, [...(spec.args ?? [])], {
        cwd: spec.cwd,
        env: Object.fromEntries(
          Object.entries({ ...baseEnvironment, ...spec.env }).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
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
        child.kill("SIGKILL");
        finish(() => rejectPromise(new Error("Process output exceeded 1 MiB.")));
        return;
      }
      target.push(value);
    };
    child.stdout?.on("data", (value: Buffer) => append(stdout, value));
    child.stderr?.on("data", (value: Buffer) => append(stderr, value));
    child.once("error", (error) => finish(() => rejectPromise(error)));
    child.once("close", (exitCode, exitSignal) =>
      finish(() =>
        resolvePromise({
          exitCode: exitCode ?? undefined,
          signal: exitSignal ?? undefined,
          stdout: new Uint8Array(Buffer.concat(stdout)),
          stderr: new Uint8Array(Buffer.concat(stderr)),
        }),
      ),
    );
    signal.addEventListener("abort", abort, { once: true });
    if (spec.stdin !== undefined) child.stdin?.end(spec.stdin);
    else child.stdin?.end();
    const timeoutMs = spec.timeoutMs;
    if (timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        child.kill("SIGKILL");
        finish(() => rejectPromise(new Error(`Process timed out after ${timeoutMs}ms.`)));
      }, timeoutMs);
    }
  });

const executableByCommand: Readonly<Record<ProviderLocalCommand, { readonly env: string }>> = {
  amp: { env: "AMP_CLI_PATH" },
  "kiro-cli": { env: "KIRO_CLI_PATH" },
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
  };
};

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

export {
  accountIdFromJwt,
  discoverNodeCodexCredential,
  type NodeCodexCredential,
} from "./node-codex-credential.ts";

/** Only an allowlisted, encrypted cookie header is released to a declared provider domain. */
export const makeCredentialBrowserSessions = (
  credentials: CredentialStoreService,
  accountIdFor: (providerId: ProviderId) => string = () => "default",
): FirstPartyBrowserSessions => ({
  cookieHeader: (providerId, domain) =>
    credentials.read(`browser-session/${providerId}/${accountIdFor(providerId)}`).pipe(
      Effect.flatMap((stored) => {
        if (stored === undefined) {
          return Effect.fail(
            new InfrastructureError(
              "browser session",
              "No exported desktop browser credential is available",
            ),
          );
        }
        return Effect.try({
          try: () => {
            const parsed = JSON.parse(stored) as { readonly cookieHeaders?: unknown };
            if (
              typeof parsed.cookieHeaders !== "object" ||
              parsed.cookieHeaders === null ||
              Array.isArray(parsed.cookieHeaders)
            ) {
              throw new Error("Stored browser credential is invalid");
            }
            const normalizedDomain = domain.trim().toLowerCase();
            const cookieHeader = (parsed.cookieHeaders as Record<string, unknown>)[
              normalizedDomain
            ];
            if (typeof cookieHeader !== "string" || cookieHeader.trim() === "") {
              throw new Error("Stored browser credential has no cookies for the requested domain");
            }
            return cookieHeader;
          },
          catch: (error) =>
            new InfrastructureError(
              "browser session",
              "Stored browser credential is invalid",
              error,
            ),
        });
      }),
    ),
});
