import { execFile } from "node:child_process";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";

import { jsonParityEqual, normalizeJson, type JsonValue } from "./json.ts";

const executeFile = promisify(execFile);

const MAX_ORACLE_OUTPUT_BYTES = 1024 * 1024;
const MAX_ORACLE_TIMEOUT_MS = 30_000;
const DEFAULT_ORACLE_TIMEOUT_MS = 20_000;
export const SWIFT_ORACLE_BASELINE_COMMIT = "453174fe13eebdf403cc0776268eb2b101fd9553";

/** Fixed operations exposed by Sources/CodexBarOracle; arbitrary provider probes are impossible. */
export const OFFLINE_SWIFT_ORACLE_CASES = [
  "snapshot-serialization",
  "qwencloud-flat-subscription",
  "moonshot-balance",
  "moonshot-settings",
  "fireworks-summary",
  "fireworks-settings",
  "fireworks-request",
  "groq-scalar",
  "groq-settings",
  "groq-request",
  "groq-snapshot",
] as const;
export type OfflineSwiftOracleCase = (typeof OFFLINE_SWIFT_ORACLE_CASES)[number];

export interface SwiftOracleRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly environment?: Readonly<Record<string, string>>;
}

export interface OracleProcessResult {
  readonly stdout: string;
  readonly stderr: string;
}

export type OracleExecutor = (request: SwiftOracleRequest) => Promise<OracleProcessResult>;

const defaultExecutor: OracleExecutor = async (request) => {
  const result = await executeFile(request.executable, [...request.args], {
    ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
    ...(request.environment === undefined ? {} : { env: { ...request.environment } }),
    timeout: request.timeoutMs ?? DEFAULT_ORACLE_TIMEOUT_MS,
    maxBuffer: MAX_ORACLE_OUTPUT_BYTES,
    encoding: "utf8",
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function assertBoundedRequest(request: SwiftOracleRequest): void {
  const timeoutMs = request.timeoutMs ?? DEFAULT_ORACLE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_ORACLE_TIMEOUT_MS)
    throw new RangeError(`Swift oracle timeout must be between 100 and ${MAX_ORACLE_TIMEOUT_MS}ms`);
  if (
    request.args.length > 8 ||
    request.args.some((argument) => argument.length > 256 || argument.includes("\0"))
  )
    throw new Error("Swift oracle arguments exceed the bounded offline protocol");
}

/** Runs a checked-out Swift oracle as a bounded, explicit subprocess and accepts JSON only. */
export async function runSwiftOracle(
  request: SwiftOracleRequest,
  executor: OracleExecutor = defaultExecutor,
): Promise<JsonValue> {
  assertBoundedRequest(request);
  const result = await executor(request);
  if (
    Buffer.byteLength(result.stdout, "utf8") > MAX_ORACLE_OUTPUT_BYTES ||
    Buffer.byteLength(result.stderr, "utf8") > MAX_ORACLE_OUTPUT_BYTES
  )
    throw new Error("Swift oracle exceeded the 1 MiB output limit");
  try {
    return normalizeJson(JSON.parse(result.stdout), { redactSecrets: true });
  } catch (cause) {
    throw new Error("Swift oracle did not return valid bounded JSON", { cause });
  }
}

export interface OfflineSwiftOracleRequest {
  /** Absolute checkout containing the pinned upstream baseline and oracle target. */
  readonly repositoryRoot: string;
  readonly oracleCase: OfflineSwiftOracleCase;
  /** A prebuilt binary only. The gate deliberately never invokes SwiftPM or a network resolver. */
  readonly executable?: string;
  readonly timeoutMs?: number;
}

export interface OfflineOracleParityResult {
  readonly baselineCommit: string;
  readonly oracleCase: OfflineSwiftOracleCase;
  readonly comparison: OracleComparison;
}

function isOfflineOracleCase(value: string): value is OfflineSwiftOracleCase {
  return (OFFLINE_SWIFT_ORACLE_CASES as readonly string[]).includes(value);
}

async function assertPinnedRepository(repositoryRoot: string): Promise<string> {
  if (!isAbsolute(repositoryRoot)) throw new Error("Swift oracle repository root must be absolute");
  const canonicalRoot = await realpath(repositoryRoot);
  const baselinePath = join(canonicalRoot, "upstream", "baseline.json");
  const baseline = JSON.parse(await readFile(baselinePath, "utf8")) as {
    readonly codexBar?: { readonly commit?: unknown };
  };
  if (baseline.codexBar?.commit !== SWIFT_ORACLE_BASELINE_COMMIT)
    throw new Error("Swift oracle baseline does not match the accepted CodexBar commit");
  return canonicalRoot;
}

async function assertTrustedExecutable(root: string, executable: string): Promise<string> {
  const canonical = await realpath(executable);
  if (!isWithin(root, canonical))
    throw new Error("Swift oracle executable escapes repository root");
  const metadata = await lstat(canonical);
  if (!metadata.isFile()) throw new Error("Swift oracle executable must be a regular file");
  if (process.platform !== "win32" && (metadata.mode & 0o111) === 0)
    throw new Error("Swift oracle executable is not executable");
  return canonical;
}

function offlineEnvironment(root: string, temporaryHome: string): Readonly<Record<string, string>> {
  // Do not inherit the caller environment: credentials and proxy settings must never enter the oracle.
  // This is intentionally a parser/serialization target with no transport code path; the flags are also
  // checked by the Swift executable so accidental future expansion fails closed.
  return {
    PATH: "",
    HOME: temporaryHome,
    TMPDIR: temporaryHome,
    LANG: "C",
    LC_ALL: "C",
    NO_PROXY: "*",
    no_proxy: "*",
    http_proxy: "",
    https_proxy: "",
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
    CODEXBAR_ORACLE_ROOT: root,
    CODEXBAR_ORACLE_NETWORK: "0",
    CODEXBAR_ORACLE_CREDENTIALS: "0",
  };
}

/**
 * Executes the fixed, prebuilt Swift oracle offline and compares it with a TypeScript result.
 * Building is intentionally outside this API: SwiftPM resolution can reach the network, whereas this
 * gate only runs an already-built target against checked-in fixture bytes.
 */
export async function runOfflineSwiftOracleParity(
  request: OfflineSwiftOracleRequest,
  typescript: unknown,
  executor: OracleExecutor = defaultExecutor,
): Promise<OfflineOracleParityResult> {
  if (!isOfflineOracleCase(request.oracleCase))
    throw new Error("Unknown offline Swift oracle case");
  const root = await assertPinnedRepository(request.repositoryRoot);
  const executable = await assertTrustedExecutable(
    root,
    request.executable ?? join(root, ".build", "debug", "CodexBarOracle"),
  );
  const temporaryHome = await mkdtemp(join(tmpdir(), "codexbar-oracle-"));
  try {
    const oracle = await runSwiftOracle(
      {
        executable,
        args: [request.oracleCase],
        cwd: root,
        timeoutMs: request.timeoutMs ?? DEFAULT_ORACLE_TIMEOUT_MS,
        environment: offlineEnvironment(root, temporaryHome),
      },
      executor,
    );
    return {
      baselineCommit: SWIFT_ORACLE_BASELINE_COMMIT,
      oracleCase: request.oracleCase,
      comparison: compareWithOracle(oracle, typescript),
    };
  } finally {
    await rm(temporaryHome, { recursive: true, force: true });
  }
}

export interface OracleComparison {
  readonly equal: boolean;
  readonly oracle: JsonValue;
  readonly typescript: JsonValue;
}

export function compareWithOracle(oracle: unknown, typescript: unknown): OracleComparison {
  return {
    equal: jsonParityEqual(oracle, typescript, { redactSecrets: true }),
    oracle: normalizeJson(oracle, { redactSecrets: true }),
    typescript: normalizeJson(typescript, { redactSecrets: true }),
  };
}
