import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, win32 } from "node:path";
import { Effect } from "effect";
import type { ProcessResult, ProcessRunnerService } from "@codexbar/core";
import type {
  ProviderBedrockAwsCredentials,
  ProviderBedrockAwsProfileEnvironment,
} from "@codexbar/providers";

export const NODE_BEDROCK_AWS_CLI_TIMEOUT_MS = 20_000;
export const NODE_BEDROCK_AWS_CLI_MAXIMUM_OUTPUT_BYTES = 1024 * 1024;

export type NodeBedrockAwsErrorCode =
  | "api-error"
  | "cancelled"
  | "cli-not-found"
  | "invalid-profile"
  | "output-too-large"
  | "parse-failed"
  | "sso-expired";

export class NodeBedrockAwsError extends Error {
  readonly code: NodeBedrockAwsErrorCode;

  constructor(code: NodeBedrockAwsErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "NodeBedrockAwsError";
  }
}

const decoder = new TextDecoder("utf-8", { fatal: true });
const lossyDecoder = new TextDecoder("utf-8");

export const nodeBedrockAwsWellKnownPaths = (
  home: string,
  platform: NodeJS.Platform = process.platform,
): readonly string[] =>
  platform === "win32"
    ? [
        "C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe",
        "C:\\Program Files (x86)\\Amazon\\AWSCLIV2\\aws.exe",
        win32.join(home, "AppData", "Local", "Programs", "AWS CLI", "aws.exe"),
      ]
    : [
        "/opt/homebrew/bin/aws",
        "/usr/local/bin/aws",
        "/usr/bin/aws",
        join(home, ".local", "bin", "aws"),
      ];

const maximumPathEntries = 128;

/**
 * Resolves only absolute PATH entries to deterministic AWS CLI candidates.
 * This avoids shell/PATH lookup while still supporting ordinary package-manager
 * installations such as `/usr/bin/aws` and Windows' user-local CLI location.
 */
export const nodeBedrockAwsPathCandidates = (
  path: string | undefined,
  platform: NodeJS.Platform = process.platform,
): readonly string[] => {
  if (path === undefined || path.length > 32_768 || path.includes("\u0000")) return [];
  const separator = platform === "win32" ? ";" : ":";
  const paths = platform === "win32" ? win32 : { isAbsolute, join };
  const executable = platform === "win32" ? "aws.exe" : "aws";
  const candidates: string[] = [];
  for (const raw of path.split(separator)) {
    if (candidates.length >= maximumPathEntries) break;
    const directory = raw.trim();
    if (
      directory === "" ||
      directory.length > 4_096 ||
      /[\r\n]/u.test(directory) ||
      !paths.isAbsolute(directory)
    )
      continue;
    candidates.push(paths.join(directory, executable));
  }
  return candidates;
};

export const isNodeBedrockAwsCliPath = (value: string): boolean =>
  value.trim() === value &&
  value.length > 0 &&
  value.length <= 4_096 &&
  !value.includes("\u0000") &&
  !/[\r\n]/u.test(value) &&
  (isAbsolute(value) || win32.isAbsolute(value));

const hasControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });

export const isNodeBedrockAwsProfileName = (value: string): boolean => {
  const profile = value.trim();
  return (
    profile === value &&
    profile.length >= 1 &&
    profile.length <= 256 &&
    !profile.startsWith("-") &&
    !hasControlCharacter(profile)
  );
};

const existsExecutable = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

export const resolveNodeBedrockAwsCliPath = async (options: {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory: string;
  readonly platform?: NodeJS.Platform;
  readonly exists?: (path: string) => Promise<boolean>;
}): Promise<string | undefined> => {
  const exists = options.exists ?? existsExecutable;
  const configured = options.environment.AWS_CLI_PATH?.trim();
  if (configured !== undefined && configured !== "") {
    if (!isNodeBedrockAwsCliPath(configured))
      throw new NodeBedrockAwsError("cli-not-found", "Configured AWS CLI path is invalid.");
    return (await exists(configured)) ? configured : undefined;
  }
  const candidates = [
    ...nodeBedrockAwsWellKnownPaths(options.homeDirectory, options.platform),
    ...nodeBedrockAwsPathCandidates(options.environment.PATH, options.platform),
  ];
  for (const candidate of new Set(candidates)) {
    if (await exists(candidate)) return candidate;
  }
  return undefined;
};

const nonEmpty = (raw: string | undefined): string | undefined => {
  const value = raw?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
};

const decodeBounded = (
  value: Uint8Array,
  code: NodeBedrockAwsErrorCode,
  message: string,
): string => {
  if (value.byteLength > NODE_BEDROCK_AWS_CLI_MAXIMUM_OUTPUT_BYTES)
    throw new NodeBedrockAwsError("output-too-large", "AWS CLI output exceeded 1 MiB.");
  try {
    return decoder.decode(value);
  } catch {
    throw new NodeBedrockAwsError(code, message);
  }
};

const decodeStderr = (value: Uint8Array): string => {
  if (value.byteLength > NODE_BEDROCK_AWS_CLI_MAXIMUM_OUTPUT_BYTES) return "";
  try {
    return lossyDecoder.decode(value);
  } catch {
    return "";
  }
};

const looksLikeSecret = (value: string): boolean =>
  /(?:AKIA|ASIA)[A-Z0-9]{16}|SecretAccessKey|SessionToken|aws_secret_access_key|aws_session_token/iu.test(
    value,
  );

export const classifyBedrockAwsExportError = (
  stderr: string,
  profile: string,
): NodeBedrockAwsError => {
  const lower = stderr.toLowerCase();
  if (
    lower.includes("sso login") ||
    lower.includes("expired") ||
    lower.includes("token has expired")
  ) {
    return new NodeBedrockAwsError(
      "sso-expired",
      `AWS profile session expired. Run \`aws sso login --profile ${profile}\` and try again.`,
    );
  }
  const trimmed = stderr.trim();
  if (trimmed.length === 0 || looksLikeSecret(trimmed)) {
    return new NodeBedrockAwsError("api-error", "AWS CLI failed to export credentials");
  }
  // Bound diagnostic text so the provider failure channel cannot carry a large
  // command transcript. Its contents are redacted again by the runtime.
  return new NodeBedrockAwsError("api-error", trimmed.slice(0, 4_096));
};

export const parseBedrockAwsExportCredentials = (stdout: string): ProviderBedrockAwsCredentials => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    throw new NodeBedrockAwsError(
      "parse-failed",
      "Could not parse AWS CLI export-credentials output",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new NodeBedrockAwsError(
      "parse-failed",
      "Could not parse AWS CLI export-credentials output",
    );
  }
  const record = parsed as Record<string, unknown>;
  const accessKeyId = nonEmpty(
    typeof record.AccessKeyId === "string" ? record.AccessKeyId : undefined,
  );
  const secretAccessKey = nonEmpty(
    typeof record.SecretAccessKey === "string" ? record.SecretAccessKey : undefined,
  );
  if (accessKeyId === undefined || secretAccessKey === undefined) {
    throw new NodeBedrockAwsError(
      "parse-failed",
      "Could not parse AWS CLI export-credentials output",
    );
  }
  const sessionToken = nonEmpty(
    typeof record.SessionToken === "string" ? record.SessionToken : undefined,
  );
  return {
    accessKeyId,
    secretAccessKey,
    ...(sessionToken === undefined ? {} : { sessionToken }),
  };
};

export const parseBedrockAwsProfileRegion = (stdout: string): string | undefined =>
  nonEmpty(stdout);

const abortError = (): NodeBedrockAwsError =>
  new NodeBedrockAwsError("cancelled", "AWS CLI credential export was cancelled.");

const asAbort = (error: unknown): boolean =>
  (error instanceof NodeBedrockAwsError && error.code === "cancelled") ||
  (error instanceof Error &&
    (error.name === "AbortError" ||
      error.name === "CanceledError" ||
      /cancel/iu.test(error.message))) ||
  (typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    error.name === "AbortError");

const runCli = async (
  processRunner: ProcessRunnerService,
  command: string,
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  signal: AbortSignal,
): Promise<ProcessResult> => {
  if (signal.aborted) throw abortError();
  try {
    return await Effect.runPromise(
      processRunner.run({
        command,
        args,
        inheritEnvironment: false,
        env: Object.fromEntries(
          Object.entries(environment).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
        timeoutMs: NODE_BEDROCK_AWS_CLI_TIMEOUT_MS,
      }),
      { signal },
    );
  } catch (error) {
    if (asAbort(error) || signal.aborted) throw abortError();
    throw error;
  }
};

export interface NodeBedrockAwsCredentialsOptions {
  readonly profile: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly sourceEnvironment?: ProviderBedrockAwsProfileEnvironment;
  readonly processRunner: ProcessRunnerService;
  readonly homeDirectory?: string;
  readonly platform?: NodeJS.Platform;
  readonly signal: AbortSignal;
  readonly exists?: (path: string) => Promise<boolean>;
}

/**
 * Runs only fixed AWS CLI credential-export and profile-region commands. The
 * caller receives credentials, never a process handle or raw command surface.
 */
export const runNodeBedrockAwsCredentials = async (
  options: NodeBedrockAwsCredentialsOptions,
): Promise<ProviderBedrockAwsCredentials> => {
  if (options.signal.aborted) throw abortError();
  if (!isNodeBedrockAwsProfileName(options.profile)) {
    throw new NodeBedrockAwsError("invalid-profile", "AWS profile name is invalid.");
  }
  const environment = nodeBedrockAwsEnvironment(options.environment, options.sourceEnvironment);
  const command = await resolveNodeBedrockAwsCliPath({
    environment,
    homeDirectory: options.homeDirectory ?? homedir(),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.exists === undefined ? {} : { exists: options.exists }),
  });
  if (command === undefined) {
    throw new NodeBedrockAwsError(
      "cli-not-found",
      "AWS CLI not found. Install the AWS CLI (v2) or set AWS_CLI_PATH to its location.",
    );
  }
  const exported = await runCli(
    options.processRunner,
    command,
    ["configure", "export-credentials", "--profile", options.profile, "--format", "process"],
    environment,
    options.signal,
  );
  if (exported.exitCode !== 0) {
    throw classifyBedrockAwsExportError(decodeStderr(exported.stderr), options.profile);
  }
  const credentials = parseBedrockAwsExportCredentials(
    decodeBounded(
      exported.stdout,
      "parse-failed",
      "Could not parse AWS CLI export-credentials output",
    ),
  );
  let region: string | undefined;
  try {
    const regionResult = await runCli(
      options.processRunner,
      command,
      ["configure", "get", "region", "--profile", options.profile],
      environment,
      options.signal,
    );
    if (regionResult.exitCode === 0) {
      region = parseBedrockAwsProfileRegion(
        decodeBounded(regionResult.stdout, "parse-failed", "Could not parse AWS CLI region output"),
      );
    }
  } catch (error) {
    if (asAbort(error) || options.signal.aborted) throw abortError();
  }
  return region === undefined ? credentials : { ...credentials, region };
};

/**
 * Swift's `profileCLIEnvironment` removes only AWS_PROFILE. Static credentials
 * and region values must remain available for profiles that use an assume-role
 * `credential_source = Environment` chain.
 */
export const nodeBedrockAwsEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
  source?: ProviderBedrockAwsProfileEnvironment,
): Readonly<Record<string, string | undefined>> => ({
  ...Object.fromEntries(Object.entries(environment).filter(([key]) => key !== "AWS_PROFILE")),
  ...(source?.accessKeyId === undefined ? {} : { AWS_ACCESS_KEY_ID: source.accessKeyId }),
  ...(source?.secretAccessKey === undefined
    ? {}
    : { AWS_SECRET_ACCESS_KEY: source.secretAccessKey }),
  ...(source?.sessionToken === undefined ? {} : { AWS_SESSION_TOKEN: source.sessionToken }),
  ...(source?.region === undefined ? {} : { AWS_REGION: source.region }),
  ...(source?.defaultRegion === undefined ? {} : { AWS_DEFAULT_REGION: source.defaultRegion }),
});
