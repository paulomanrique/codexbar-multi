import type { ProviderId } from "@codexbar/contracts";
import type { CLICommandResult, CLIExitCode, CLIIO, CLIProviderRuntime } from "./runner.ts";

export type CookieRefreshStatus = "refreshed" | "skipped" | "blocked" | "failed";

export interface CLICookieRefreshResult {
  readonly provider: string;
  readonly status: CookieRefreshStatus;
  readonly message: string;
}

/**
 * The CLI deliberately does not know how a browser or credential store works.
 * Desktop supplies this adapter; headless hosts may omit it and fail closed.
 */
export interface CLICookieStore {
  readonly refreshableProviders: readonly ProviderId[];
  readonly refresh: (
    provider: ProviderId,
    options: { readonly allowKeychainPrompt: boolean },
  ) => Promise<CLICookieRefreshResult>;
}

type CookieRuntime = CLIProviderRuntime & { readonly cookies?: CLICookieStore };
type CookieFormat = "text" | "json";
type ParsedCookieArguments = {
  readonly all: boolean;
  readonly provider?: string;
  readonly allowKeychainPrompt: boolean;
  readonly format: CookieFormat;
  readonly pretty: boolean;
};
type ParseResult =
  | { readonly ok: true; readonly value: ParsedCookieArguments }
  | { readonly ok: false; readonly message: string };

const parseCookieArguments = (arguments_: readonly string[]): ParseResult => {
  let all = false;
  let provider: string | undefined;
  let allowKeychainPrompt = false;
  let format: CookieFormat = "text";
  let pretty = false;
  const positional: string[] = [];
  const seen = new Set<string>();
  const duplicate = (name: string): ParseResult => ({
    ok: false,
    message: `Option ${name} may only be specified once`,
  });
  const missing = (name: string): ParseResult => ({
    ok: false,
    message: `Missing value for ${name}`,
  });

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === undefined) continue;
    if (!argument.startsWith("-")) {
      positional.push(argument);
      continue;
    }
    if (argument === "--all" || argument === "--allow-keychain-prompt") {
      if (seen.has(argument)) return duplicate(argument);
      seen.add(argument);
      if (argument === "--all") all = true;
      else allowKeychainPrompt = true;
      continue;
    }
    if (argument === "--json" || argument === "--json-only") {
      if (seen.has("--format")) return duplicate(argument);
      seen.add("--format");
      format = "json";
      continue;
    }
    if (argument === "--pretty") {
      if (pretty) return duplicate("--pretty");
      pretty = true;
      continue;
    }
    const option = ["--provider", "--format"].find(
      (name) => argument === name || argument.startsWith(`${name}=`),
    );
    if (option === undefined) return { ok: false, message: `Unknown option ${argument}` };
    if (seen.has(option)) return duplicate(option);
    seen.add(option);
    const value = argument === option ? arguments_[index + 1] : argument.slice(option.length + 1);
    if (value === undefined || value === "" || value.startsWith("-")) return missing(option);
    if (argument === option) index += 1;
    if (option === "--provider") provider = value;
    else {
      const normalized = value.toLowerCase();
      if (normalized !== "text" && normalized !== "json")
        return { ok: false, message: "Invalid value for --format (expected text or json)" };
      format = normalized;
    }
  }
  if (positional.length > 1 || (positional.length === 1 && positional[0] !== "refresh"))
    return { ok: false, message: "cookie accepts only the refresh action" };
  if ((provider === undefined) === !all)
    return { ok: false, message: "Specify exactly one of --provider <name> or --all" };
  if (all && provider !== undefined)
    return { ok: false, message: "Specify exactly one of --provider <name> or --all" };
  return {
    ok: true,
    value: {
      all,
      ...(provider === undefined ? {} : { provider }),
      allowKeychainPrompt,
      format,
      pretty,
    },
  };
};

const boundedMessage = (message: string): string => {
  const normalized = message.replace(/[\r\n\t]+/g, " ").trim();
  return normalized.length > 512 ? `${normalized.slice(0, 509)}...` : normalized;
};

const emitError = (io: CLIIO, format: CookieFormat, message: string, pretty: boolean): void => {
  const safe = boundedMessage(message);
  if (format === "json")
    io.stdout(
      JSON.stringify({ cookie: "refresh", error: safe }, undefined, pretty ? 2 : undefined),
    );
  else io.stderr(`Error: ${safe}`);
};

export const runCookie = async (
  arguments_: readonly string[],
  io: CLIIO,
  runtime: CookieRuntime,
): Promise<CLICommandResult> => {
  const parsed = parseCookieArguments(arguments_);
  const jsonHint = arguments_.some(
    (argument) =>
      argument === "--json" || argument === "--json-only" || argument === "--format=json",
  );
  if (!parsed.ok) {
    emitError(io, jsonHint ? "json" : "text", parsed.message, false);
    return { exitCode: 64 };
  }
  const { value } = parsed;
  if (runtime.cookies === undefined) {
    emitError(io, value.format, "Cookie refresh adapter is unavailable on this host", value.pretty);
    return { exitCode: 69 };
  }
  const requested = value.all
    ? runtime.cookies.refreshableProviders
    : [
        runtime.providers.find((candidate) => candidate.id === value.provider?.toLowerCase())?.id,
      ].filter((id): id is ProviderId => id !== undefined);
  if (requested.length === 0) {
    emitError(
      io,
      value.format,
      `Unknown or unsupported provider: ${value.provider ?? ""}`,
      value.pretty,
    );
    return { exitCode: 1 };
  }
  const supported = new Set(runtime.cookies.refreshableProviders);
  if (requested.some((provider) => !supported.has(provider))) {
    emitError(
      io,
      value.format,
      `Provider does not support browser cookie refresh: ${value.provider ?? ""}`,
      value.pretty,
    );
    return { exitCode: 1 };
  }
  const rows: CLICookieRefreshResult[] = [];
  for (const provider of requested) {
    try {
      const result = await runtime.cookies.refresh(provider, {
        allowKeychainPrompt: value.allowKeychainPrompt,
      });
      if (result.provider !== provider) throw new Error("cookie refresh provider mismatch");
      rows.push({ ...result, message: boundedMessage(result.message) });
    } catch {
      rows.push({ provider, status: "failed", message: "Browser cookie refresh failed" });
    }
  }
  const hasErrors = rows.some((row) => row.status === "blocked" || row.status === "failed");
  if (value.format === "json")
    io.stdout(JSON.stringify(rows, undefined, value.pretty ? 2 : undefined));
  else {
    const marker: Record<CookieRefreshStatus, string> = {
      refreshed: "✅",
      skipped: "↷",
      blocked: "⚠️",
      failed: "❌",
    };
    io.stdout(
      rows.map((row) => `${row.provider}: ${marker[row.status]} ${row.message}`).join("\n"),
    );
  }
  return { exitCode: (hasErrors ? 1 : 0) as CLIExitCode };
};

export { parseCookieArguments };
