import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Effect } from "effect";
import {
  InfrastructureError,
  type ProcessRunnerService,
  type PtyRunnerService,
  type PtySession,
} from "@codexbar/core";
import type { ProviderClaudeCliUsageResult } from "@codexbar/providers";
import type { FirstPartyLocalCapabilities } from "./first-party-runtime.ts";
import { makeNodePrivateDirectoryRestriction } from "./node-private-path-security.ts";

export {
  filterProvidersForClaudeBackgroundPolicy,
  hasClaudeCliUserInitiatedSuccess,
  recordClaudeCliUserInitiatedSuccess,
  resetClaudeCliPolicyForTesting,
  shouldIncludeClaudeInRefresh,
} from "./node-claude-cli-policy.ts";

const MAX_OUTPUT_BYTES = 1024 * 1024;
const AUTH_TIMEOUT_MS = 5_000;
const PTY_TIMEOUT_MS = 20_000;
const PTY_COLUMNS = 160;
const PTY_ROWS = 50;
const MAX_PROJECT_DIRECTORY_NAME_LENGTH = 200;

const claudeProbeEnvironmentKeys = [
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
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
] as const;

const secretEnvironmentKey = /(?:TOKEN|SECRET|PASSWORD|AUTHORIZATION|API[_-]?KEY)/iu;

export interface NodeClaudeCliFileApi {
  readonly readdir: (path: string) => Promise<readonly string[]>;
  readonly lstat: (
    path: string,
  ) => Promise<{ readonly isFile: boolean; readonly isSymbolicLink: boolean }>;
  readonly rm: (path: string) => Promise<void>;
}

export interface NodeClaudeCliUsageOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory?: string;
  readonly probeDirectory?: string;
  readonly userDataPath?: string;
  readonly platform?: NodeJS.Platform;
  readonly processRunner: ProcessRunnerService;
  readonly ptyRunner: PtyRunnerService;
  readonly now?: () => number;
  readonly fileApi?: NodeClaudeCliFileApi;
  readonly restrictDirectory?: (path: string) => Promise<void>;
  /** Test seam; production is the Swift 20s global timeout. */
  readonly ptyTimeoutMs?: number;
}

const abortError = (): Error => {
  const error = new Error("Process execution was cancelled.");
  error.name = "AbortError";
  return error;
};

const isAbort = (error: unknown): boolean =>
  error instanceof Error && (error.name === "AbortError" || error.name === "CanceledError");

const isSafeExecutable = (value: string): boolean =>
  !value.includes("\u0000") && (isAbsolute(value) || /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(value));

const resolveClaudeBinary = (environment: Readonly<Record<string, string | undefined>>): string => {
  const configured = environment.CLAUDE_CLI_PATH?.trim();
  if (configured !== undefined && configured !== "" && isSafeExecutable(configured))
    return configured;
  return "claude";
};

export const claudeProbeEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> => {
  const allowKeys = new Set<string>(claudeProbeEnvironmentKeys);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined || value.includes("\u0000") || key.includes("\u0000")) continue;
    if (key.startsWith("ANTHROPIC_")) continue;
    if (key === "CLAUDE_OAUTH_ACCESS_TOKEN") continue;
    if (key.startsWith("CODEXBAR_MULTI_CLAUDE")) continue;
    if (secretEnvironmentKey.test(key)) continue;
    if (!allowKeys.has(key)) continue;
    result[key] = value;
  }
  result.DISABLE_AUTOUPDATER = "1";
  result.TERM = "xterm-256color";
  return result;
};

const parseAuthStatus = (stdout: string): boolean | undefined => {
  try {
    const data = JSON.parse(stdout) as { loggedIn?: unknown };
    return typeof data.loggedIn === "boolean" ? data.loggedIn : undefined;
  } catch {
    return undefined;
  }
};

const stripAnsi = (text: string): string => {
  const escape = String.fromCharCode(27);
  const bell = String.fromCharCode(7);
  const withoutAnsi = text
    .replace(new RegExp(`${escape}\\[[0-9;?]*[a-zA-Z]`, "gu"), "")
    .replace(new RegExp(`${escape}\\][^${bell}]*${bell}`, "gu"), "");
  return [...withoutAnsi]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code === 9 || code === 10 || code === 13 || code >= 32;
    })
    .join("");
};

const normalizedNeedle = (text: string): string => text.toLowerCase().replace(/\s+/gu, "");

const promptSends: Readonly<Record<string, string>> = {
  "Do you trust the files in this folder?": "y\r",
  "Quick safety check:": "\r",
  "Yes, I trust this folder": "\r",
  "Ready to code here?": "\r",
  "Press Enter to continue": "\r",
  "Show plan usage limits": "\r",
  "Show plan": "\r",
};

const delay = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });

export const resolveClaudeProbeDirectory = (options: {
  readonly probeDirectory?: string;
  readonly userDataPath?: string;
}): string => {
  const explicit = options.probeDirectory?.trim();
  if (explicit !== undefined && explicit !== "") return explicit;
  const userData = options.userDataPath?.trim();
  if (userData !== undefined && userData !== "") return join(userData, "ClaudeProbe");
  throw new Error("Claude CLI probe directory must be an explicit private app-data path.");
};

export const ensureClaudeProbeDirectory = async (
  probeDirectory: string,
  restrictDirectory: (path: string) => Promise<void> = makeNodePrivateDirectoryRestriction(),
): Promise<string> => {
  await mkdir(probeDirectory, { recursive: true, mode: 0o700 });
  await restrictDirectory(probeDirectory);
  const claudeDir = join(probeDirectory, ".claude");
  await mkdir(claudeDir, { recursive: true, mode: 0o700 });
  await restrictDirectory(claudeDir);
  const settingsPath = join(claudeDir, "settings.local.json");
  let settings: Record<string, unknown> = {};
  try {
    const raw = await readFile(settingsPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
      settings = parsed as Record<string, unknown>;
  } catch {
    settings = {};
  }
  settings.disableDeepLinkRegistration = "disable";
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  return probeDirectory;
};

/** Matches Swift `ClaudeProbeSessionArtifactCleaner.claudeProjectDirectoryName`. */
export const claudeProjectDirectoryName = (probeDirectory: string): string => {
  const path = probeDirectory.normalize("NFC");
  let sanitized = "";
  for (let index = 0; index < path.length; index += 1) {
    const code = path.charCodeAt(index);
    sanitized +=
      (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
        ? path[index]!
        : "-";
  }
  if (sanitized.length <= MAX_PROJECT_DIRECTORY_NAME_LENGTH) return sanitized;
  let hash = 0;
  for (let index = 0; index < path.length; index += 1)
    hash = (Math.imul(hash, 31) + path.charCodeAt(index)) | 0;
  const magnitude = hash < 0 ? -hash : hash;
  return `${sanitized.slice(0, MAX_PROJECT_DIRECTORY_NAME_LENGTH)}-${magnitude.toString(36)}`;
};

const claudeConfigRoot = (
  environment: Readonly<Record<string, string | undefined>>,
  probeDirectory: string,
  homeDirectory: string | undefined,
): string => {
  const home =
    environment.HOME?.trim() || environment.USERPROFILE?.trim() || homeDirectory?.trim() || "";
  const defaultRoot = home === "" ? join(probeDirectory, ".claude") : join(home, ".claude");
  const resolveRoot = (raw: string): string => (isAbsolute(raw) ? raw : join(probeDirectory, raw));
  const secure = environment.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  if (secure !== undefined) return secure === "" ? defaultRoot : resolveRoot(secure);
  const configured = environment.CLAUDE_CONFIG_DIR;
  if (configured !== undefined && configured !== "") return resolveRoot(configured);
  return defaultRoot;
};

const defaultFileApi = (): NodeClaudeCliFileApi => ({
  readdir: async (path) => await readdir(path),
  lstat: async (path) => {
    const info = await lstat(path);
    return { isFile: info.isFile(), isSymbolicLink: info.isSymbolicLink() };
  },
  rm: async (path) => {
    await unlink(path);
  },
});

/**
 * Delete only probe-owned regular `*.jsonl` files after lstat (no follow).
 * Never recursively remove the project directory: if emptiness cannot be
 * proven safely, leave it.
 */
export const cleanupClaudeProbeArtifacts = async (
  probeDirectory: string,
  environment: Readonly<Record<string, string | undefined>>,
  fileApi: NodeClaudeCliFileApi = defaultFileApi(),
  homeDirectory?: string,
): Promise<readonly string[]> => {
  const projectDir = join(
    claudeConfigRoot(environment, probeDirectory, homeDirectory),
    "projects",
    claudeProjectDirectoryName(probeDirectory),
  );
  let entries: readonly string[] = [];
  try {
    entries = await fileApi.readdir(projectDir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (
      entry.startsWith(".") ||
      entry.includes("/") ||
      entry.includes("\\") ||
      entry.includes("\u0000")
    )
      continue;
    if (!entry.endsWith(".jsonl")) continue;
    const full = join(projectDir, entry);
    try {
      const info = await fileApi.lstat(full);
      if (info.isSymbolicLink || !info.isFile) continue;
      await fileApi.rm(full);
      removed.push(full);
    } catch {
      // Leave the exact artifact when a safe unlink cannot be proven.
    }
  }
  return removed;
};

const ptyExit = (session: PtySession): { readonly exitCode?: number; readonly signal?: string } => {
  const candidate = session as PtySession & {
    readonly exitCode?: () => number | undefined;
    readonly exitSignal?: () => string | undefined;
  };
  const exitCode = typeof candidate.exitCode === "function" ? candidate.exitCode() : undefined;
  const signal = typeof candidate.exitSignal === "function" ? candidate.exitSignal() : undefined;
  return {
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(signal === undefined ? {} : { signal }),
  };
};

const loggedOutResult = (
  exitCode: number | undefined,
  signal: string | undefined,
): ProviderClaudeCliUsageResult => ({
  stdout: "",
  stderr: "",
  ...(exitCode === undefined ? {} : { exitCode }),
  ...(signal === undefined ? {} : { signal }),
  loggedIn: false,
});

export const fetchNodeClaudeCliUsage = async (
  options: NodeClaudeCliUsageOptions,
  signal: AbortSignal,
): Promise<ProviderClaudeCliUsageResult> => {
  if (signal.aborted) throw abortError();
  const environment = options.environment ?? process.env;
  const binary = resolveClaudeBinary(environment);
  const probeDir = resolveClaudeProbeDirectory(options);
  const restrictDirectory = options.restrictDirectory ?? makeNodePrivateDirectoryRestriction();
  await ensureClaudeProbeDirectory(probeDir, restrictDirectory);
  const probeEnv = claudeProbeEnvironment(environment);

  let authResult: {
    readonly stdout: Uint8Array;
    readonly stderr: Uint8Array;
    readonly exitCode: number | undefined;
    readonly signal: string | undefined;
  };
  try {
    authResult = await Effect.runPromise(
      options.processRunner.run({
        command: binary,
        args: ["auth", "status", "--json"],
        cwd: probeDir,
        env: probeEnv,
        timeoutMs: AUTH_TIMEOUT_MS,
      }),
      { signal },
    );
  } catch (error) {
    if (isAbort(error)) throw abortError();
    throw error;
  }

  if (authResult.stdout.byteLength > MAX_OUTPUT_BYTES || authResult.stdout.includes(0))
    throw new Error("Claude CLI auth status output is invalid");
  const stdoutText = new TextDecoder("utf-8", { fatal: true }).decode(authResult.stdout);
  if (authResult.exitCode !== 0 || parseAuthStatus(stdoutText) !== true)
    return loggedOutResult(authResult.exitCode, authResult.signal);

  const sessionId = randomUUID().toLowerCase();
  const probeSessionDirectory =
    options.probeDirectory === undefined ? join(probeDir, sessionId) : probeDir;
  if (probeSessionDirectory !== probeDir)
    await ensureClaudeProbeDirectory(probeSessionDirectory, restrictDirectory);
  let session: PtySession | undefined;
  let ptyOutput = "";
  let ptyExitCode: number | undefined;
  let ptySignal: string | undefined;
  let operationFailure: unknown;
  let closeFailure: unknown;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const onAbortTimeout = (): void => {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  };
  try {
    session = await Effect.runPromise(
      options.ptyRunner.start({
        command: binary,
        args: ["--allowed-tools", "", "--strict-mcp-config", "--session-id", sessionId],
        cwd: probeSessionDirectory,
        env: probeEnv,
        columns: PTY_COLUMNS,
        rows: PTY_ROWS,
      }),
      { signal },
    );
    await Effect.runPromise(session.write(new TextEncoder().encode("/usage\r")), { signal });

    const probeLoop = async (): Promise<void> => {
      const now = options.now ?? Date.now;
      let lastEnter = now();
      const triggered = new Set<string>();
      while (!signal.aborted) {
        const data = await Effect.runPromise(session!.read, { signal });
        if (data.byteLength > MAX_OUTPUT_BYTES) throw new Error("Process output exceeded 1 MiB.");
        if (data.includes(0)) throw new Error("PTY output contains NUL");
        ptyOutput = new TextDecoder("utf-8", { fatal: true }).decode(data);
        if (ptyOutput.length > MAX_OUTPUT_BYTES) throw new Error("Process output exceeded 1 MiB.");
        const normalized = normalizedNeedle(stripAnsi(ptyOutput));
        for (const [needle, send] of Object.entries(promptSends)) {
          const key = normalizedNeedle(needle);
          if (!triggered.has(key) && normalized.includes(key)) {
            triggered.add(key);
            await Effect.runPromise(session!.write(new TextEncoder().encode(send)), {
              signal,
            }).catch(() => undefined);
          }
        }
        const hasSessionLabel = normalized.includes("currentsession");
        const hasSubscriptionNotice =
          normalized.includes("currentlyusingyoursubscription") &&
          normalized.includes("claudecodeusage");
        const hasFailedLoad = normalized.includes("failedtoloadusagedata");
        const hasPercent = /[0-9]{1,3}(?:\.[0-9]+)?%/u.test(ptyOutput);
        if ((hasSessionLabel && hasPercent) || hasSubscriptionNotice || hasFailedLoad) {
          await delay(250, signal).catch(() => undefined);
          const finalData = await Effect.runPromise(session!.read, { signal }).catch(
            () => new Uint8Array(),
          );
          const finalChunk = new TextDecoder("utf-8", { fatal: true }).decode(finalData);
          if (finalChunk.length > ptyOutput.length) ptyOutput = finalChunk;
          return;
        }
        if (now() - lastEnter >= 800) {
          await Effect.runPromise(session!.write(new TextEncoder().encode("\r")), { signal }).catch(
            () => undefined,
          );
          lastEnter = now();
        }
        await delay(60, signal);
      }
      throw abortError();
    };

    const timeoutError = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        signal.removeEventListener("abort", onAbortTimeout);
        reject(new Error("Claude CLI usage probe timed out."));
      }, options.ptyTimeoutMs ?? PTY_TIMEOUT_MS);
      signal.addEventListener("abort", onAbortTimeout, { once: true });
    });
    await Promise.race([probeLoop(), timeoutError]);
  } catch (error) {
    operationFailure = error;
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    signal.removeEventListener("abort", onAbortTimeout);
    if (session !== undefined) {
      try {
        await Effect.runPromise(session.close);
      } catch (error) {
        closeFailure = error;
      }
      const exit = ptyExit(session);
      ptyExitCode = exit.exitCode;
      ptySignal = exit.signal;
    }
    await cleanupClaudeProbeArtifacts(
      probeSessionDirectory,
      environment,
      options.fileApi ?? defaultFileApi(),
      options.homeDirectory,
    ).catch(() => undefined);
  }

  if (closeFailure !== undefined) throw closeFailure;
  if (operationFailure !== undefined) throw operationFailure;
  if (signal.aborted) throw abortError();
  if (ptyOutput.length === 0) throw new Error("Claude CLI usage probe timed out.");
  if (ptyOutput.length > MAX_OUTPUT_BYTES) throw new Error("Process output exceeded 1 MiB.");
  return {
    stdout: ptyOutput,
    stderr: "",
    ...(ptyExitCode === undefined ? {} : { exitCode: ptyExitCode }),
    ...(ptySignal === undefined ? {} : { signal: ptySignal }),
    loggedIn: true,
  };
};

/** Desktop-owned named capability. CLI must not import or call this. */
export const makeNodeClaudeCliLocalCapability =
  (
    options: NodeClaudeCliUsageOptions,
  ): NonNullable<FirstPartyLocalCapabilities["fetchClaudeCliUsage"]> =>
  (providerId) =>
    Effect.tryPromise({
      try: (signal) => {
        if (providerId !== "claude") throw new Error("Provider Claude CLI is not allowlisted.");
        return fetchNodeClaudeCliUsage(options, signal);
      },
      catch: (error) =>
        isAbort(error)
          ? error
          : new InfrastructureError(
              "read Claude CLI usage",
              "Claude CLI usage probe failed.",
              error,
            ),
    });
