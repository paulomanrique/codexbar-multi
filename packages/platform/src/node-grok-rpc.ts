import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { delimiter, dirname, isAbsolute, join, win32 } from "node:path";

export const NODE_GROK_RPC_INITIALIZE_TIMEOUT_MS = 4_000;
export const NODE_GROK_RPC_BILLING_TIMEOUT_MS = 3_000;
export const NODE_GROK_RPC_MAXIMUM_OUTPUT_BYTES = 1024 * 1024;
export const NODE_GROK_RPC_MAXIMUM_LINE_BYTES = 256 * 1024;

export interface NodeGrokCliBillingResult {
  /** Logical RPC completion, intentionally independent of teardown's exit signal. */
  readonly exitCode: number | undefined;
  readonly signal: string | undefined;
  /** Only the initialize and billing JSON-RPC responses, never arbitrary CLI output. */
  readonly stdout: string;
  /** Controlled auth diagnostic; raw child stderr never escapes this adapter. */
  readonly stderr: string;
}

export class NodeGrokRpcError extends Error {
  readonly code:
    | "cancelled"
    | "closed"
    | "malformed"
    | "output-too-large"
    | "request-failed"
    | "start-failed"
    | "timeout";

  constructor(code: NodeGrokRpcError["code"], message: string) {
    super(message);
    this.code = code;
    this.name = "NodeGrokRpcError";
  }
}

type JsonObject = Readonly<Record<string, unknown>>;

export interface NodeGrokCliBillingOptions {
  /** Already resolved by the Grok-only platform capability; never provider controlled. */
  readonly command: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly signal: AbortSignal;
  readonly initializeTimeoutMs?: number;
  readonly billingTimeoutMs?: number;
  readonly maximumOutputBytes?: number;
  readonly maximumLineBytes?: number;
  /** Injectable only for deterministic platform tests. */
  readonly spawnImpl?: typeof spawn;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

const initializeRequest = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "1",
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  },
} as const;
const billingRequest = { jsonrpc: "2.0", id: 2, method: "x.ai/billing", params: {} } as const;

const boundedPositiveInteger = (value: number, maximum: number, description: string): number => {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new NodeGrokRpcError("start-failed", `Grok CLI ${description} is invalid.`);
  }
  return value;
};

/**
 * Exact newline-delimited ACP input retained for fixtures and compatibility.
 * The actual exchange writes the second request only after `initialize` succeeds.
 */
export const nodeGrokCliBillingInput = (): Uint8Array =>
  encoder.encode(`${JSON.stringify(initializeRequest)}\n${JSON.stringify(billingRequest)}\n`);

const messageFor = (id: number, request: JsonObject): Uint8Array =>
  encoder.encode(`${JSON.stringify({ ...request, id })}\n`);

const jsonObject = (value: unknown): JsonObject | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;

const responseId = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;

const boundedMessage = (value: unknown): string => {
  if (typeof value !== "string") return "Grok CLI JSON-RPC request failed.";
  if (/authentication required|grok login|not authenticated/iu.test(value))
    return "Authentication required";
  if (/method not found/iu.test(value)) return "Method not found";
  return "Grok CLI JSON-RPC request failed.";
};

const safeDiagnostic = (value: Buffer): string => {
  try {
    return /authentication required|grok login|not authenticated/iu.test(decoder.decode(value))
      ? "Authentication required"
      : "";
  } catch {
    return "";
  }
};

const environmentKeys = [
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "GROK_HOME",
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

const unique = (values: readonly string[]): readonly string[] => [
  ...new Set(values.filter((value) => value.length > 0)),
];

/**
 * A deliberately small search path for the fixed `grok` binary and its
 * shebang runtime. Parent PATH entries and provider secrets never propagate.
 */
export const nodeGrokCliSearchPath = (
  environment: Readonly<Record<string, string | undefined>>,
  home: string,
  platform: NodeJS.Platform,
  command: string,
): string => {
  const paths = platform === "win32" ? win32 : { join };
  const executableDirectory =
    platform === "win32"
      ? win32.isAbsolute(command)
        ? win32.dirname(command)
        : undefined
      : isAbsolute(command)
        ? dirname(command)
        : undefined;
  const configuredLocalBin =
    platform === "win32"
      ? environment.LOCALAPPDATA === undefined
        ? undefined
        : paths.join(environment.LOCALAPPDATA, "Programs", "xAI")
      : paths.join(home, ".local", "bin");
  const systemPaths =
    platform === "win32"
      ? [
          environment.SYSTEMROOT === undefined
            ? undefined
            : paths.join(environment.SYSTEMROOT, "System32"),
          environment.WINDIR === undefined ? undefined : paths.join(environment.WINDIR, "System32"),
        ]
      : ["/usr/local/bin", "/usr/bin", "/bin"];
  return unique(
    [
      executableDirectory,
      configuredLocalBin,
      platform === "win32" ? undefined : paths.join(home, ".grok", "bin"),
      dirname(process.execPath),
      ...systemPaths,
    ].filter((value): value is string => value !== undefined),
  ).join(platform === "win32" ? win32.delimiter : delimiter);
};

/** Only Grok's resolved executable or the fixed `grok` binary name may run. */
export const isNodeGrokCliCommand = (value: string): boolean =>
  !value.includes("\u0000") && (isAbsolute(value) || win32.isAbsolute(value) || value === "grok");

export const nodeGrokCliEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
  home: string,
  platform: NodeJS.Platform,
  command: string,
): Readonly<Record<string, string>> => {
  const selected = Object.fromEntries(
    environmentKeys.flatMap((key) =>
      environment[key] === undefined ? [] : ([[key, environment[key]]] as const),
    ),
  );
  return { ...selected, PATH: nodeGrokCliSearchPath(environment, home, platform, command) };
};

const closeChild = (child: ChildProcessWithoutNullStreams): void => {
  if (!child.stdin.destroyed) child.stdin.end();
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const escalation = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 500);
  escalation.unref();
};

const write = async (
  child: ChildProcessWithoutNullStreams,
  payload: Uint8Array,
  signal: AbortSignal,
): Promise<void> => {
  if (signal.aborted) throw new NodeGrokRpcError("cancelled", "Grok CLI billing was cancelled.");
  await new Promise<void>((resolvePromise, rejectPromise) => {
    child.stdin.write(payload, (error) => {
      if (error === undefined || error === null) resolvePromise();
      else rejectPromise(new NodeGrokRpcError("closed", "Grok CLI closed its RPC input."));
    });
  });
};

/**
 * Runs Grok Build's ACP exchange as a streaming session: start, initialize,
 * billing, close. The provider receives no child process surface.
 */
export const runNodeGrokCliBilling = async (
  options: NodeGrokCliBillingOptions,
): Promise<NodeGrokCliBillingResult> => {
  if (!isNodeGrokCliCommand(options.command))
    throw new NodeGrokRpcError("start-failed", "Grok CLI executable is invalid.");
  if (options.signal.aborted)
    throw new NodeGrokRpcError("cancelled", "Grok CLI billing was cancelled.");

  const maximumOutputBytes = boundedPositiveInteger(
    options.maximumOutputBytes ?? NODE_GROK_RPC_MAXIMUM_OUTPUT_BYTES,
    NODE_GROK_RPC_MAXIMUM_OUTPUT_BYTES,
    "output limit",
  );
  const maximumLineBytes = boundedPositiveInteger(
    options.maximumLineBytes ?? NODE_GROK_RPC_MAXIMUM_LINE_BYTES,
    Math.min(NODE_GROK_RPC_MAXIMUM_LINE_BYTES, maximumOutputBytes),
    "line limit",
  );
  const initializeTimeoutMs = boundedPositiveInteger(
    options.initializeTimeoutMs ?? NODE_GROK_RPC_INITIALIZE_TIMEOUT_MS,
    NODE_GROK_RPC_INITIALIZE_TIMEOUT_MS,
    "initialize timeout",
  );
  const billingTimeoutMs = boundedPositiveInteger(
    options.billingTimeoutMs ?? NODE_GROK_RPC_BILLING_TIMEOUT_MS,
    NODE_GROK_RPC_BILLING_TIMEOUT_MS,
    "billing timeout",
  );
  let child: ChildProcessWithoutNullStreams;
  try {
    child = (options.spawnImpl ?? spawn)(options.command, ["agent", "stdio"], {
      env: options.environment,
      shell: false,
      stdio: "pipe",
      windowsHide: true,
    });
  } catch {
    throw new NodeGrokRpcError("start-failed", "Unable to start Grok CLI.");
  }

  const stdoutLines: string[] = [];
  const stderr: Buffer[] = [];
  let outputBytes = 0;
  let stdoutBuffer = Buffer.alloc(0);
  let terminalError: NodeGrokRpcError | undefined;
  let resolveLine: ((line: string) => void) | undefined;
  let rejectLine: ((error: NodeGrokRpcError) => void) | undefined;
  const queuedLines: string[] = [];

  const fail = (error: NodeGrokRpcError): void => {
    if (terminalError !== undefined) return;
    terminalError = error;
    closeChild(child);
    rejectLine?.(error);
    rejectLine = undefined;
    resolveLine = undefined;
  };
  const deliver = (line: string): void => {
    if (resolveLine === undefined) queuedLines.push(line);
    else {
      const resolveCurrent = resolveLine;
      resolveLine = undefined;
      rejectLine = undefined;
      resolveCurrent(line);
    }
  };
  const nextLine = (): Promise<string> => {
    if (terminalError !== undefined) return Promise.reject(terminalError);
    const existing = queuedLines.shift();
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise<string>((resolvePromise, rejectPromise) => {
      resolveLine = resolvePromise;
      rejectLine = rejectPromise;
    });
  };
  const append = (value: Buffer, channel: "stderr" | "stdout"): void => {
    outputBytes += value.byteLength;
    if (outputBytes > maximumOutputBytes) {
      fail(new NodeGrokRpcError("output-too-large", "Grok CLI output exceeded 1 MiB."));
      return;
    }
    if (channel === "stderr") {
      stderr.push(value);
      return;
    }
    stdoutBuffer = Buffer.concat([stdoutBuffer, value]);
    while (true) {
      const newline = stdoutBuffer.indexOf(0x0a);
      if (newline < 0) break;
      const line = stdoutBuffer.subarray(0, newline);
      stdoutBuffer = stdoutBuffer.subarray(newline + 1);
      if (line.byteLength > maximumLineBytes) {
        fail(new NodeGrokRpcError("output-too-large", "Grok CLI response line exceeded 256 KiB."));
        return;
      }
      if (line.byteLength === 0) continue;
      let decodedLine: string;
      try {
        decodedLine = decoder.decode(line);
      } catch {
        fail(new NodeGrokRpcError("malformed", "Grok CLI emitted invalid UTF-8 JSON-RPC output."));
        return;
      }
      deliver(decodedLine);
    }
    if (stdoutBuffer.byteLength > maximumLineBytes)
      fail(new NodeGrokRpcError("output-too-large", "Grok CLI response line exceeded 256 KiB."));
  };

  const onAbort = () => fail(new NodeGrokRpcError("cancelled", "Grok CLI billing was cancelled."));
  options.signal.addEventListener("abort", onAbort, { once: true });
  child.stdout.on("data", (value: Buffer) => append(value, "stdout"));
  child.stderr.on("data", (value: Buffer) => append(value, "stderr"));
  child.once("error", () =>
    fail(new NodeGrokRpcError("start-failed", "Unable to start Grok CLI.")),
  );
  child.once("close", () => {
    if (terminalError === undefined)
      fail(new NodeGrokRpcError("closed", "Grok CLI closed its RPC stream."));
  });

  const request = async (id: number, payload: JsonObject, timeoutMs: number): Promise<void> => {
    await write(child, messageFor(id, payload), options.signal);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          while (true) {
            const line = await nextLine();
            let message: JsonObject | undefined;
            try {
              message = jsonObject(JSON.parse(line));
            } catch {
              continue;
            }
            if (message === undefined || responseId(message.id) !== id) continue;
            const error = jsonObject(message.error);
            if (error !== undefined)
              throw new NodeGrokRpcError("request-failed", boundedMessage(error.message));
            if (!("result" in message))
              throw new NodeGrokRpcError(
                "malformed",
                "Grok CLI JSON-RPC response is missing result.",
              );
            stdoutLines.push(line);
            return;
          }
        })(),
        new Promise<never>((_, rejectPromise) => {
          timer = setTimeout(
            () =>
              rejectPromise(
                new NodeGrokRpcError("timeout", "Grok CLI JSON-RPC request timed out."),
              ),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  try {
    await request(1, initializeRequest, initializeTimeoutMs);
    await request(2, billingRequest, billingTimeoutMs);
    // Match Swift's `defer { shutdown() }`: EOF first, then bounded termination.
    closeChild(child);
    return {
      exitCode: 0,
      signal: undefined,
      stdout: `${stdoutLines.join("\n")}\n`,
      stderr: safeDiagnostic(Buffer.concat(stderr)),
    };
  } catch (error) {
    if (error instanceof NodeGrokRpcError) throw error;
    throw new NodeGrokRpcError("malformed", "Grok CLI JSON-RPC exchange failed.");
  } finally {
    options.signal.removeEventListener("abort", onAbort);
    closeChild(child);
  }
};
