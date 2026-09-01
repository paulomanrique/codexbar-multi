import { fetchAttemptsFromFailure, type ProviderFetchAttempt } from "@codexbar/core";
import type { UsageSnapshot } from "@codexbar/contracts";
import type { CLICommandResult, CLIExitCode, CLIIO, CLIProviderRuntime } from "./runner.ts";

type ParsedDiagnose = {
  readonly provider?: string;
  readonly pretty: boolean;
  readonly traceFetch: boolean;
  readonly output?: string;
};
type ParseResult =
  | { readonly ok: true; readonly value: ParsedDiagnose }
  | { readonly ok: false; readonly message: string };

const parseDiagnoseArguments = (arguments_: readonly string[]): ParseResult => {
  let provider: string | undefined;
  let pretty = false;
  let traceFetch = false;
  let output: string | undefined;
  const positional: string[] = [];
  const seen = new Set<string>();
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
    if (argument === "--pretty" || argument === "--redact" || argument === "--trace-fetch") {
      if (seen.has(argument))
        return { ok: false, message: `Option ${argument} may only be specified once` };
      seen.add(argument);
      if (argument === "--pretty") pretty = true;
      else if (argument === "--trace-fetch") traceFetch = true;
      continue;
    }
    const option = ["--provider", "--output", "--format"].find(
      (name) => argument === name || argument.startsWith(`${name}=`),
    );
    if (option === undefined) return { ok: false, message: `Unknown option ${argument}` };
    if (seen.has(option))
      return { ok: false, message: `Option ${option} may only be specified once` };
    seen.add(option);
    const value = argument === option ? arguments_[index + 1] : argument.slice(option.length + 1);
    if (value === undefined || value === "" || value.startsWith("-")) return missing(option);
    if (argument === option) index += 1;
    if (option === "--provider") provider = value;
    else if (option === "--output") output = value;
    else if (value.toLowerCase() !== "json")
      return { ok: false, message: "only JSON format is supported for diagnose" };
  }
  if (positional.length > 0)
    return { ok: false, message: "diagnose does not accept positional arguments" };
  return {
    ok: true,
    value: {
      ...(provider === undefined ? {} : { provider }),
      pretty,
      traceFetch,
      ...(output === undefined ? {} : { output }),
    },
  };
};

const diagnosticSources = new Set([
  "cli",
  "web",
  "oauth",
  "api-token",
  "local-probe",
  "web-dashboard",
]);
const diagnosticFailureKinds = new Set([
  "authentication-expired",
  "missing-credential",
  "permission-denied",
  "rate-limited",
  "provider-unavailable",
  "parse-failure",
  "network-failure",
  "api-failure",
]);

const safeProperty = (value: unknown, property: string): unknown => {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    return (value as Record<string, unknown>)[property];
  } catch {
    return undefined;
  }
};

const diagnosticSource = (value: unknown): string =>
  typeof value === "string" && diagnosticSources.has(value) ? value : "unknown";

const diagnosticFailureKind = (error: unknown): string => {
  const direct = safeProperty(error, "kind");
  if (typeof direct === "string" && diagnosticFailureKinds.has(direct)) return direct;
  const classified = safeProperty(error, "classified");
  const nested = safeProperty(classified, "kind");
  if (typeof nested === "string" && diagnosticFailureKinds.has(nested)) return nested;
  return safeProperty(error, "name") === "NoAvailableStrategy" ? "provider-unavailable" : "unknown";
};

const diagnosticAttempt = (
  attempt: ProviderFetchAttempt,
  order: number,
  terminalFailure: boolean,
) => {
  const source = diagnosticSource(safeProperty(attempt, "source"));
  const available = safeProperty(attempt, "available") === true;
  const error = safeProperty(attempt, "error");
  if (!available) return { order, source, outcome: "skipped" as const };
  if (error !== undefined)
    return {
      order,
      source,
      outcome: "failed" as const,
      failureKind: diagnosticFailureKind(error),
      fallback: terminalFailure ? ("stopped" as const) : ("continued" as const),
    };
  return { order, source, outcome: "selected" as const };
};

const maximumDiagnosticAttempts = 16;

const diagnosticFetchTrace = (
  rawAttempts: unknown,
  terminalFailure = false,
  incomplete = false,
) => {
  const attempts = Array.isArray(rawAttempts) ? rawAttempts : [];
  const lastFailedIndex = terminalFailure
    ? attempts.findLastIndex(
        (attempt) =>
          safeProperty(attempt, "available") === true &&
          safeProperty(attempt, "error") !== undefined,
      )
    : -1;
  return {
    schemaVersion: 1,
    attempts: attempts
      .slice(0, maximumDiagnosticAttempts)
      .map((attempt, index) => diagnosticAttempt(attempt, index + 1, index === lastFailedIndex)),
    ...(attempts.length > maximumDiagnosticAttempts ? { truncated: true as const } : {}),
    ...(incomplete ? { incomplete: true as const } : {}),
  };
};

const diagnosticUsage = (snapshot: UsageSnapshot) => {
  const windows = [
    ["primary", snapshot.primary],
    ["secondary", snapshot.secondary],
    ["tertiary", snapshot.tertiary],
    ...(snapshot.extraRateWindows ?? []).map(({ title, window }) => [title, window] as const),
  ] as const;
  return {
    updatedAt: snapshot.updatedAt,
    dataConfidence: snapshot.dataConfidence ?? "unknown",
    windows: windows.flatMap(([label, window]) =>
      window === undefined
        ? []
        : [
            {
              label,
              usedPercent: window.usedPercent,
              ...(window.windowMinutes === undefined
                ? {}
                : { windowMinutes: window.windowMinutes }),
              ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
              hasResetDescription: window.resetDescription !== undefined,
              ...(window.nextRegenPercent === undefined
                ? {}
                : { nextRegenPercent: window.nextRegenPercent }),
            },
          ],
    ),
    extraWindowCount: snapshot.extraRateWindows?.length ?? 0,
    providerCostPresent: snapshot.providerCost !== undefined,
    detailSectionCount: snapshot.details.length,
  };
};

const writeOutput = async (path: string, json: string): Promise<void> => {
  const fs = await import("node:fs/promises");
  const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  await fs.writeFile(temporary, `${json}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    await fs.rename(temporary, path);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
};

const isAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

export const runDiagnose = async (
  arguments_: readonly string[],
  io: CLIIO,
  runtime: CLIProviderRuntime,
  signal?: AbortSignal,
): Promise<CLICommandResult> => {
  const parsed = parseDiagnoseArguments(arguments_);
  const jsonHint = arguments_.some(
    (argument) => argument === "--format=json" || argument === "--format" || argument === "--json",
  );
  if (!parsed.ok) {
    if (jsonHint)
      io.stdout(
        JSON.stringify({
          provider: "cli",
          error: { code: 64, message: parsed.message, kind: "args" },
        }),
      );
    else io.stderr(`Error: ${parsed.message}`);
    return { exitCode: 64 };
  }
  const selected = parsed.value.provider?.toLowerCase();
  const providers =
    selected === undefined || selected === "all"
      ? runtime.providers
      : runtime.providers.filter((provider) => provider.id === selected);
  if (selected !== undefined && selected !== "all" && providers.length === 0) {
    io.stdout(
      JSON.stringify({
        provider: "cli",
        error: { code: 64, message: `Unknown provider: ${parsed.value.provider}`, kind: "args" },
      }),
    );
    return { exitCode: 64 };
  }
  const diagnostics: Array<Record<string, unknown>> = [];
  let exitCode: CLIExitCode = 0;
  for (const provider of providers) {
    const base: Record<string, unknown> = {
      schemaVersion: 1,
      provider: provider.id,
      implementationStatus: provider.status,
      sourceMode: "auto",
      credentials: "host-managed",
    };
    if (isAborted(signal)) {
      diagnostics.push({
        ...base,
        result: "cancelled",
        error: { code: 1, kind: "runtime", message: "Provider fetch cancelled." },
        ...(parsed.value.traceFetch
          ? { fetchTrace: diagnosticFetchTrace(undefined, false, true) }
          : {}),
        checkedAt: new Date().toISOString(),
      });
      exitCode = 1;
      break;
    }
    if (provider.status !== "partial") {
      diagnostics.push({
        ...base,
        result: "unported",
        error: { code: 1, kind: "provider", message: "Provider is mapped but not ported yet" },
      });
      exitCode = 1;
      continue;
    }
    try {
      const outcome = await runtime.fetch(
        provider.id,
        {
          sourceMode: "auto",
          includeCredits: true,
        },
        signal,
      );
      diagnostics.push({
        ...base,
        source: diagnosticSource(safeProperty(outcome, "source")),
        ...(parsed.value.traceFetch
          ? { fetchTrace: diagnosticFetchTrace(safeProperty(outcome, "attempts")) }
          : {}),
        // Diagnostic exports intentionally describe only bounded usage shape.
        // Identity, cost amounts and provider detail values never leave here.
        usage: diagnosticUsage(outcome.snapshot),
        checkedAt: new Date().toISOString(),
      });
    } catch (error) {
      if (isAborted(signal)) {
        diagnostics.push({
          ...base,
          result: "cancelled",
          error: { code: 1, kind: "runtime", message: "Provider fetch cancelled." },
          ...(parsed.value.traceFetch
            ? { fetchTrace: diagnosticFetchTrace(undefined, false, true) }
            : {}),
          checkedAt: new Date().toISOString(),
        });
        exitCode = 1;
        break;
      }
      const failureKind = diagnosticFailureKind(error);
      const failureAttempts = fetchAttemptsFromFailure(error);
      diagnostics.push({
        ...base,
        result: "failed",
        error: {
          code: 1,
          kind: "provider",
          message: "Provider fetch failed; see failureKind.",
        },
        failureKind,
        ...(parsed.value.traceFetch
          ? {
              fetchTrace: diagnosticFetchTrace(
                failureAttempts,
                true,
                failureAttempts === undefined,
              ),
            }
          : {}),
        checkedAt: new Date().toISOString(),
      });
      exitCode = 1;
    }
  }
  const payload =
    diagnostics.length === 1
      ? diagnostics[0]
      : { schemaVersion: 1, timestamp: new Date().toISOString(), diagnostics };
  const json = JSON.stringify(payload, undefined, parsed.value.pretty ? 2 : undefined);
  try {
    if (parsed.value.output === undefined) io.stdout(json);
    else await writeOutput(parsed.value.output, json);
  } catch (error) {
    io.stderr(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return { exitCode: 1 };
  }
  return { exitCode };
};

export { parseDiagnoseArguments };
