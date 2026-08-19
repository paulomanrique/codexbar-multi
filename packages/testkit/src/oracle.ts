import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { jsonParityEqual, normalizeJson, type JsonValue } from "./json.ts";

const executeFile = promisify(execFile);

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
    timeout: request.timeoutMs ?? 20_000,
    maxBuffer: 1024 * 1024,
    encoding: "utf8",
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

/** Runs a checked-out Swift oracle as a bounded, explicit subprocess and accepts JSON only. */
export async function runSwiftOracle(
  request: SwiftOracleRequest,
  executor: OracleExecutor = defaultExecutor,
): Promise<JsonValue> {
  const result = await executor(request);
  try {
    return normalizeJson(JSON.parse(result.stdout), { redactSecrets: true });
  } catch (cause) {
    throw new Error("Swift oracle did not return valid bounded JSON", { cause });
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
