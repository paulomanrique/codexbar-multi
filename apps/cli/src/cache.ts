import type { ProviderId } from "@codexbar/contracts";
import type { CLICommandResult, CLIExitCode, CLIIO, CLIProviderRuntime } from "./runner.ts";

export interface CLICacheClearResult {
  readonly cleared: number;
  readonly error?: string;
}

export interface CLICacheStore {
  readonly clearCookies: (provider?: ProviderId) => Promise<CLICacheClearResult>;
  readonly clearCost: () => Promise<CLICacheClearResult>;
}

type CacheRuntime = CLIProviderRuntime & { readonly cache?: CLICacheStore };

type CacheFormat = "text" | "json";
type ParsedCache = {
  readonly cookies: boolean;
  readonly cost: boolean;
  readonly provider?: string;
  readonly format: CacheFormat;
  readonly pretty: boolean;
};
type ParseResult =
  | { readonly ok: true; readonly value: ParsedCache }
  | { readonly ok: false; readonly message: string };

const parseCacheArguments = (arguments_: readonly string[]): ParseResult => {
  let cookies = false;
  let cost = false;
  let provider: string | undefined;
  let format: CacheFormat = "text";
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
    if (argument === "--cookies" || argument === "--cost" || argument === "--all") {
      if (seen.has(argument)) return duplicate(argument);
      seen.add(argument);
      if (argument === "--cookies" || argument === "--all") cookies = true;
      if (argument === "--cost" || argument === "--all") cost = true;
      continue;
    }
    if (argument === "--json" || argument === "--json-only") {
      if (seen.has("--format")) return duplicate(argument);
      seen.add("--format");
      format = "json";
      continue;
    }
    if (argument === "--pretty") {
      if (pretty) return duplicate(argument);
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
  if (positional.length > 1 || (positional.length === 1 && positional[0] !== "clear"))
    return { ok: false, message: "cache accepts only the clear action" };
  if (!cookies && !cost) return { ok: false, message: "Specify --cookies, --cost, or --all" };
  if (provider !== undefined && !cookies)
    return { ok: false, message: "--provider only scopes cookie caches" };
  return {
    ok: true,
    value: { cookies, cost, format, pretty, ...(provider === undefined ? {} : { provider }) },
  };
};

const resultPayload = (
  cache: string,
  provider: string | undefined,
  result: CLICacheClearResult,
) => ({
  cache,
  ...(provider === undefined ? {} : { provider }),
  cleared: result.cleared,
  ...(result.error === undefined ? {} : { error: result.error }),
});

export const runCache = async (
  arguments_: readonly string[],
  io: CLIIO,
  runtime: CacheRuntime,
): Promise<CLICommandResult> => {
  const parsed = parseCacheArguments(arguments_);
  const jsonHint = arguments_.some(
    (argument) =>
      argument === "--json" || argument === "--json-only" || argument === "--format=json",
  );
  if (!parsed.ok) {
    if (jsonHint) io.stdout(JSON.stringify({ cache: "cli", cleared: 0, error: parsed.message }));
    else io.stderr(`Error: ${parsed.message}`);
    return { exitCode: 64 };
  }
  if (runtime.cache === undefined) {
    const message = "Cache store is unavailable";
    if (parsed.value.format === "json")
      io.stdout(JSON.stringify({ cache: "cli", cleared: 0, error: message }));
    else io.stderr(`Error: ${message}`);
    return { exitCode: 1 };
  }
  const provider = parsed.value.provider?.toLowerCase();
  if (provider !== undefined && !runtime.providers.some((candidate) => candidate.id === provider)) {
    const message = `Unknown provider: ${parsed.value.provider}`;
    if (parsed.value.format === "json")
      io.stdout(JSON.stringify({ cache: "cli", cleared: 0, error: message }));
    else io.stderr(`Error: ${message}`);
    return { exitCode: 64 };
  }
  const rows: readonly ReturnType<typeof resultPayload>[] = [
    ...(parsed.value.cookies
      ? [
          resultPayload(
            "cookies",
            provider,
            await runtime.cache.clearCookies(provider as ProviderId | undefined),
          ),
        ]
      : []),
    ...(parsed.value.cost
      ? [resultPayload("cost", undefined, await runtime.cache.clearCost())]
      : []),
  ];
  const hasErrors = rows.some((row) => row.error !== undefined);
  if (parsed.value.format === "json")
    io.stdout(JSON.stringify(rows, undefined, parsed.value.pretty ? 2 : undefined));
  else
    io.stdout(
      rows
        .map((row) =>
          row.error === undefined
            ? `${row.cache}: ${row.cleared > 0 ? "cleared" : "nothing to clear"}${row.provider === undefined ? " (all providers)" : ` (${row.provider})`}`
            : `${row.cache}: failed to clear - ${row.error}`,
        )
        .join("\n"),
    );
  return { exitCode: (hasErrors ? 1 : 0) as CLIExitCode };
};

export { parseCacheArguments };
