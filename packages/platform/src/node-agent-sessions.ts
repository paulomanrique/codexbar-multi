import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, win32 } from "node:path";

/** Safe, display-only session shape consumed by the CLI. Commands and raw file content never escape. */
export interface NodeAgentSession {
  readonly id: string;
  readonly state: "active" | "idle";
  readonly provider: "codex" | "claude" | "pi";
  readonly dialect?: "pi" | "omp";
  readonly source: "cli" | "desktopApp";
  readonly pid?: number;
  readonly cwd?: string;
  readonly projectName?: string;
  readonly sessionName?: string;
  readonly startedAt?: string;
  readonly lastActivityAt?: string;
  readonly transcriptPath?: string;
  /** Local scans deliberately never expose the machine hostname. */
  readonly host: "local";
  readonly [key: string]: unknown;
}

export interface NodeAgentProcess {
  readonly pid: number;
  readonly ppid: number;
  readonly command: string;
  readonly startedAt?: number;
}

export interface NodeAgentSessionDirectoryEntry {
  readonly path: string;
  readonly type: "file" | "directory";
  readonly modifiedAt?: number;
}

/** Narrow, injectable filesystem surface; scanner code has no ambient filesystem access. */
export interface NodeAgentSessionFiles {
  readonly canonical: (path: string, signal: AbortSignal) => Promise<string | undefined>;
  readonly list: (
    path: string,
    signal: AbortSignal,
  ) => Promise<readonly NodeAgentSessionDirectoryEntry[]>;
  readonly readPrefix: (
    path: string,
    maximumBytes: number,
    signal: AbortSignal,
  ) => Promise<string | undefined>;
  readonly readTail: (
    path: string,
    maximumBytes: number,
    signal: AbortSignal,
  ) => Promise<string | undefined>;
}

export interface NodeAgentSessionScannerOptions {
  readonly processes: (signal: AbortSignal) => Promise<readonly NodeAgentProcess[]>;
  readonly cwdByPID: (
    pids: readonly number[],
    signal: AbortSignal,
  ) => Promise<ReadonlyMap<number, string>>;
  readonly files: NodeAgentSessionFiles;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => number;
  readonly maximumProcesses?: number;
  readonly maximumDirectoryEntries?: number;
}

export interface NodeAgentSessionToolPaths {
  readonly ps: string;
  readonly powershell: string;
  readonly osascript: string;
}

type Dialect = "pi" | "omp";
type Candidate = {
  readonly process: NodeAgentProcess;
  readonly provider: NodeAgentSession["provider"];
  readonly dialect?: Dialect;
};
type PiRecord = {
  readonly id: string;
  readonly cwd?: string;
  readonly sessionName?: string;
  readonly startedAt?: string;
  readonly modifiedAt: number;
  readonly path: string;
};
type Root = { readonly path: string; readonly layout: "direct" | "projects" };

const activeWindowMs = 120_000;
const prefixBytes = 16 * 1024;
const tailBytes = 64 * 1024;

const aborted = (signal: AbortSignal): void => {
  if (signal.aborted)
    throw signal.reason instanceof Error ? signal.reason : new Error("Session scan cancelled");
};

const tokens = (command: string): readonly string[] =>
  Array.from(
    command.matchAll(/"([^"]*)"|'([^']*)'|[^\s]+/gu),
    (match) => match[1] ?? match[2] ?? match[0],
  );
const executableName = (value: string): string =>
  basename(value.replaceAll("\\", "/"))
    .toLowerCase()
    .replace(/\.exe$/u, "");
const commandBasename = (command: string): string => executableName(tokens(command)[0] ?? "");
const projectName = (cwd: string | undefined): string | undefined => {
  if (!cwd) return undefined;
  const name = basename(cwd);
  return name || undefined;
};
const asDate = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
};
const clampModifiedAt = (modifiedAt: number | undefined, now: number): number =>
  Math.min(modifiedAt ?? now, now);
const sessionState = (activity: number | undefined, now: number): "active" | "idle" =>
  activity === undefined || now - activity <= activeWindowMs ? "active" : "idle";

const piDialect = (command: string): Dialect | undefined => {
  const values = tokens(command);
  const first = executableName(values[0] ?? "");
  if (first === "pi") return "pi";
  if (first === "omp") return "omp";
  return first === "bun" && values.slice(1).some((value) => executableName(value) === "omp")
    ? "omp"
    : undefined;
};

const helper = (command: string): boolean =>
  /--help|--version|--smoke-test|__omp_worker_/iu.test(command);

/** Pure process classification matching AgentPSOutputParser's intentionally conservative filtering. */
export const classifyAgentProcesses = (
  processes: readonly NodeAgentProcess[],
): readonly Candidate[] => {
  const candidates = processes.flatMap((process): readonly Candidate[] => {
    const dialect = piDialect(process.command);
    if (dialect !== undefined)
      return helper(process.command) ? [] : [{ process, provider: "pi", dialect }];
    const executable = commandBasename(process.command);
    const lower = process.command.toLowerCase();
    if (
      executable === "codex" &&
      !/\bapp-server\b|--help|--version/iu.test(process.command) &&
      (!lower.includes(".app/") ||
        lower.startsWith("/applications/codex.app/contents/resources/codex "))
    )
      return [{ process, provider: "codex" }];
    if (
      executable === "claude" &&
      !/--help|--version|claude-code-acp/iu.test(process.command) &&
      (!lower.includes(".app/") || lower.includes("application support/claude/claude-code/claude"))
    )
      return [{ process, provider: "claude" }];
    return [];
  });
  return candidates
    .sort(
      (left, right) =>
        (right.process.startedAt ?? 0) - (left.process.startedAt ?? 0) ||
        right.process.pid - left.process.pid,
    )
    .filter(
      (candidate, index) =>
        index === 0 || candidate.process.pid !== candidates[index - 1]?.process.pid,
    );
};

const completeLines = (text: string): string[] => {
  const last = text.lastIndexOf("\n");
  return (last < 0 ? "" : text.slice(0, last)).split("\n").filter((line) => line.length > 0);
};
const object = (line: string): Record<string, unknown> | undefined => {
  try {
    const parsed = JSON.parse(line) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};
const title = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const result = Array.from(value)
    .filter((character) => !/[\p{Cc}\r\n]/u.test(character))
    .slice(0, 64)
    .join("");
  return result || undefined;
};

/** Parses only bounded session metadata, never returning the JSONL body or arbitrary fields. */
export const parsePiFamilySession = (
  prefix: string,
  tail: string | undefined,
  dialect: Dialect,
  path: string,
  modifiedAt: number | undefined,
  now: number,
): PiRecord | undefined => {
  const lines = [...completeLines(prefix)];
  let ompTitle: unknown;
  if (dialect === "omp") {
    const first = lines[0] === undefined ? undefined : object(lines[0]);
    if (first?.type === "title") {
      ompTitle = first.title;
      lines.shift();
    }
  }
  const header = lines[0] === undefined ? undefined : object(lines[0]);
  if (header?.type !== "session" || typeof header.id !== "string" || header.id.length === 0)
    return undefined;
  if (dialect === "pi" && header.version !== 3) return undefined;
  let rawTitle = dialect === "omp" ? (ompTitle ?? header.title) : undefined;
  if (dialect === "pi" && tail !== undefined) {
    for (const line of completeLines(tail).reverse()) {
      const entry = object(line);
      if (entry?.type === "session_info") {
        rawTitle = entry.name;
        break;
      }
    }
  }
  const sessionName = title(rawTitle);
  const startedAt = asDate(header.timestamp);
  return {
    id: header.id,
    ...(typeof header.cwd === "string" && header.cwd.length > 0 ? { cwd: header.cwd } : {}),
    ...(sessionName === undefined ? {} : { sessionName }),
    ...(startedAt === undefined ? {} : { startedAt }),
    modifiedAt: clampModifiedAt(modifiedAt, now),
    path,
  };
};

const commandValue = (command: string, flag: string): string | undefined => {
  const values = tokens(command);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    if (value === flag) {
      const next = values[index + 1];
      return next === undefined || next.startsWith("-") ? undefined : next;
    }
    if (value.startsWith(`${flag}=`)) return value.slice(flag.length + 1) || undefined;
  }
  return undefined;
};

const pathValue = (value: string, cwd: string, home: string): string | undefined => {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const expanded =
    trimmed === "~" ? home : trimmed.startsWith("~/") ? join(home, trimmed.slice(2)) : trimmed;
  return resolve(isAbsolute(expanded) ? expanded : join(cwd, expanded));
};

const rootsFor = (
  process: NodeAgentProcess,
  dialect: Dialect,
  cwd: string,
  environment: Readonly<Record<string, string | undefined>>,
): readonly Root[] => {
  const home = environment.HOME?.trim() || homedir();
  const direct =
    commandValue(process.command, "--session-dir") ?? environment.PI_CODING_AGENT_SESSION_DIR;
  if (direct !== undefined) {
    const path = pathValue(direct, cwd, home);
    return path === undefined ? [] : [{ path, layout: "direct" }];
  }
  if (dialect === "pi") {
    const root = environment.PI_CODING_AGENT_DIR?.trim();
    return [
      {
        path: root ? join(resolve(root), "sessions") : join(home, ".pi", "agent", "sessions"),
        layout: "projects",
      },
    ];
  }
  const xdg = environment.XDG_DATA_HOME?.trim() || join(home, ".local", "share");
  return [
    { path: join(home, ".omp", "agent", "sessions"), layout: "projects" },
    { path: join(xdg, "omp", "sessions"), layout: "projects" },
  ];
};

const inside = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};

const recordsIn = async (
  root: Root,
  dialect: Dialect,
  files: NodeAgentSessionFiles,
  now: number,
  remaining: { value: number },
  signal: AbortSignal,
): Promise<readonly PiRecord[]> => {
  aborted(signal);
  const canonicalRoot = await files.canonical(root.path, signal);
  if (canonicalRoot === undefined) return [];
  const directories =
    root.layout === "direct"
      ? [canonicalRoot]
      : [...(await files.list(canonicalRoot, signal))]
          .filter((entry) => entry.type === "directory" && inside(canonicalRoot, entry.path))
          .sort((left, right) => left.path.localeCompare(right.path))
          .map((entry) => entry.path);
  const records: PiRecord[] = [];
  for (const directory of directories) {
    aborted(signal);
    if (remaining.value <= 0) break;
    const entries = await files.list(directory, signal);
    for (const entry of [...entries].sort((left, right) => left.path.localeCompare(right.path))) {
      aborted(signal);
      if (remaining.value-- <= 0) break;
      if (
        entry.type !== "file" ||
        !entry.path.endsWith(".jsonl") ||
        !inside(canonicalRoot, entry.path)
      )
        continue;
      const canonical = await files.canonical(entry.path, signal);
      if (canonical === undefined || !inside(canonicalRoot, canonical)) continue;
      const prefix = await files.readPrefix(canonical, prefixBytes, signal);
      if (prefix === undefined) continue;
      const tail =
        dialect === "pi" ? await files.readTail(canonical, tailBytes, signal) : undefined;
      const record = parsePiFamilySession(prefix, tail, dialect, canonical, entry.modifiedAt, now);
      if (record !== undefined) records.push(record);
    }
  }
  const seen = new Set<string>();
  return records
    .sort(
      (left, right) =>
        right.modifiedAt - left.modifiedAt ||
        left.id.localeCompare(right.id) ||
        left.path.localeCompare(right.path),
    )
    .filter((record) => !seen.has(record.id) && (seen.add(record.id), true));
};

export const scanNodeAgentSessions = async (
  options: NodeAgentSessionScannerOptions,
  signal: AbortSignal,
): Promise<readonly NodeAgentSession[]> => {
  aborted(signal);
  const now = options.now?.() ?? Date.now();
  const processes = (await options.processes(signal)).slice(0, options.maximumProcesses ?? 64);
  const candidates = classifyAgentProcesses(processes);
  const cwdByPID = await options.cwdByPID(
    candidates.map((candidate) => candidate.process.pid),
    signal,
  );
  const environment = options.environment ?? process.env;
  const remaining = { value: options.maximumDirectoryEntries ?? 512 };
  const rootCache = new Map<string, Promise<readonly PiRecord[]>>();
  const usedRecords = new Set<string>();
  const sessions: NodeAgentSession[] = [];
  for (const candidate of candidates) {
    aborted(signal);
    const cwd = cwdByPID.get(candidate.process.pid);
    if (candidate.provider !== "pi" || candidate.dialect === undefined) {
      const processProjectName = projectName(cwd);
      const desktopApp =
        candidate.provider === "claude" &&
        /application support\/claude\/claude-code/iu.test(candidate.process.command);
      sessions.push({
        id: `pid:${candidate.process.pid}`,
        state: "active",
        provider: candidate.provider,
        source: desktopApp ? "desktopApp" : "cli",
        pid: candidate.process.pid,
        ...(cwd === undefined ? {} : { cwd }),
        ...(processProjectName === undefined ? {} : { projectName: processProjectName }),
        ...(candidate.process.startedAt === undefined
          ? {}
          : { startedAt: new Date(candidate.process.startedAt).toISOString() }),
        host: "local",
      });
      continue;
    }
    let selected: PiRecord | undefined;
    if (cwd !== undefined && candidate.process.startedAt !== undefined) {
      for (const root of rootsFor(candidate.process, candidate.dialect, cwd, environment)) {
        const key = `${candidate.dialect}:${root.layout}:${root.path}`;
        const records =
          rootCache.get(key) ??
          recordsIn(root, candidate.dialect, options.files, now, remaining, signal);
        rootCache.set(key, records);
        const available = await records;
        selected = available.find(
          (record) =>
            record.modifiedAt >= candidate.process.startedAt! &&
            record.cwd !== undefined &&
            resolve(record.cwd) === resolve(cwd) &&
            !usedRecords.has(record.path),
        );
        if (selected !== undefined) {
          usedRecords.add(selected.path);
          break;
        }
      }
    }
    const activity = selected?.modifiedAt;
    const resolvedCwd = cwd ?? selected?.cwd;
    const resolvedProjectName = projectName(resolvedCwd);
    sessions.push({
      id: selected?.id ?? `pid:${candidate.process.pid}`,
      state: sessionState(activity, now),
      provider: "pi",
      dialect: candidate.dialect,
      source: "cli",
      pid: candidate.process.pid,
      ...(resolvedCwd === undefined ? {} : { cwd: resolvedCwd }),
      ...(resolvedProjectName === undefined ? {} : { projectName: resolvedProjectName }),
      ...(selected?.sessionName === undefined ? {} : { sessionName: selected.sessionName }),
      ...(selected?.startedAt === undefined
        ? candidate.process.startedAt === undefined
          ? {}
          : { startedAt: new Date(candidate.process.startedAt).toISOString() }
        : { startedAt: selected.startedAt }),
      ...(activity === undefined ? {} : { lastActivityAt: new Date(activity).toISOString() }),
      ...(selected === undefined ? {} : { transcriptPath: selected.path }),
      host: "local",
    });
  }
  const seen = new Set<string>();
  return sessions
    .sort(
      (left, right) =>
        Number(right.state === "active") - Number(left.state === "active") ||
        Date.parse(right.lastActivityAt ?? right.startedAt ?? "") -
          Date.parse(left.lastActivityAt ?? left.startedAt ?? "") ||
        (right.pid ?? 0) - (left.pid ?? 0),
    )
    .filter((session) => !seen.has(session.id) && (seen.add(session.id), true));
};

export const makeNodeAgentSessionFiles = (): NodeAgentSessionFiles => ({
  canonical: async (path, signal) => {
    aborted(signal);
    try {
      return await realpath(path);
    } catch {
      aborted(signal);
      return undefined;
    }
  },
  list: async (path, signal) => {
    aborted(signal);
    try {
      const entries = await readdir(path, { withFileTypes: true });
      return await Promise.all(
        entries.slice(0, 512).flatMap(async (entry) => {
          aborted(signal);
          const entryPath = join(path, entry.name);
          if (!entry.isFile() && !entry.isDirectory()) return [];
          try {
            const stats = await lstat(entryPath);
            return [
              {
                path: entryPath,
                type: entry.isDirectory() ? "directory" : "file",
                ...(entry.isFile() ? { modifiedAt: stats.mtimeMs } : {}),
              } satisfies NodeAgentSessionDirectoryEntry,
            ];
          } catch {
            return [];
          }
        }),
      ).then((groups) => groups.flat());
    } catch {
      aborted(signal);
      return [];
    }
  },
  readPrefix: async (path, maximumBytes, signal) => {
    aborted(signal);
    const boundedMaximum = safeReadMaximum(maximumBytes);
    const file = await openRegular(path, signal);
    if (file === undefined) return undefined;
    try {
      return readBounded(file, 0, boundedMaximum, signal);
    } finally {
      await file.close();
    }
  },
  readTail: async (path, maximumBytes, signal) => {
    aborted(signal);
    const boundedMaximum = safeReadMaximum(maximumBytes);
    try {
      const file = await openRegular(path, signal);
      if (file === undefined) return undefined;
      try {
        const size = (await file.stat()).size;
        return readBounded(file, Math.max(0, size - boundedMaximum), boundedMaximum, signal);
      } finally {
        await file.close();
      }
    } catch {
      aborted(signal);
      return undefined;
    }
  },
});

const nodeFiles = makeNodeAgentSessionFiles();

const safeReadMaximum = (maximumBytes: number): number => {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0 || maximumBytes > 64 * 1024)
    throw new RangeError("Session metadata read limit must be an integer from 1 to 65536 bytes.");
  return maximumBytes;
};

const readBounded = async (
  file: Awaited<ReturnType<typeof open>>,
  offset: number,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<string | undefined> => {
  try {
    const buffer = Buffer.allocUnsafe(maximumBytes);
    const { bytesRead } = await file.read(buffer, 0, maximumBytes, offset);
    aborted(signal);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    aborted(signal);
    return undefined;
  }
};

/**
 * Opens exactly one regular-file inode for a bounded read. lstat/fstat identity
 * validation closes the canonical-path TOCTOU window before any bytes leave
 * the platform adapter; O_NOFOLLOW provides an additional POSIX guard.
 */
const openRegular = async (
  path: string,
  signal: AbortSignal,
): Promise<Awaited<ReturnType<typeof open>> | undefined> => {
  try {
    const before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) return undefined;
    aborted(signal);
    const flags =
      process.platform === "win32" || constants.O_NOFOLLOW === undefined
        ? constants.O_RDONLY
        : constants.O_RDONLY | constants.O_NOFOLLOW;
    const file = await open(path, flags);
    try {
      const after = await file.stat({ bigint: true });
      if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino) {
        await file.close();
        return undefined;
      }
      aborted(signal);
      return file;
    } catch (error) {
      await file.close();
      throw error;
    }
  } catch {
    aborted(signal);
    return undefined;
  }
};

const runTool = (
  command: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<{ readonly code: number; readonly stdout: string }> => {
  if (!isAbsolute(command) && !win32.isAbsolute(command))
    return Promise.reject(new Error("Session host tool path must be absolute."));
  return new Promise((resolvePromise, reject) => {
    aborted(signal);
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let output = "";
    const timeout = setTimeout(() => child.kill(), 1_500);
    const abort = () => child.kill();
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      if (output.length < 512 * 1024)
        output += chunk.toString("utf8", 0, 512 * 1024 - output.length);
      else child.kill();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      if (signal.aborted)
        reject(
          signal.reason instanceof Error ? signal.reason : new Error("Session scan cancelled"),
        );
      else resolvePromise({ code: code ?? 1, stdout: output });
    });
  });
};

const psProcesses = async (
  executable: string,
  signal: AbortSignal,
): Promise<readonly NodeAgentProcess[]> => {
  const result = await runTool(executable, ["-axo", "pid=,ppid=,lstart=,command="], signal);
  if (result.code !== 0) return [];
  return result.stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.+)$/u.exec(line);
    if (!match) return [];
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const startedAt = Date.parse(match[3]!);
    return Number.isSafeInteger(pid) && Number.isSafeInteger(ppid)
      ? [{ pid, ppid, command: match[4]!, ...(Number.isFinite(startedAt) ? { startedAt } : {}) }]
      : [];
  });
};

const windowsProcesses = async (
  executable: string,
  signal: AbortSignal,
): Promise<readonly NodeAgentProcess[]> => {
  const result = await runTool(
    executable,
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress",
    ],
    signal,
  );
  if (result.code !== 0) return [];
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    const values = Array.isArray(parsed) ? parsed : [parsed];
    return values.flatMap((value): readonly NodeAgentProcess[] => {
      if (typeof value !== "object" || value === null) return [];
      const row = value as Record<string, unknown>;
      const pid = typeof row.ProcessId === "number" ? row.ProcessId : Number(row.ProcessId);
      const ppid =
        typeof row.ParentProcessId === "number" ? row.ParentProcessId : Number(row.ParentProcessId);
      return Number.isSafeInteger(pid) &&
        Number.isSafeInteger(ppid) &&
        typeof row.CommandLine === "string"
        ? [{ pid, ppid, command: row.CommandLine }]
        : [];
    });
  } catch {
    return [];
  }
};

const cwdFromProc = async (
  pids: readonly number[],
  signal: AbortSignal,
): Promise<ReadonlyMap<number, string>> => {
  const result = new Map<number, string>();
  for (const pid of pids.slice(0, 64)) {
    aborted(signal);
    try {
      result.set(pid, await realpath(`/proc/${pid}/cwd`));
    } catch {
      // A process can exit while scanning; pid-only sessions remain valid.
    }
  }
  return result;
};

/** Node composition adapter. OS differences are contained here, never in the CLI/domain scanner. */
export const makeNodeAgentSessionRuntime = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
  tools: NodeAgentSessionToolPaths = defaultToolPaths(),
) => ({
  scan: (signal: AbortSignal) =>
    scanNodeAgentSessions(
      {
        processes: (requestSignal) =>
          process.platform === "win32"
            ? windowsProcesses(tools.powershell, requestSignal)
            : psProcesses(tools.ps, requestSignal),
        cwdByPID: (pids, requestSignal) =>
          process.platform === "linux"
            ? cwdFromProc(pids, requestSignal)
            : Promise.resolve(new Map()),
        files: nodeFiles,
        environment,
      },
      signal,
    ),
  focus: async (
    session: { readonly id: string; readonly pid?: number },
    signal: AbortSignal,
  ): Promise<"focused" | "activated" | "failed"> => {
    aborted(signal);
    if (
      process.platform !== "darwin" ||
      session.pid === undefined ||
      !Number.isSafeInteger(session.pid)
    )
      return "failed";
    const script = `tell application "System Events" to set frontmost of (first process whose unix id is ${session.pid}) to true`;
    try {
      return (await runTool(tools.osascript, ["-e", script], signal)).code === 0
        ? "focused"
        : "failed";
    } catch {
      return "failed";
    }
  },
});

/** Fixed absolute system paths avoid resolving host tooling through user-controlled PATH. */
const defaultToolPaths = (): NodeAgentSessionToolPaths => ({
  ps: process.platform === "darwin" ? "/bin/ps" : "/usr/bin/ps",
  powershell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  osascript: "/usr/bin/osascript",
});
