import type { CostUsageRecord } from "@codexbar/core";
import type { ProviderId } from "@codexbar/contracts";
import { encodeToon, type ToonValue } from "./toon.ts";
import type { CLICommandResult, CLIExitCode, CLIIO, CLIProviderDescriptor } from "./runner.ts";

/** Cost records are injected so CLI tests never touch SQLite or a live account. */
export interface CLICostStore {
  readonly list: (
    providerId: ProviderId,
    since: number,
    limit?: number,
  ) => Promise<readonly CostUsageRecord[]>;
}

export interface CostCommandRuntime {
  readonly costs: CLICostStore;
  readonly providers: readonly CLIProviderDescriptor[];
  readonly now?: () => number;
}

type CostFormat = "text" | "json" | "toon" | "jsonl";
type CostGroupBy = "none" | "project" | "session";

interface CostOutput {
  readonly format: CostFormat;
  readonly jsonOnly: boolean;
  readonly pretty: boolean;
  readonly noColor: boolean;
}

interface ParsedCostArguments {
  readonly output: CostOutput;
  readonly provider?: string;
  readonly days: number;
  readonly groupBy: CostGroupBy;
  readonly refresh: boolean;
  readonly providerNativeOnly: boolean;
}

type ParseResult =
  | { readonly ok: true; readonly value: ParsedCostArguments }
  | { readonly ok: false; readonly message: string };

const supportedProviders = new Set<ProviderId>(["codex", "claude", "cursor"]);
const duplicate = (name: string): ParseResult => ({
  ok: false,
  message: `Option ${name} may only be specified once`,
});
const missing = (name: string): ParseResult => ({
  ok: false,
  message: `Missing value for ${name}`,
});

const parseCostArguments = (arguments_: readonly string[]): ParseResult => {
  let explicitFormat: CostFormat | undefined;
  let jsonShortcut = false;
  let jsonSeen = false;
  let jsonOnlySeen = false;
  let jsonOnly = false;
  let pretty = false;
  let noColor = false;
  let provider: string | undefined;
  let providerSeen = false;
  let days = 30;
  let daysSeen = false;
  let groupBy: CostGroupBy = "none";
  let groupBySeen = false;
  let refresh = false;
  let providerNativeOnly = false;
  const positional: string[] = [];

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === undefined) continue;
    if (!argument.startsWith("-")) {
      positional.push(argument);
      continue;
    }
    if (argument === "--json") {
      if (jsonSeen) return duplicate("--json");
      jsonSeen = true;
      jsonShortcut = true;
      continue;
    }
    if (argument === "--json-only") {
      if (jsonOnlySeen) return duplicate("--json-only");
      jsonOnlySeen = true;
      jsonOnly = true;
      jsonShortcut = true;
      continue;
    }
    if (argument === "--pretty") {
      if (pretty) return duplicate("--pretty");
      pretty = true;
      continue;
    }
    if (argument === "--no-color") {
      if (noColor) return duplicate("--no-color");
      noColor = true;
      continue;
    }
    if (argument === "--refresh") {
      if (refresh) return duplicate("--refresh");
      refresh = true;
      continue;
    }
    if (argument === "--provider-native-only") {
      if (providerNativeOnly) return duplicate("--provider-native-only");
      providerNativeOnly = true;
      continue;
    }
    if (argument === "--provider" || argument.startsWith("--provider=")) {
      if (providerSeen) return duplicate("--provider");
      providerSeen = true;
      const value =
        argument === "--provider" ? arguments_[index + 1] : argument.slice("--provider=".length);
      if (value === undefined || value.length === 0 || value.startsWith("-"))
        return missing("--provider");
      provider = value;
      if (argument === "--provider") index += 1;
      continue;
    }
    if (argument === "--days" || argument.startsWith("--days=")) {
      if (daysSeen) return duplicate("--days");
      daysSeen = true;
      const value =
        argument === "--days" ? arguments_[index + 1] : argument.slice("--days=".length);
      if (value === undefined || value.length === 0 || value.startsWith("-"))
        return missing("--days");
      if (!/^[0-9]+$/u.test(value))
        return { ok: false, message: "--days must be an integer from 1 to 365" };
      days = Number(value);
      if (!Number.isSafeInteger(days) || days < 1 || days > 365)
        return { ok: false, message: "--days must be an integer from 1 to 365" };
      if (argument === "--days") index += 1;
      continue;
    }
    if (argument === "--group-by" || argument.startsWith("--group-by=")) {
      if (groupBySeen) return duplicate("--group-by");
      groupBySeen = true;
      const value =
        argument === "--group-by" ? arguments_[index + 1] : argument.slice("--group-by=".length);
      if (value === undefined || value.length === 0 || value.startsWith("-"))
        return missing("--group-by");
      if (value !== "none" && value !== "project" && value !== "session")
        return { ok: false, message: "--group-by must be none, project, or session" };
      groupBy = value;
      if (argument === "--group-by") index += 1;
      continue;
    }
    if (argument === "--format" || argument.startsWith("--format=")) {
      if (explicitFormat !== undefined) return duplicate("--format");
      const value =
        argument === "--format" ? arguments_[index + 1] : argument.slice("--format=".length);
      if (value === undefined || value.length === 0 || value.startsWith("-"))
        return missing("--format");
      if (value !== "text" && value !== "json" && value !== "toon" && value !== "jsonl")
        return {
          ok: false,
          message: "Invalid value for --format (expected text, json, toon, or jsonl)",
        };
      explicitFormat = value;
      if (argument === "--format") index += 1;
      continue;
    }
    return { ok: false, message: `Unknown option ${argument}` };
  }

  if (positional.length > 1) return { ok: false, message: "cost accepts at most one provider" };
  if (provider !== undefined && positional[0] !== undefined)
    return {
      ok: false,
      message: "provider must be supplied either positionally or with --provider",
    };
  provider ??= positional[0];
  return {
    ok: true,
    value: {
      output: {
        format: jsonOnly ? "json" : (explicitFormat ?? (jsonShortcut ? "json" : "text")),
        jsonOnly,
        pretty,
        noColor,
      },
      ...(provider === undefined ? {} : { provider }),
      days,
      groupBy,
      refresh,
      providerNativeOnly,
    },
  };
};

type CostDailyEntry = {
  readonly date: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly totalCost: number;
};

type CostPayload = {
  readonly provider: string;
  readonly source: "local";
  readonly updatedAt?: string;
  readonly currencyCode: "USD";
  readonly sessionTokens: number;
  readonly sessionCostUSD: number;
  readonly historyDays: number;
  readonly last30DaysTokens: number;
  readonly last30DaysCostUSD: number;
  readonly daily: readonly CostDailyEntry[];
  readonly projects: readonly never[];
  readonly totals: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
    readonly totalCost: number;
    readonly provenance: "listPriceEstimate";
    readonly coverage: {
      readonly priced: number;
      readonly unpriced: 0;
      readonly unmetered: 0;
      readonly estimated: 0;
    };
  };
  readonly provenance: "listPriceEstimate";
  readonly coverage: {
    readonly priced: number;
    readonly unpriced: 0;
    readonly unmetered: 0;
    readonly estimated: 0;
  };
  readonly error?: { readonly code: number; readonly message: string; readonly kind: "provider" };
};

const dayKey = (timestamp: number): string => new Date(timestamp).toISOString().slice(0, 10);

const makePayload = (
  provider: ProviderId,
  records: readonly CostUsageRecord[],
  days: number,
  now: number,
): CostPayload => {
  const dailyMap = new Map<string, { input: number; output: number; cost: number }>();
  let inputTokens = 0;
  let outputTokens = 0;
  let totalCost = 0;
  for (const record of records) {
    inputTokens += record.inputTokens;
    outputTokens += record.outputTokens;
    totalCost += record.costUsd;
    const key = dayKey(record.recordedAt);
    const current = dailyMap.get(key) ?? { input: 0, output: 0, cost: 0 };
    current.input += record.inputTokens;
    current.output += record.outputTokens;
    current.cost += record.costUsd;
    dailyMap.set(key, current);
  }
  const daily = [...dailyMap.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, value]) => ({
      date,
      inputTokens: value.input,
      outputTokens: value.output,
      totalTokens: value.input + value.output,
      totalCost: value.cost,
    }));
  const today = dailyMap.get(dayKey(now)) ?? { input: 0, output: 0, cost: 0 };
  const coverage = {
    priced: records.length,
    unpriced: 0 as const,
    unmetered: 0 as const,
    estimated: 0 as const,
  };
  const totalTokens = inputTokens + outputTokens;
  const updatedAt = records.at(-1)?.recordedAt;
  return {
    provider,
    source: "local",
    ...(updatedAt === undefined ? {} : { updatedAt: new Date(updatedAt).toISOString() }),
    currencyCode: "USD",
    sessionTokens: today.input + today.output,
    sessionCostUSD: today.cost,
    historyDays: days,
    last30DaysTokens: totalTokens,
    last30DaysCostUSD: totalCost,
    daily,
    projects: [],
    totals: {
      inputTokens,
      outputTokens,
      totalTokens,
      totalCost,
      provenance: "listPriceEstimate",
      coverage,
    },
    provenance: "listPriceEstimate",
    coverage,
  };
};

const textMoney = (value: number): string => `$${value.toFixed(2)}`;
const textNumber = (value: number): string => value.toLocaleString("en-US");
const textPayload = (descriptor: CLIProviderDescriptor, payload: CostPayload): string =>
  [
    `${descriptor.name} Cost (API-rate estimate)`,
    `Today: ${textMoney(payload.sessionCostUSD)} · ${textNumber(payload.sessionTokens)} tokens`,
    `Last ${payload.historyDays} days: ${textMoney(payload.last30DaysCostUSD)} · ${textNumber(payload.last30DaysTokens)} tokens`,
    "Not a subscription bill or plan value · local usage × public API prices",
  ].join("\n");

const errorPayload = (provider: string, message: string) => ({
  provider,
  source: "local",
  error: { code: 1, message, kind: "provider" as const },
});

export const runCost = async (
  arguments_: readonly string[],
  io: CLIIO,
  runtime: CostCommandRuntime | undefined,
): Promise<CLICommandResult> => {
  const parsed = parseCostArguments(arguments_);
  if (!parsed.ok) {
    const asksForJSON = arguments_.some(
      (argument, index) =>
        argument === "--json" ||
        argument === "--json-only" ||
        argument === "--format=json" ||
        (argument === "--format" && arguments_[index + 1] === "json"),
    );
    if (asksForJSON) io.stdout(JSON.stringify([errorPayload("cli", parsed.message)]));
    else io.stderr(`Error: ${parsed.message}`);
    return { exitCode: 64 };
  }
  const { output, provider: selected, days, groupBy, refresh, providerNativeOnly } = parsed.value;
  if (runtime === undefined) {
    if (output.format === "text" && !output.jsonOnly) io.stderr("Error: Cost store is unavailable");
    else io.stdout(JSON.stringify([errorPayload("cli", "Cost store is unavailable")]));
    return { exitCode: 1 };
  }
  if (refresh || providerNativeOnly || groupBy !== "none") {
    const requested = refresh
      ? "--refresh"
      : providerNativeOnly
        ? "--provider-native-only"
        : `--group-by ${groupBy}`;
    const message = `${requested} requires the JSONL cost scanner, which is not available yet`;
    if (output.format === "text" && !output.jsonOnly) io.stderr(`Error: ${message}`);
    else io.stdout(JSON.stringify([errorPayload("cli", message)]));
    return { exitCode: 1 };
  }
  const candidates =
    selected === undefined || selected === "all"
      ? runtime.providers.filter((provider) => supportedProviders.has(provider.id))
      : runtime.providers.filter(
          (provider) =>
            provider.id === selected.toLowerCase() && supportedProviders.has(provider.id),
        );
  if (selected !== undefined && selected !== "all" && candidates.length === 0) {
    const message = supportedProviders.has(selected.toLowerCase() as ProviderId)
      ? `Unknown provider: ${selected}`
      : `cost is only supported for ${[...supportedProviders].join(", ")}`;
    if (output.format === "text" && !output.jsonOnly) io.stderr(`Error: ${message}`);
    else io.stdout(JSON.stringify([errorPayload("cli", message)]));
    return { exitCode: 1 };
  }
  if (candidates.length === 0) {
    const message = `cost is only supported for ${[...supportedProviders].join(", ")}`;
    if (output.format === "text" && !output.jsonOnly) io.stderr(`Error: ${message}`);
    else io.stdout(JSON.stringify([errorPayload("cli", message)]));
    return { exitCode: 1 };
  }

  // The repository stores epoch milliseconds, matching the shared desktop DTO.
  const now = runtime.now?.() ?? Date.now();
  const since = now - days * 86_400_000;
  const payloads: CostPayload[] = [];
  const sections: string[] = [];
  let exitCode: CLIExitCode = 0;
  for (const descriptor of candidates) {
    try {
      const records = await runtime.costs.list(descriptor.id, since);
      const payload = makePayload(descriptor.id, records, days, now);
      payloads.push(payload);
      if (output.format === "text" && !output.jsonOnly) {
        sections.push(textPayload(descriptor, payload));
      }
    } catch {
      exitCode = 1;
      payloads.push(errorPayload(descriptor.id, "Unable to read cost history") as CostPayload);
    }
  }
  if (output.format === "text") {
    if (sections.length > 0 && !output.jsonOnly) io.stdout(sections.join("\n\n"));
  } else if (output.format === "json") {
    io.stdout(JSON.stringify(payloads, undefined, output.pretty ? 2 : undefined));
  } else if (output.format === "jsonl") {
    for (const payload of payloads) io.stdout(JSON.stringify(payload));
  } else {
    io.stdout(encodeToon(payloads as unknown as ToonValue));
  }
  return { exitCode };
};

export const costProviderIDs = supportedProviders;
