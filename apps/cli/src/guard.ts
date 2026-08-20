import type { ProviderFetchOutcome } from "@codexbar/core";
import type { ProviderId, RateWindow } from "@codexbar/contracts";
import {
  CLIExitCode,
  type CLICommandResult,
  type CLIIO,
  type CLIProviderRuntime,
} from "./runner.ts";

export type GuardWindow = "session" | "weekly";
export type GuardDecision = "ok" | "blocked" | "unknown";

export interface GuardResult {
  readonly provider: string;
  readonly window: GuardWindow;
  readonly remainingPercent: number | null;
  readonly minimumRemainingPercent: number;
  readonly decision: GuardDecision;
  readonly exitCode: number;
  readonly unavailableReason: "fetch-failed" | "timeout" | "window-unavailable" | null;
}

const windowFor = (
  snapshot: ProviderFetchOutcome["snapshot"],
  window: GuardWindow,
): RateWindow | undefined => (window === "session" ? snapshot.primary : snapshot.secondary);

export const evaluateGuard = (
  outcome:
    | { readonly remainingPercent: number }
    | { readonly unavailableReason: GuardResult["unavailableReason"] },
  minimumRemainingPercent: number,
  failOpen: boolean,
): GuardResult["decision"] extends never
  ? never
  : Pick<GuardResult, "decision" | "exitCode" | "remainingPercent" | "unavailableReason"> => {
  if ("unavailableReason" in outcome) {
    return {
      decision: "unknown",
      exitCode: failOpen ? CLIExitCode.success : CLIExitCode.unavailable,
      remainingPercent: null,
      unavailableReason: outcome.unavailableReason,
    };
  }
  if (outcome.remainingPercent >= minimumRemainingPercent) {
    return {
      decision: "ok",
      exitCode: 0,
      remainingPercent: outcome.remainingPercent,
      unavailableReason: null,
    };
  }
  return {
    decision: "blocked",
    exitCode: 1,
    remainingPercent: outcome.remainingPercent,
    unavailableReason: null,
  };
};

const parseNumber = (
  value: string | undefined,
  name: string,
  min: number,
  max: number,
): number | string => {
  if (value === undefined) return `${name} requires a value`;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max
    ? parsed
    : `${name} must be a finite number from ${min} through ${max}`;
};

type ParsedGuard = {
  readonly provider: string | undefined;
  readonly window: GuardWindow;
  readonly minRemaining: number;
  readonly timeoutSeconds: number;
  readonly failOpen: boolean;
  readonly verbose: boolean;
  readonly json: boolean;
  readonly pretty: boolean;
};

const parseGuard = (args: readonly string[]): ParsedGuard | string => {
  let provider: string | undefined;
  let window: GuardWindow = "session";
  let minRemaining = 10;
  let timeoutSeconds = 60;
  let failOpen = false;
  let verbose = false;
  let json = false;
  let pretty = false;
  const seen = new Set<string>();
  const value = (index: number): string | undefined => args[index + 1];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    const [name, inline] = arg.split("=", 2);
    if (
      name === "--provider" ||
      name === "--window" ||
      name === "--min-remaining" ||
      name === "--timeout" ||
      name === "--log-level"
    ) {
      if (seen.has(name)) return `Option ${name} may only be specified once`;
      seen.add(name);
      const raw = inline ?? value(index);
      if (inline === undefined) index += 1;
      if (name === "--provider") {
        if (raw === undefined || raw === "" || raw.startsWith("-"))
          return "--provider requires a value";
        provider = raw;
      } else if (name === "--window") {
        if (raw !== "session" && raw !== "weekly") return "--window must be session|weekly";
        window = raw;
      } else if (name === "--min-remaining") {
        const parsed = parseNumber(raw, "--min-remaining", 0, 100);
        if (typeof parsed === "string") return parsed;
        minRemaining = parsed;
      } else if (name === "--timeout") {
        const parsed = parseNumber(raw, "--timeout", 0, 86400);
        if (typeof parsed === "string") return parsed;
        timeoutSeconds = parsed;
      }
      continue;
    }
    if (name === "--verbose" || name === "-v") {
      if (verbose) return "Option --verbose may only be specified once";
      verbose = true;
      continue;
    }
    if (name === "--json" || name === "--json-output") {
      if (json) return "Option --json may only be specified once";
      json = true;
      continue;
    }
    if (name === "--pretty") {
      if (pretty) return "Option --pretty may only be specified once";
      pretty = true;
      continue;
    }
    if (name === "--fail-open") {
      if (failOpen) return "Option --fail-open may only be specified once";
      failOpen = true;
      continue;
    }
    return `Unknown option ${arg}`;
  }
  return { provider, window, minRemaining, timeoutSeconds, failOpen, verbose, json, pretty };
};

const providerWindow = (outcome: ProviderFetchOutcome, window: GuardWindow): number | undefined => {
  const selected = windowFor(outcome.snapshot, window);
  if (selected === undefined || selected.isSyntheticPlaceholder === true) return undefined;
  const remaining = 100 - selected.usedPercent;
  return Number.isFinite(remaining) ? remaining : undefined;
};

const fetchWithDeadline = async (
  runtime: CLIProviderRuntime,
  provider: ProviderId,
  timeoutSeconds: number,
): Promise<{
  readonly outcome?: ProviderFetchOutcome;
  readonly reason?: "fetch-failed" | "timeout";
}> => {
  const controller = new AbortController();
  const request = runtime.fetch(
    provider,
    { sourceMode: "auto", includeCredits: false },
    controller.signal,
  );
  if (timeoutSeconds === 0) {
    try {
      return { outcome: await request };
    } catch {
      return { reason: "fetch-failed" };
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request.then((outcome) => ({ outcome })).catch(() => ({ reason: "fetch-failed" as const })),
      new Promise<{ readonly reason: "timeout" }>((resolve) => {
        timer = setTimeout(() => {
          controller.abort(new Error("guard timeout"));
          resolve({ reason: "timeout" });
        }, timeoutSeconds * 1000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const percent = (value: number): string => {
  const rounded = Math.round(value);
  return Math.abs(value - rounded) < 0.05 ? `${rounded}%` : `${value.toFixed(1)}%`;
};

export const runGuard = async (
  args: readonly string[],
  io: CLIIO,
  runtime: CLIProviderRuntime,
): Promise<CLICommandResult> => {
  const parsed = parseGuard(args);
  if (typeof parsed === "string") {
    io.stderr(`Error: ${parsed}`);
    return { exitCode: 64 as CLIExitCode };
  }
  if (parsed.provider === undefined) {
    io.stderr("Error: guard requires --provider <id>.");
    return { exitCode: 64 as CLIExitCode };
  }
  const descriptor = runtime.providers.find(
    (candidate) => candidate.id === parsed.provider!.toLowerCase(),
  );
  if (descriptor === undefined) {
    io.stderr(`Error: unknown provider '${parsed.provider}'.`);
    return { exitCode: 64 as CLIExitCode };
  }
  const fetched = await fetchWithDeadline(runtime, descriptor.id, parsed.timeoutSeconds);
  let evaluation: Pick<
    GuardResult,
    "decision" | "exitCode" | "remainingPercent" | "unavailableReason"
  >;
  if (fetched.outcome === undefined) {
    evaluation = evaluateGuard(
      { unavailableReason: fetched.reason ?? "fetch-failed" },
      parsed.minRemaining,
      parsed.failOpen,
    );
  } else {
    const remaining = providerWindow(fetched.outcome, parsed.window);
    evaluation =
      remaining === undefined
        ? evaluateGuard(
            { unavailableReason: "window-unavailable" },
            parsed.minRemaining,
            parsed.failOpen,
          )
        : evaluateGuard({ remainingPercent: remaining }, parsed.minRemaining, parsed.failOpen);
  }
  const payload: GuardResult = {
    provider: descriptor.id,
    window: parsed.window,
    minimumRemainingPercent: parsed.minRemaining,
    ...evaluation,
  };
  if (parsed.json) io.stdout(JSON.stringify(payload, undefined, parsed.pretty ? 2 : undefined));
  else {
    const remaining =
      payload.remainingPercent === null
        ? "unknown"
        : `${percent(payload.remainingPercent)} remaining`;
    const reason = payload.unavailableReason === null ? "" : `; ${payload.unavailableReason}`;
    io.stdout(
      `${payload.provider} ${payload.window}: ${remaining} — ${payload.decision.toUpperCase()} (minimum ${percent(payload.minimumRemainingPercent)}${reason})`,
    );
  }
  return { exitCode: payload.exitCode as CLIExitCode };
};
