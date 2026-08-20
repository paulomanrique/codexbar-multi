import {
  makeDefaultCodexBarConfig,
  type ProviderFetchContext,
  type ProviderFetchOutcome,
} from "@codexbar/core";
import type { ProviderId, RateWindow, UsageSnapshot } from "@codexbar/contracts";
import { serializeUsageSnapshot } from "@codexbar/contracts";
import type {
  CLICommandResult,
  CLIExitCode,
  CLIIO,
  CLIProviderDescriptor,
  CLIProviderRuntime,
} from "./runner.ts";

type CardFormat = "text" | "json";
type SourceMode = ProviderFetchContext["sourceMode"];

interface CardsOutput {
  readonly format: CardFormat;
  readonly jsonOnly: boolean;
  readonly pretty: boolean;
  readonly noColor: boolean;
  readonly brief: boolean;
}

interface CardsArguments {
  readonly output: CardsOutput;
  readonly provider?: string;
  readonly sourceMode: SourceMode;
  readonly account?: string;
  readonly accountIndex?: number;
  readonly allAccounts: boolean;
  readonly includeCredits: boolean;
  readonly includeStatus: boolean;
  readonly webTimeoutSeconds?: number;
}

type ParseResult =
  | { readonly ok: true; readonly value: CardsArguments }
  | { readonly ok: false; readonly message: string };

const duplicate = (name: string): ParseResult => ({
  ok: false,
  message: `Option ${name} may only be specified once`,
});
const missing = (name: string): ParseResult => ({
  ok: false,
  message: `Missing value for ${name}`,
});

const parseCardsArguments = (arguments_: readonly string[]): ParseResult => {
  let explicitFormat: CardFormat | undefined;
  let jsonShortcut = false;
  let jsonSeen = false;
  let jsonOnlySeen = false;
  let jsonOnly = false;
  let pretty = false;
  let noColor = false;
  let brief = false;
  let provider: string | undefined;
  let providerSeen = false;
  let sourceMode: SourceMode = "auto";
  let sourceSeen = false;
  let webSeen = false;
  let account: string | undefined;
  let accountSeen = false;
  let accountIndex: number | undefined;
  let accountIndexSeen = false;
  let allAccounts = false;
  let webTimeoutSeconds: number | undefined;
  let webTimeoutSeen = false;
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
    if (argument === "--brief") {
      if (brief) return duplicate("--brief");
      brief = true;
      continue;
    }
    if (argument === "--status" || argument === "--no-credits" || argument === "--json-output")
      continue;
    if (argument === "--web") {
      if (webSeen || sourceSeen) return duplicate("--web");
      webSeen = true;
      sourceMode = "web";
      continue;
    }
    if (argument === "--all-accounts") {
      if (allAccounts) return duplicate("--all-accounts");
      allAccounts = true;
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
    if (argument === "--account" || argument.startsWith("--account=")) {
      if (accountSeen) return duplicate("--account");
      accountSeen = true;
      const value =
        argument === "--account" ? arguments_[index + 1] : argument.slice("--account=".length);
      if (value === undefined || value.length === 0 || value.startsWith("-"))
        return missing("--account");
      account = value;
      if (argument === "--account") index += 1;
      continue;
    }
    if (argument === "--account-index" || argument.startsWith("--account-index=")) {
      if (accountIndexSeen) return duplicate("--account-index");
      accountIndexSeen = true;
      const value =
        argument === "--account-index"
          ? arguments_[index + 1]
          : argument.slice("--account-index=".length);
      if (value === undefined || !/^[1-9][0-9]*$/u.test(value))
        return { ok: false, message: "--account-index must be a positive integer" };
      accountIndex = Number(value);
      if (!Number.isSafeInteger(accountIndex))
        return { ok: false, message: "--account-index is too large" };
      if (argument === "--account-index") index += 1;
      continue;
    }
    if (argument === "--source" || argument.startsWith("--source=")) {
      if (sourceSeen) return duplicate("--source");
      sourceSeen = true;
      const value =
        argument === "--source" ? arguments_[index + 1] : argument.slice("--source=".length);
      if (value === undefined || value.length === 0 || value.startsWith("-"))
        return missing("--source");
      if (
        value !== "auto" &&
        value !== "web" &&
        value !== "cli" &&
        value !== "oauth" &&
        value !== "api"
      )
        return { ok: false, message: "--source must be auto|web|cli|oauth|api" };
      sourceMode = value;
      if (argument === "--source") index += 1;
      continue;
    }
    if (argument === "--format" || argument.startsWith("--format=")) {
      if (explicitFormat !== undefined) return duplicate("--format");
      const value =
        argument === "--format" ? arguments_[index + 1] : argument.slice("--format=".length);
      if (value === undefined || value.length === 0 || value.startsWith("-"))
        return missing("--format");
      if (value !== "text" && value !== "json")
        return { ok: false, message: "Invalid value for --format (expected text or json)" };
      explicitFormat = value;
      if (argument === "--format") index += 1;
      continue;
    }
    if (argument === "--web-timeout" || argument.startsWith("--web-timeout=")) {
      if (webTimeoutSeen) return duplicate("--web-timeout");
      webTimeoutSeen = true;
      const value =
        argument === "--web-timeout"
          ? arguments_[index + 1]
          : argument.slice("--web-timeout=".length);
      const parsed = value === undefined ? NaN : Number(value);
      if (!Number.isFinite(parsed) || parsed < 0)
        return { ok: false, message: "--web-timeout must be a finite, nonnegative number" };
      webTimeoutSeconds = parsed;
      if (argument === "--web-timeout") index += 1;
      continue;
    }
    if (
      argument === "--verbose" ||
      argument === "-v" ||
      argument === "--log-level" ||
      argument === "--web-debug-dump-html" ||
      argument === "--antigravity-plan-debug" ||
      argument === "--augment-debug"
    ) {
      if (argument === "--log-level") {
        if (arguments_[index + 1] === undefined) return missing("--log-level");
        index += 1;
      }
      continue;
    }
    return { ok: false, message: `Unknown option ${argument}` };
  }

  if (positional.length > 1) return { ok: false, message: "cards accepts at most one provider" };
  if (provider !== undefined && positional[0] !== undefined)
    return {
      ok: false,
      message: "provider must be supplied either positionally or with --provider",
    };
  provider ??= positional[0];
  if (allAccounts && (account !== undefined || accountIndex !== undefined))
    return {
      ok: false,
      message: "--all-accounts cannot be combined with --account or --account-index",
    };
  if (
    (account !== undefined || accountIndex !== undefined || allAccounts) &&
    provider === undefined
  )
    return { ok: false, message: "account selection requires a single provider" };
  return {
    ok: true,
    value: {
      output: {
        format: jsonOnly ? "json" : (explicitFormat ?? (jsonShortcut ? "json" : "text")),
        jsonOnly,
        pretty,
        noColor,
        brief,
      },
      ...(provider === undefined ? {} : { provider }),
      sourceMode,
      ...(account === undefined ? {} : { account }),
      ...(accountIndex === undefined ? {} : { accountIndex }),
      allAccounts,
      includeCredits: !arguments_.includes("--no-credits"),
      includeStatus: arguments_.includes("--status"),
      ...(webTimeoutSeconds === undefined ? {} : { webTimeoutSeconds }),
    },
  };
};

type CardMetric = {
  readonly label: string;
  readonly remainingPercent: number;
  readonly resetText?: string;
  readonly resetAt?: string;
  readonly detailText?: string;
};

type CardModel = {
  readonly provider: string;
  readonly title: string;
  readonly sourceLabel: string;
  readonly accountLine?: string;
  readonly isActive: false;
  readonly infoLines: readonly string[];
  readonly metrics: readonly CardMetric[];
  readonly extraLines: readonly string[];
  readonly statusLine?: string;
};

type CardFailure = { readonly provider: string; readonly message: string };

const metricEntries = (snapshot: UsageSnapshot): readonly [string, RateWindow][] => [
  ...(snapshot.primary === undefined
    ? []
    : [["Primary", snapshot.primary] as [string, RateWindow]]),
  ...(snapshot.secondary === undefined
    ? []
    : [["Secondary", snapshot.secondary] as [string, RateWindow]]),
  ...(snapshot.tertiary === undefined
    ? []
    : [["Tertiary", snapshot.tertiary] as [string, RateWindow]]),
  ...(snapshot.extraRateWindows ?? []).map(
    ({ title, window }) => [title, window] as [string, RateWindow],
  ),
];

const cardFrom = (descriptor: CLIProviderDescriptor, outcome: ProviderFetchOutcome): CardModel => {
  const snapshot = outcome.snapshot;
  const identity = snapshot.identity;
  const accountLine =
    identity?.accountEmail ?? identity?.accountOrganization ?? identity?.accountId;
  const metrics = metricEntries(snapshot).map(([label, window]) => ({
    label,
    remainingPercent: Math.max(0, Math.min(100, 100 - window.usedPercent)),
    ...(window.resetDescription === undefined ? {} : { resetText: window.resetDescription }),
    ...(window.resetsAt === undefined ? {} : { resetAt: window.resetsAt }),
  }));
  const infoLines = [
    ...(identity?.loginMethod === undefined ? [] : [`Login: ${identity.loginMethod}`]),
    ...snapshot.details.flatMap((section) => [
      ...(section.title === undefined ? [] : [section.title]),
      ...section.rows.map(
        (row) =>
          `${row.label}: ${row.value}${row.secondaryValue === undefined ? "" : ` · ${row.secondaryValue}`}`,
      ),
    ]),
  ];
  const extraLines =
    snapshot.providerCost === undefined
      ? []
      : [
          `Cost: ${snapshot.providerCost.used} ${snapshot.providerCost.currencyCode} of ${snapshot.providerCost.limit}`,
        ];
  return {
    provider: descriptor.id,
    title: descriptor.name,
    sourceLabel: outcome.source,
    ...(accountLine === undefined ? {} : { accountLine }),
    isActive: false,
    infoLines,
    metrics,
    extraLines,
  };
};

const bar = (usedPercent: number, width = 18): string => {
  const filled = Math.round((Math.max(0, Math.min(100, usedPercent)) / 100) * width);
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
};

const renderCard = (card: CardModel): string => {
  const lines = [
    `┌─ ${card.title} [${card.sourceLabel}]`,
    ...(card.accountLine === undefined ? [] : [`│ @ ${card.accountLine}`]),
    "├────────────────────────────────────",
    ...card.infoLines.map((line) => `│ ${line}`),
    ...card.metrics.flatMap((metric) => [
      `│ ${metric.label}: ${100 - metric.remainingPercent}% used`,
      `│ ${bar(100 - metric.remainingPercent)}`,
      ...(metric.resetText === undefined ? [] : [`│ ${metric.resetText}`]),
    ]),
    ...card.extraLines.map((line) => `│ ${line}`),
    ...(card.statusLine === undefined ? [] : [`│ ${card.statusLine}`]),
    "└────────────────────────────────────",
  ];
  return lines.join("\n");
};

const renderBrief = (cards: readonly CardModel[]): string => {
  const lines = ["Provider             Usage                 Reset"];
  for (const card of cards) {
    const metric = card.metrics[0];
    const usage =
      metric === undefined
        ? "—"
        : `${100 - metric.remainingPercent}% ${bar(100 - metric.remainingPercent, 12)}`;
    const reset = metric?.resetText ?? metric?.resetAt ?? "—";
    lines.push(`${card.title.padEnd(20).slice(0, 20)} ${usage.padEnd(21).slice(0, 21)} ${reset}`);
  }
  return lines.join("\n");
};

const selection = (
  raw: string | undefined,
  providers: readonly CLIProviderDescriptor[],
  configured: readonly ProviderId[] | undefined,
): { readonly providers: readonly CLIProviderDescriptor[] } | { readonly error: string } => {
  const selected = raw?.toLowerCase();
  if (selected === undefined || selected === "all") {
    const ids =
      configured === undefined
        ? providers.filter(({ status }) => status === "partial")
        : providers.filter(({ id }) => configured.includes(id));
    return { providers: ids };
  }
  if (selected === "both") {
    return { providers: providers.filter(({ isPrimaryProvider }) => isPrimaryProvider === true) };
  }
  const provider = providers.find(({ id }) => id === selected);
  return provider === undefined ? { error: `Unknown provider: ${raw}` } : { providers: [provider] };
};

const failurePayload = (failure: CardFailure) => ({
  provider: failure.provider,
  source: "auto",
  error: { code: 1, message: failure.message, kind: "provider" as const },
});

export const runCards = async (
  arguments_: readonly string[],
  io: CLIIO,
  runtime: CLIProviderRuntime,
): Promise<CLICommandResult> => {
  const parsed = parseCardsArguments(arguments_);
  const asksForJSON = arguments_.some(
    (argument, index) =>
      argument === "--json" ||
      argument === "--json-only" ||
      argument === "--format=json" ||
      (argument === "--format" && arguments_[index + 1] === "json"),
  );
  if (!parsed.ok) {
    if (asksForJSON)
      io.stdout(JSON.stringify([failurePayload({ provider: "cli", message: parsed.message })]));
    else io.stderr(`Error: ${parsed.message}`);
    return { exitCode: 64 };
  }
  const { output } = parsed.value;
  if (parsed.value.includeStatus) {
    const message = "Provider status probes are not connected to the TypeScript CLI runtime yet";
    if (output.format === "json")
      io.stdout(JSON.stringify([failurePayload({ provider: "cli", message })]));
    else if (!output.jsonOnly) io.stderr(`Error: ${message}`);
    return { exitCode: 1 };
  }
  let configured: readonly ProviderId[] | undefined;
  if (runtime.config !== undefined) {
    try {
      const config = (await runtime.config.load()) ?? makeDefaultCodexBarConfig();
      configured = config.providers
        .filter((entry) => entry.enabled ?? entry.id === "codex")
        .map((entry) => entry.id as ProviderId);
    } catch {
      if (!output.jsonOnly) io.stderr("Error: Unable to load config");
      return { exitCode: 1 };
    }
  }
  const selected = selection(parsed.value.provider, runtime.providers, configured);
  if ("error" in selected) {
    if (output.format === "json")
      io.stdout(JSON.stringify([failurePayload({ provider: "cli", message: selected.error })]));
    else io.stderr(`Error: ${selected.error}`);
    return { exitCode: 64 };
  }
  if (selected.providers.length === 0) {
    const message = "No enabled providers are configured";
    if (output.format === "json")
      io.stdout(JSON.stringify([failurePayload({ provider: "cli", message })]));
    else io.stderr(`Error: ${message}`);
    return { exitCode: 1 };
  }

  const cards: CardModel[] = [];
  const failures: CardFailure[] = [];
  let exitCode: CLIExitCode = 0;
  for (const descriptor of selected.providers) {
    const context: ProviderFetchContext = {
      sourceMode: parsed.value.sourceMode,
      includeCredits: parsed.value.includeCredits,
      ...(parsed.value.account === undefined &&
      parsed.value.accountIndex === undefined &&
      !parsed.value.allAccounts &&
      parsed.value.webTimeoutSeconds === undefined
        ? {}
        : {
            metadata: {
              ...(parsed.value.account === undefined ? {} : { account: parsed.value.account }),
              ...(parsed.value.accountIndex === undefined
                ? {}
                : { accountIndex: String(parsed.value.accountIndex) }),
              ...(parsed.value.allAccounts ? { allAccounts: "true" } : {}),
              ...(parsed.value.webTimeoutSeconds === undefined
                ? {}
                : { webTimeoutSeconds: String(parsed.value.webTimeoutSeconds) }),
            },
          }),
    };
    try {
      cards.push(cardFrom(descriptor, await runtime.fetch(descriptor.id, context)));
    } catch (error) {
      exitCode = 1;
      failures.push({
        provider: descriptor.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (output.format === "json") {
    const payload = [...cards, ...failures.map(failurePayload)];
    io.stdout(JSON.stringify(payload, undefined, output.pretty ? 2 : undefined));
  } else if (!output.jsonOnly) {
    const rendered = output.brief ? renderBrief(cards) : cards.map(renderCard).join("\n\n");
    if (rendered.length > 0) io.stdout(rendered);
    if (failures.length > 0)
      io.stderr(
        failures.map(({ provider, message }) => `Error: ${provider}: ${message}`).join("\n"),
      );
  }
  return { exitCode };
};

export const serializeCardSnapshot = (outcome: ProviderFetchOutcome) =>
  serializeUsageSnapshot(outcome.snapshot);
