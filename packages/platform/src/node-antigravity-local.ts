import { request as requestHTTP } from "node:http";
import { request as requestHTTPS } from "node:https";
import { open, readdir, readlink } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { Effect } from "effect";
import type { ProcessRunnerService } from "@codexbar/core";
import type { ProviderAntigravityLocalSnapshot } from "@codexbar/providers";

const maximumResponseBytes = 1024 * 1024;
const maximumProcesses = 4_096;
const defaultTimeoutMs = 8_000;
const identityTimeoutMs = 1_000;
const quotaPath = "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary";
const identityPath = "/exa.language_server_pb.LanguageServerService/GetUserStatus";

export type NodeAntigravityProcessKind = "app" | "cli" | "ide";

export interface NodeAntigravityProcess {
  readonly pid: number;
  readonly command: string;
}

export interface NodeAntigravityProcessInfo extends NodeAntigravityProcess {
  readonly kind: NodeAntigravityProcessKind;
  readonly csrfToken: string;
  readonly extensionPort?: number;
  readonly extensionServerCSRFToken?: string;
}

export interface NodeAntigravityEndpoint {
  readonly scheme: "http" | "https";
  readonly port: number;
  readonly csrfToken: string;
  readonly source: "cli" | "extension-server" | "language-server";
}

export interface NodeAntigravityLocalDependencies {
  readonly processes: (signal: AbortSignal) => Promise<readonly NodeAntigravityProcess[]>;
  readonly listeningPorts: (pid: number, signal: AbortSignal) => Promise<readonly number[]>;
  readonly request: (
    endpoint: NodeAntigravityEndpoint,
    path: string,
    body: Readonly<Record<string, unknown>>,
    timeoutMs: number,
    signal: AbortSignal,
  ) => Promise<string>;
  /**
   * Host-owned authorization for token-less external `agy` reuse. When this
   * seam is absent CLI processes are excluded, so desktop/embedded hosts never
   * inherit an ambient interactive session accidentally.
   */
  readonly canReuseCLIProcess?: (
    process: NodeAntigravityProcessInfo,
    signal: AbortSignal,
  ) => Promise<boolean>;
  readonly now?: () => number;
}

export interface NodeAntigravityLocalOptions {
  readonly processRunner: ProcessRunnerService;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly procRoot?: string;
  /** One-shot CLI hosts opt in only with the exact resolved `agy` path. */
  readonly externalCLIPath?: string;
}

export class NodeAntigravityLocalError extends Error {
  readonly code:
    | "invalid-response"
    | "missing-csrf"
    | "not-running"
    | "port-detection-failed"
    | "request-failed";

  constructor(code: NodeAntigravityLocalError["code"], message: string) {
    super(message);
    this.code = code;
    this.name = "NodeAntigravityLocalError";
  }
}

const throwIfAborted = (signal: AbortSignal): void => {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Cancelled", "AbortError");
};

const decode = (bytes: Uint8Array): string =>
  new TextDecoder("utf-8", { fatal: true }).decode(bytes);

const run = async (
  processRunner: ProcessRunnerService,
  command: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<{ readonly exitCode: number | undefined; readonly stdout: string }> => {
  const result = await Effect.runPromise(
    processRunner.run({ command, args, timeoutMs: defaultTimeoutMs }),
    { signal },
  );
  return { exitCode: result.exitCode, stdout: decode(result.stdout) };
};

const validPID = (value: unknown): number | undefined => {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
};

/** Parses the fixed `ps` output without accepting a command from a provider. */
export const parseNodeAntigravityPSOutput = (output: string): readonly NodeAntigravityProcess[] =>
  output
    .split("\n")
    .slice(0, maximumProcesses)
    .flatMap((line): readonly NodeAntigravityProcess[] => {
      const match = /^\s*(\d+)\s+(.+)$/u.exec(line);
      const pid = validPID(match?.[1]);
      const command = match?.[2]?.trim();
      return pid === undefined || !command || command.includes("\u0000") ? [] : [{ pid, command }];
    });

/** Parses only PID and command line from the fixed Windows CIM projection. */
export const parseNodeAntigravityWindowsProcesses = (
  output: string,
): readonly NodeAntigravityProcess[] => {
  if (output.trim() === "") return [];
  const parsed = JSON.parse(output) as unknown;
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.slice(0, maximumProcesses).flatMap((row): readonly NodeAntigravityProcess[] => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) return [];
    const value = row as Readonly<Record<string, unknown>>;
    const pid = validPID(value.ProcessId);
    const command = typeof value.CommandLine === "string" ? value.CommandLine.trim() : "";
    return pid === undefined || command === "" || command.includes("\u0000")
      ? []
      : [{ pid, command }];
  });
};

export const extractNodeAntigravityFlag = (command: string, flag: string): string | undefined => {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const value = new RegExp(`${escaped}[=\\s]+([^\\s]+)`, "iu").exec(command)?.[1];
  return value === undefined || value === "" || value.includes("\u0000") ? undefined : value;
};

const languageServer = (command: string): boolean =>
  /(^|[/\\])language(?:_|-)server(?:[_-][a-z0-9]+)*(?:\.exe)?(\s|$)/iu.test(command);

const cli = (command: string): boolean =>
  /(^|[/\\])(antigravity-cli|antigravity_cli)(?:\.exe)?(["\s/\\]|$)/iu.test(command) ||
  /(^|[/\\])agy(?:\.exe)?(["\s/\\]|$)/iu.test(command);

const antigravityApp = (command: string): boolean => {
  const lower = command.toLowerCase();
  return (
    (lower.includes("--app_data_dir") && lower.includes("antigravity")) ||
    lower.includes("antigravity.app/") ||
    lower.includes("antigravity.app\\") ||
    lower.includes("/gemini.app/") ||
    lower.includes("\\gemini.app\\") ||
    lower.includes("antigravity ide.app/") ||
    lower.includes("antigravity ide.app\\") ||
    lower.includes("/antigravity/") ||
    lower.includes("\\antigravity\\")
  );
};

const antigravityIDE = (command: string): boolean => {
  const lower = command.toLowerCase();
  return [
    "antigravity ide.app/",
    "antigravity ide.app\\",
    "--app_data_dir antigravity-ide",
    "--app_data_dir=antigravity-ide",
    "/extensions/antigravity/bin/language_server",
    "\\extensions\\antigravity\\bin\\language_server",
  ].some((marker) => lower.includes(marker));
};

export const classifyNodeAntigravityProcess = (
  process: NodeAntigravityProcess,
): NodeAntigravityProcessKind | undefined => {
  if (languageServer(process.command) && antigravityApp(process.command))
    return antigravityIDE(process.command) ? "ide" : "app";
  return cli(process.command) ? "cli" : undefined;
};

const commandExecutable = (command: string): string | undefined => {
  const trimmed = command.trimStart();
  if (trimmed === "") return undefined;
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    return end > 1 ? trimmed.slice(1, end) : undefined;
  }
  return /^\S+/u.exec(trimmed)?.[0];
};

/** Conservative path match for externally owned CLI reuse. */
export const nodeAntigravityCommandMatchesBinary = (
  command: string,
  expectedBinaryPath: string,
  platform: NodeJS.Platform,
): boolean => {
  const executable = commandExecutable(command);
  const expected = expectedBinaryPath.trim();
  if (!executable || !expected || executable.includes("\u0000") || expected.includes("\u0000"))
    return false;
  const path = platform === "win32" ? win32 : posix;
  if (!path.isAbsolute(executable) || !path.isAbsolute(expected)) return false;
  const normalizedExecutable = path.normalize(executable);
  const normalizedExpected = path.normalize(expected);
  return platform === "win32"
    ? normalizedExecutable.toLowerCase() === normalizedExpected.toLowerCase()
    : normalizedExecutable === normalizedExpected;
};

export const resolveNodeAntigravityProcesses = (
  processes: readonly NodeAntigravityProcess[],
): readonly NodeAntigravityProcessInfo[] => {
  const rank: Readonly<Record<NodeAntigravityProcessKind, number>> = { app: 0, cli: 1, ide: 2 };
  return processes
    .flatMap((process): readonly NodeAntigravityProcessInfo[] => {
      const kind = classifyNodeAntigravityProcess(process);
      if (kind === undefined) return [];
      const token = extractNodeAntigravityFlag(process.command, "--csrf_token");
      if (kind !== "cli" && token === undefined) return [];
      const extensionPortRaw = extractNodeAntigravityFlag(
        process.command,
        "--extension_server_port",
      );
      const extensionPort = validPort(Number(extensionPortRaw));
      const extensionServerCSRFToken = extractNodeAntigravityFlag(
        process.command,
        "--extension_server_csrf_token",
      );
      return [
        {
          ...process,
          kind,
          csrfToken: token ?? "",
          ...(extensionPort === undefined ? {} : { extensionPort }),
          ...(extensionServerCSRFToken === undefined ? {} : { extensionServerCSRFToken }),
        },
      ];
    })
    .sort((left, right) => rank[left.kind] - rank[right.kind]);
};

const validPort = (value: unknown): number | undefined => {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(number) && number >= 1 && number <= 65_535 ? number : undefined;
};

export const nodeAntigravitySocketInode = (destination: string): string | undefined =>
  /^socket:\[([^\]]+)\]$/u.exec(destination)?.[1];

/** Pure `/proc/<pid>/net/tcp{,6}` LISTEN parser, derived from the Swift oracle. */
export const parseNodeAntigravityProcNetPorts = (
  content: string,
  socketInodes: ReadonlySet<string>,
): readonly number[] => {
  const ports = new Set<number>();
  for (const line of content.split("\n")) {
    const columns = line.trim().split(/\s+/u);
    if (columns.length <= 9 || columns[3] !== "0A" || !socketInodes.has(columns[9]!)) continue;
    const rawPort = columns[1]?.split(":").at(-1);
    const port = rawPort === undefined ? undefined : validPort(Number.parseInt(rawPort, 16));
    if (port !== undefined) ports.add(port);
  }
  return [...ports].sort((left, right) => left - right);
};

export const parseNodeAntigravityProcUID = (content: string): number | undefined => {
  const raw = /^Uid:\s+(\d+)/mu.exec(content)?.[1];
  const uid = raw === undefined ? undefined : Number(raw);
  return uid !== undefined && Number.isSafeInteger(uid) && uid >= 0 ? uid : undefined;
};

const readBounded = async (path: string, signal: AbortSignal): Promise<string> => {
  const file = await open(path, "r");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      throwIfAborted(signal);
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maximumResponseBytes + 1 - total));
      const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maximumResponseBytes)
        throw new NodeAntigravityLocalError("invalid-response", "Local data exceeded 1 MiB.");
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return decode(Buffer.concat(chunks));
  } finally {
    await file.close();
  }
};

export const readNodeAntigravityProcPorts = async (
  pid: number,
  procRoot: string,
  signal: AbortSignal,
): Promise<readonly number[]> => {
  if (validPID(pid) === undefined)
    throw new NodeAntigravityLocalError("port-detection-failed", "Process identifier is invalid.");
  const root = `${procRoot}/${pid}`;
  const inodes = new Set<string>();
  for (const entry of (await readdir(`${root}/fd`)).slice(0, 65_536)) {
    throwIfAborted(signal);
    try {
      const inode = nodeAntigravitySocketInode(await readlink(`${root}/fd/${entry}`));
      if (inode !== undefined) inodes.add(inode);
    } catch {
      // Descriptors may disappear while the process is running.
    }
  }
  const ports = new Set<number>();
  for (const table of ["tcp", "tcp6"]) {
    try {
      for (const port of parseNodeAntigravityProcNetPorts(
        await readBounded(`${root}/net/${table}`, signal),
        inodes,
      ))
        ports.add(port);
    } catch (error) {
      throwIfAborted(signal);
      if (error instanceof NodeAntigravityLocalError) throw error;
    }
  }
  return [...ports].sort((left, right) => left - right);
};

const powershellPath = (environment: Readonly<Record<string, string | undefined>>): string =>
  win32.join(
    environment.SYSTEMROOT?.trim() || environment.WINDIR?.trim() || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );

const parsePorts = (output: string): readonly number[] => {
  if (output.trim() === "") return [];
  const parsed = JSON.parse(output) as unknown;
  const values = Array.isArray(parsed) ? parsed : [parsed];
  return [...new Set(values.flatMap((value) => validPort(value) ?? []))].sort(
    (left, right) => left - right,
  );
};

const lsofPorts = (output: string): readonly number[] =>
  [...output.matchAll(/:(\d+)\s+\(LISTEN\)/gu)]
    .flatMap((match) => validPort(match[1]) ?? [])
    .filter((port, index, all) => all.indexOf(port) === index)
    .sort((left, right) => left - right);

export const makeNodeAntigravityLocalDependencies = (
  options: NodeAntigravityLocalOptions,
): NodeAntigravityLocalDependencies => {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const externalCLIPath = options.externalCLIPath?.trim();
  const currentUID = typeof process.getuid === "function" ? process.getuid() : undefined;
  const currentWindowsUser = environment.USERNAME?.trim().toLowerCase();
  const sameUserCLI = async (
    processInfo: NodeAntigravityProcessInfo,
    signal: AbortSignal,
  ): Promise<boolean> => {
    if (
      externalCLIPath === undefined ||
      externalCLIPath === "" ||
      !nodeAntigravityCommandMatchesBinary(processInfo.command, externalCLIPath, platform)
    )
      return false;
    throwIfAborted(signal);
    if (platform === "linux") {
      if (currentUID === undefined) return false;
      try {
        return (
          parseNodeAntigravityProcUID(
            await readBounded(`${options.procRoot ?? "/proc"}/${processInfo.pid}/status`, signal),
          ) === currentUID
        );
      } catch {
        throwIfAborted(signal);
        return false;
      }
    }
    if (platform === "darwin") {
      if (currentUID === undefined) return false;
      try {
        const result = await run(
          options.processRunner,
          "/bin/ps",
          ["-o", "uid=", "-p", String(processInfo.pid)],
          signal,
        );
        return result.exitCode === 0 && Number(result.stdout.trim()) === currentUID;
      } catch {
        throwIfAborted(signal);
        return false;
      }
    }
    if (platform === "win32") {
      if (!currentWindowsUser) return false;
      const script =
        `(Invoke-CimMethod -InputObject (Get-CimInstance Win32_Process -Filter 'ProcessId = ${processInfo.pid}') ` +
        "-MethodName GetOwner -ErrorAction Stop).User";
      try {
        const result = await run(
          options.processRunner,
          powershellPath(environment),
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
          signal,
        );
        return result.exitCode === 0 && result.stdout.trim().toLowerCase() === currentWindowsUser;
      } catch {
        throwIfAborted(signal);
        return false;
      }
    }
    return false;
  };
  return {
    processes: async (signal) => {
      if (platform === "win32") {
        const script =
          "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
        const result = await run(
          options.processRunner,
          powershellPath(environment),
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
          signal,
        );
        if (result.exitCode !== 0)
          throw new NodeAntigravityLocalError("not-running", "Unable to inspect local processes.");
        return parseNodeAntigravityWindowsProcesses(result.stdout);
      }
      const result = await run(
        options.processRunner,
        "/bin/ps",
        ["-ax", "-o", "pid=,command="],
        signal,
      );
      if (result.exitCode !== 0)
        throw new NodeAntigravityLocalError("not-running", "Unable to inspect local processes.");
      return parseNodeAntigravityPSOutput(result.stdout);
    },
    listeningPorts: async (pid, signal) => {
      if (platform === "linux")
        return readNodeAntigravityProcPorts(pid, options.procRoot ?? "/proc", signal);
      if (platform === "win32") {
        const script =
          `Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object {$_.OwningProcess -eq ${pid}} | ` +
          "Select-Object -ExpandProperty LocalPort | Sort-Object -Unique | ConvertTo-Json -Compress";
        const result = await run(
          options.processRunner,
          powershellPath(environment),
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
          signal,
        );
        return result.exitCode === 0 ? parsePorts(result.stdout) : [];
      }
      for (const command of ["/usr/sbin/lsof", "/usr/bin/lsof"]) {
        try {
          const result = await run(
            options.processRunner,
            command,
            ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", String(pid)],
            signal,
          );
          const ports = result.exitCode === 0 ? lsofPorts(result.stdout) : [];
          if (ports.length > 0) return ports;
        } catch {
          throwIfAborted(signal);
        }
      }
      return [];
    },
    request: requestNodeAntigravityLocalJSON,
    ...(externalCLIPath ? { canReuseCLIProcess: sameUserCLI } : {}),
  };
};

const endpointKey = (endpoint: NodeAntigravityEndpoint): string =>
  `${endpoint.scheme}:${endpoint.port}:${endpoint.csrfToken}`;

export const nodeAntigravityConnectionCandidates = (
  process: NodeAntigravityProcessInfo,
  listeningPorts: readonly number[],
  platform: NodeJS.Platform,
): readonly NodeAntigravityEndpoint[] => {
  const schemes: readonly ("http" | "https")[] =
    platform === "linux" ? ["https", "http"] : ["https"];
  const source = process.kind === "cli" ? "cli" : "language-server";
  const endpoints: NodeAntigravityEndpoint[] = listeningPorts.flatMap((port) =>
    validPort(port) === undefined
      ? []
      : schemes.map((scheme) => ({ scheme, port, csrfToken: process.csrfToken, source })),
  );
  if (process.extensionPort !== undefined) {
    for (const csrfToken of [process.extensionServerCSRFToken, process.csrfToken]) {
      if (csrfToken === undefined) continue;
      const endpoint: NodeAntigravityEndpoint = {
        scheme: "http",
        port: process.extensionPort,
        csrfToken,
        source: "extension-server",
      };
      if (!endpoints.some((candidate) => endpointKey(candidate) === endpointKey(endpoint)))
        endpoints.push(endpoint);
    }
  }
  return endpoints;
};

const defaultIdentityBody = {
  metadata: {
    ideName: "antigravity",
    extensionName: "antigravity",
    ideVersion: "unknown",
    locale: "en",
  },
} as const;

/**
 * Queries only the modern quota-summary path. Legacy model-config fallback and
 * warm `agy` startup remain separate, explicit migration work.
 */
export const fetchNodeAntigravityLocalSnapshot = async (
  dependencies: NodeAntigravityLocalDependencies,
  options: {
    readonly signal: AbortSignal;
    readonly platform?: NodeJS.Platform;
    readonly timeoutMs?: number;
  },
): Promise<ProviderAntigravityLocalSnapshot> => {
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > defaultTimeoutMs)
    throw new NodeAntigravityLocalError("request-failed", "Local probe timeout is invalid.");
  const deadline = (dependencies.now ?? Date.now)() + timeoutMs;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([options.signal, timeoutSignal]);
  const rawProcesses = await dependencies.processes(signal);
  const tokenless = rawProcesses.some((process) => {
    const kind = classifyNodeAntigravityProcess(process);
    return (
      kind !== undefined &&
      kind !== "cli" &&
      extractNodeAntigravityFlag(process.command, "--csrf_token") === undefined
    );
  });
  const resolvedProcesses = resolveNodeAntigravityProcesses(rawProcesses);
  const processes: NodeAntigravityProcessInfo[] = [];
  for (const processInfo of resolvedProcesses) {
    throwIfAborted(signal);
    if (processInfo.kind !== "cli") {
      processes.push(processInfo);
      continue;
    }
    if (dependencies.canReuseCLIProcess === undefined) continue;
    try {
      if (await dependencies.canReuseCLIProcess(processInfo, signal)) processes.push(processInfo);
    } catch {
      throwIfAborted(signal);
      // Ownership/path inspection is best-effort but fail-closed. A caller
      // cancellation or deadline remains terminal; ordinary inspection failure excludes it.
    }
  }
  if (processes.length === 0)
    throw new NodeAntigravityLocalError(
      tokenless ? "missing-csrf" : "not-running",
      tokenless
        ? "Antigravity local authentication is unavailable."
        : "Antigravity is not running.",
    );

  let lastError: unknown;
  const endpointGroups: NodeAntigravityEndpoint[][] = [];
  for (const processInfo of processes) {
    throwIfAborted(signal);
    let ports: readonly number[];
    try {
      ports = await dependencies.listeningPorts(processInfo.pid, signal);
    } catch (error) {
      throwIfAborted(signal);
      lastError = error;
      continue;
    }
    const candidates = nodeAntigravityConnectionCandidates(
      processInfo,
      ports,
      options.platform ?? globalThis.process.platform,
    );
    if (candidates.length > 0) endpointGroups.push([...candidates]);
  }
  const totalEndpoints = endpointGroups.reduce((total, group) => total + group.length, 0);
  let attemptedEndpoints = 0;
  for (const endpoints of endpointGroups) {
    for (const endpoint of endpoints) {
      throwIfAborted(signal);
      const remaining = deadline - (dependencies.now ?? Date.now)();
      if (remaining <= 0) {
        throwIfAborted(options.signal);
        throw new NodeAntigravityLocalError("request-failed", "Antigravity local probe timed out.");
      }
      const attemptTimeout = Math.max(
        1,
        Math.floor(remaining / Math.max(1, totalEndpoints - attemptedEndpoints)),
      );
      attemptedEndpoints += 1;
      try {
        const quotaSummaryJson = await dependencies.request(
          endpoint,
          quotaPath,
          { forceRefresh: true },
          attemptTimeout,
          signal,
        );
        let userStatusJson: string | undefined;
        const identityDeadline = Math.min(
          deadline,
          (dependencies.now ?? Date.now)() + identityTimeoutMs,
        );
        // Identity stays within the process which produced the quota. Mixing
        // process groups can attach another account to this usage snapshot.
        const identityEndpoints = [
          endpoint,
          ...endpoints.filter((candidate) => endpointKey(candidate) !== endpointKey(endpoint)),
        ];
        for (const [identityIndex, identityEndpoint] of identityEndpoints.entries()) {
          const identityRemaining = identityDeadline - (dependencies.now ?? Date.now)();
          if (identityRemaining <= 0) break;
          try {
            userStatusJson = await dependencies.request(
              identityEndpoint,
              identityPath,
              defaultIdentityBody,
              Math.max(
                1,
                Math.floor(
                  identityRemaining / Math.max(1, identityEndpoints.length - identityIndex),
                ),
              ),
              signal,
            );
            break;
          } catch {
            // Identity is best-effort in Swift. Preserve a completed quota
            // response when only the internal deadline expires, while a caller
            // cancellation remains terminal.
            throwIfAborted(options.signal);
          }
        }
        return {
          quotaSummaryJson,
          ...(userStatusJson === undefined ? {} : { userStatusJson }),
        };
      } catch (error) {
        throwIfAborted(options.signal);
        if (timeoutSignal.aborted)
          throw new NodeAntigravityLocalError(
            "request-failed",
            "Antigravity local probe timed out.",
          );
        lastError = error;
      }
    }
  }
  throw new NodeAntigravityLocalError(
    "request-failed",
    lastError === undefined
      ? "Antigravity has no local listening endpoint."
      : "Antigravity local usage request failed.",
  );
};

/** Fixed-loopback HTTP(S) broker with bounded body, no redirect and no credential output. */
export const requestNodeAntigravityLocalJSON = (
  endpoint: NodeAntigravityEndpoint,
  path: string,
  body: Readonly<Record<string, unknown>>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<string> =>
  new Promise((resolvePromise, rejectPromise) => {
    const port = validPort(endpoint.port);
    if (
      port === undefined ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > defaultTimeoutMs ||
      !path.startsWith("/exa.language_server_pb.LanguageServerService/")
    ) {
      rejectPromise(new NodeAntigravityLocalError("request-failed", "Local endpoint is invalid."));
      return;
    }
    throwIfAborted(signal);
    const encoded = Buffer.from(JSON.stringify(body), "utf8");
    const transport = endpoint.scheme === "https" ? requestHTTPS : requestHTTP;
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      callback();
    };
    const request = transport(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        agent: false,
        ...(endpoint.scheme === "https" ? { rejectUnauthorized: false } : {}),
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(encoded.byteLength),
          "Connect-Protocol-Version": "1",
          ...(endpoint.source === "cli" ? {} : { "X-Codeium-Csrf-Token": endpoint.csrfToken }),
        },
      },
      (response) => {
        const contentLength = Number(response.headers["content-length"]);
        if (Number.isFinite(contentLength) && contentLength > maximumResponseBytes) {
          response.destroy();
          finish(() =>
            rejectPromise(
              new NodeAntigravityLocalError("invalid-response", "Local response exceeded 1 MiB."),
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer) => {
          total += chunk.byteLength;
          if (total > maximumResponseBytes) {
            response.destroy();
            finish(() =>
              rejectPromise(
                new NodeAntigravityLocalError("invalid-response", "Local response exceeded 1 MiB."),
              ),
            );
          } else chunks.push(chunk);
        });
        response.once("error", (error) => finish(() => rejectPromise(error)));
        response.once("end", () => {
          if (response.statusCode !== 200) {
            finish(() =>
              rejectPromise(
                new NodeAntigravityLocalError("request-failed", "Local endpoint rejected request."),
              ),
            );
            return;
          }
          try {
            const text = decode(Buffer.concat(chunks));
            JSON.parse(text);
            finish(() => resolvePromise(text));
          } catch {
            finish(() =>
              rejectPromise(
                new NodeAntigravityLocalError("invalid-response", "Local response was not JSON."),
              ),
            );
          }
        });
      },
    );
    const abort = (): void => {
      request.destroy(signal.reason instanceof Error ? signal.reason : undefined);
      finish(() =>
        rejectPromise(
          signal.reason instanceof Error
            ? signal.reason
            : new DOMException("Cancelled", "AbortError"),
        ),
      );
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    request.setTimeout(timeoutMs, () =>
      request.destroy(new NodeAntigravityLocalError("request-failed", "Local request timed out.")),
    );
    request.once("error", (error) => finish(() => rejectPromise(error)));
    request.end(encoded);
  });
