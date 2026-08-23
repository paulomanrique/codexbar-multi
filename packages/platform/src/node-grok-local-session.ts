import { lstat, open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export const GROK_LOCAL_SESSION_DEFAULT_LOOKBACK_DAYS = 30;
export const GROK_LOCAL_SESSION_MAX_ENTRIES = 10_000;
export const GROK_LOCAL_SESSION_MAX_FILES = 2_000;
export const GROK_LOCAL_SESSION_MAX_FILE_BYTES = 256 * 1024;

export class NodeGrokLocalSessionScanCancelledError extends Error {
  constructor() {
    super("Grok local session scan was cancelled");
    this.name = "AbortError";
  }
}

export type NodeGrokLocalSessionSignalFile = {
  readonly modifiedAtMs: number;
  /** Parsed only after a size-bounded read; provider code owns field allow-listing. */
  readonly json: unknown;
};

export type NodeGrokLocalSessionScanResult = {
  readonly signals: readonly NodeGrokLocalSessionSignalFile[];
  readonly truncated: boolean;
};

export interface NodeGrokLocalSessionScanOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory?: string;
  readonly platform?: NodeJS.Platform;
  /** Test-only explicit sessions root. It is never returned from the scanner. */
  readonly root?: string;
  readonly lookbackDays?: number;
  readonly now?: Date;
  readonly maxEntries?: number;
  readonly maxFiles?: number;
  readonly maxFileBytes?: number;
  readonly signal?: AbortSignal;
  /** Test-only hook between the initial `lstat` and secure handle open. */
  readonly beforeRead?: (path: string) => void | Promise<void>;
}

const positiveInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer`);
  return value;
};

const boundedPositiveInteger = (value: number, maximum: number, name: string): number => {
  const result = positiveInteger(value, name);
  if (result > maximum) throw new Error(`${name} must not exceed ${maximum}`);
  return result;
};

const nonnegativeInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${name} must be a non-negative integer`);
  return value;
};

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted === true) throw new NodeGrokLocalSessionScanCancelledError();
};

const missing = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

const realDirectory = async (path: string): Promise<boolean> => {
  const info = await lstat(path).catch((error: unknown) => {
    if (missing(error)) return undefined;
    throw error;
  });
  return info !== undefined && info.isDirectory() && !info.isSymbolicLink();
};

const sameRegularFile = (
  left: { readonly dev: bigint; readonly ino: bigint; isFile: () => boolean },
  right: { readonly dev: bigint; readonly ino: bigint; isFile: () => boolean },
): boolean => left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino;

/** Local-calendar day subtraction, matching `Calendar.current.date(byAdding: .day, ...)`. */
export const grokLocalSessionLookbackCutoff = (now: Date, lookbackDays: number): Date => {
  const cutoff = new Date(now.getTime());
  cutoff.setDate(cutoff.getDate() - lookbackDays);
  return cutoff;
};

const visibleDirectories = async (
  path: string,
  signal: AbortSignal | undefined,
): Promise<string[]> => {
  throwIfAborted(signal);
  const entries = await readdir(path, { withFileTypes: true });
  return entries
    .filter(
      (entry) => !entry.name.startsWith(".") && entry.isDirectory() && !entry.isSymbolicLink(),
    )
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
};

/** Resolves the private sessions root without returning it through a public result. */
export const resolveNodeGrokLocalSessionRoot = (
  environment: Readonly<Record<string, string | undefined>>,
  homeDirectory: string,
  platform: NodeJS.Platform,
): string => {
  const paths = platform === "win32" ? win32 : posix;
  const configured = environment.GROK_HOME?.trim();
  const grokHome =
    configured === undefined || configured === ""
      ? paths.join(homeDirectory, ".grok")
      : configured === "~"
        ? homeDirectory
        : configured.startsWith("~/") || configured.startsWith("~\\")
          ? paths.join(homeDirectory, configured.slice(2))
          : paths.resolve(configured);
  return paths.join(grokHome, "sessions");
};

/**
 * Bounded, cancellation-aware walk of `sessions/<cwd>/<session>/signals.json`.
 * Symlinks and hidden directories are skipped, matching the scanner's local,
 * best-effort role without following an attacker-controlled path out of root.
 */
export const scanNodeGrokLocalSessions = async (
  options: NodeGrokLocalSessionScanOptions = {},
): Promise<NodeGrokLocalSessionScanResult> => {
  const environment = options.environment ?? process.env;
  const home = options.homeDirectory ?? homedir();
  const platform = options.platform ?? process.platform;
  const root = options.root ?? resolveNodeGrokLocalSessionRoot(environment, home, platform);
  const paths = platform === "win32" ? win32 : posix;
  const lookbackDays = nonnegativeInteger(
    options.lookbackDays ?? GROK_LOCAL_SESSION_DEFAULT_LOOKBACK_DAYS,
    "lookbackDays",
  );
  const maxEntries = boundedPositiveInteger(
    options.maxEntries ?? GROK_LOCAL_SESSION_MAX_ENTRIES,
    GROK_LOCAL_SESSION_MAX_ENTRIES,
    "maxEntries",
  );
  const maxFiles = boundedPositiveInteger(
    options.maxFiles ?? GROK_LOCAL_SESSION_MAX_FILES,
    GROK_LOCAL_SESSION_MAX_FILES,
    "maxFiles",
  );
  const maxFileBytes = boundedPositiveInteger(
    options.maxFileBytes ?? GROK_LOCAL_SESSION_MAX_FILE_BYTES,
    GROK_LOCAL_SESSION_MAX_FILE_BYTES,
    "maxFileBytes",
  );
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("now must be a valid date");
  const cutoffMs = grokLocalSessionLookbackCutoff(now, lookbackDays).getTime();
  throwIfAborted(options.signal);
  if (!(await realDirectory(root))) return { signals: [], truncated: false };

  const signals: NodeGrokLocalSessionSignalFile[] = [];
  let visitedEntries = 0;
  let truncated = false;
  for (const cwd of await visibleDirectories(root, options.signal)) {
    throwIfAborted(options.signal);
    if (visitedEntries >= maxEntries) return { signals, truncated: true };
    visitedEntries += 1;
    const cwdPath = paths.join(root, cwd);
    if (!(await realDirectory(cwdPath))) continue;
    for (const session of await visibleDirectories(cwdPath, options.signal)) {
      throwIfAborted(options.signal);
      if (visitedEntries >= maxEntries || signals.length >= maxFiles)
        return { signals, truncated: true };
      visitedEntries += 1;
      const sessionPath = paths.join(cwdPath, session);
      // Dirent data can become stale between enumeration and use. Re-check the
      // directory so a symlink swap cannot redirect the signals read.
      if (!(await realDirectory(sessionPath))) continue;
      const path = paths.join(sessionPath, "signals.json");
      const info = await lstat(path, { bigint: true }).catch((error: unknown) => {
        if (missing(error)) return undefined;
        throw error;
      });
      if (info === undefined || !info.isFile() || info.isSymbolicLink()) continue;
      if (Number(info.mtimeMs) < cutoffMs) continue;
      if (info.size > BigInt(maxFileBytes)) {
        truncated = true;
        continue;
      }
      throwIfAborted(options.signal);
      await options.beforeRead?.(path);
      const handle = await open(path, "r");
      try {
        const opened = await handle.stat({ bigint: true });
        // Do not read a file reached through a post-lstat replacement or symlink.
        if (!sameRegularFile(info, opened)) continue;
        const contents = Buffer.alloc(maxFileBytes + 1);
        const { bytesRead } = await handle.read(contents, 0, contents.byteLength, 0);
        if (bytesRead > maxFileBytes) {
          truncated = true;
          continue;
        }
        throwIfAborted(options.signal);
        const after = await lstat(path, { bigint: true }).catch((error: unknown) => {
          if (missing(error)) return undefined;
          throw error;
        });
        if (after === undefined || !sameRegularFile(info, after)) continue;
        try {
          signals.push({
            modifiedAtMs: Number(info.mtimeMs),
            json: JSON.parse(contents.subarray(0, bytesRead).toString("utf8")) as unknown,
          });
        } catch {
          // A partial or malformed session file is ignored like Swift's `try?`.
        }
      } finally {
        await handle.close();
      }
    }
  }
  return { signals, truncated };
};
