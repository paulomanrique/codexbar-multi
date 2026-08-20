import {
  ConfigDecodeError,
  type ConfigProviderCapabilities,
  type ConfigProviderMetadata,
  type ConfigRepositoryService,
  defaultConfigProviderMetadata,
  makeDefaultCodexBarConfig,
  normalizeCodexBarConfig,
  sanitizedCodexBarConfigForDump,
  validateCodexBarConfig,
  type PersistedCodexBarConfig,
} from "@codexbar/core";
import type { ProviderId } from "@codexbar/contracts";
import { Effect } from "effect";
import type {
  CLICommandResult,
  CLIErrorKind,
  CLIExitCode,
  CLIIO,
  CLIOutputFormat,
  CLIProviderDescriptor,
} from "./runner.ts";

export interface CLIConfigStore {
  readonly path: string;
  readonly load: () => Promise<PersistedCodexBarConfig | undefined>;
  readonly save: (config: PersistedCodexBarConfig) => Promise<void>;
}

export interface ConfigCommandRuntime {
  readonly config: CLIConfigStore;
  readonly providers: readonly CLIProviderDescriptor[];
  readonly capabilities?: readonly ConfigProviderCapabilities[];
}

export interface ConfigCommandOutput {
  readonly format: CLIOutputFormat;
  readonly jsonOnly: boolean;
  readonly pretty: boolean;
}

type ConfigAction = "validate" | "dump" | "providers" | "enable" | "disable";

type ParsedConfigArguments = {
  readonly action: ConfigAction;
  readonly output: ConfigCommandOutput;
  readonly provider?: string;
};

type ConfigParseResult =
  | { readonly ok: true; readonly value: ParsedConfigArguments }
  | { readonly ok: false; readonly message: string };

const actions = new Set<ConfigAction>(["validate", "dump", "providers", "enable", "disable"]);

const parseOutputAndAction = (arguments_: readonly string[]): ConfigParseResult => {
  let action: ConfigAction = "validate";
  let actionSeen = false;
  let format: CLIOutputFormat | undefined;
  let jsonShortcut = false;
  let jsonSeen = false;
  let jsonOnlySeen = false;
  let jsonOnly = false;
  let pretty = false;
  let provider: string | undefined;
  let providerSeen = false;
  const positional: string[] = [];

  const duplicate = (name: string): ConfigParseResult => ({
    ok: false,
    message: `Option ${name} may only be specified once`,
  });
  const missing = (name: string): ConfigParseResult => ({
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
    if (argument === "--json") {
      if (jsonSeen) return duplicate("--json");
      jsonSeen = true;
      jsonShortcut = true;
      continue;
    }
    if (argument === "--json-only") {
      if (jsonOnlySeen) return duplicate("--json-only");
      jsonOnlySeen = true;
      jsonShortcut = true;
      jsonOnly = true;
      continue;
    }
    if (argument === "--pretty") {
      if (pretty) return duplicate("--pretty");
      pretty = true;
      continue;
    }
    if (argument === "--show-secrets") {
      return { ok: false, message: "--show-secrets is disabled by the TypeScript CLI" };
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
    if (argument === "--format" || argument.startsWith("--format=")) {
      if (format !== undefined) return duplicate("--format");
      const value =
        argument === "--format" ? arguments_[index + 1] : argument.slice("--format=".length);
      if (value === undefined || value.length === 0 || value.startsWith("-"))
        return missing("--format");
      const normalized = value.toLowerCase();
      if (normalized !== "text" && normalized !== "json")
        return {
          ok: false,
          message: `Invalid value '${value}' for --format (expected text or json)`,
        };
      format = normalized;
      if (argument === "--format") index += 1;
      continue;
    }
    return { ok: false, message: `Unknown option ${argument}` };
  }

  if (positional.length > 1) return { ok: false, message: "config accepts at most one action" };
  if (positional[0] !== undefined) {
    if (!actions.has(positional[0] as ConfigAction))
      return { ok: false, message: `Unknown config command '${positional[0]}'` };
    action = positional[0] as ConfigAction;
    actionSeen = true;
  }
  if (actionSeen && positional.length !== 1)
    return { ok: false, message: "Invalid config command" };
  if ((action === "enable" || action === "disable") && provider === undefined)
    return { ok: false, message: "Unknown or missing provider. Use --provider <name>." };
  if (action !== "enable" && action !== "disable" && provider !== undefined)
    return { ok: false, message: `${action} does not accept --provider` };

  return {
    ok: true,
    value: {
      action,
      output: { format: format ?? (jsonShortcut ? "json" : "text"), jsonOnly, pretty },
      ...(provider === undefined ? {} : { provider }),
    },
  };
};

const encode = (value: unknown, pretty: boolean): string =>
  JSON.stringify(value, undefined, pretty ? 2 : undefined);

const outputHint = (arguments_: readonly string[]): ConfigCommandOutput => {
  let format: CLIOutputFormat = "text";
  let jsonOnly = false;
  let pretty = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--json" || argument === "--json-only") {
      format = "json";
      jsonOnly ||= argument === "--json-only";
    } else if (argument === "--pretty") pretty = true;
    else if (argument === "--format") {
      const value = arguments_[index + 1]?.toLowerCase();
      if (value === "json" || value === "text") format = value;
      index += 1;
    } else if (argument?.startsWith("--format=")) {
      const value = argument.slice("--format=".length).toLowerCase();
      if (value === "json" || value === "text") format = value;
    }
  }
  return { format, jsonOnly, pretty };
};

const errorPayload = (message: string, code: CLIExitCode, kind: CLIErrorKind) => ({
  provider: "cli",
  source: "cli",
  error: { code, message, kind },
});

const writeFailure = (
  io: CLIIO,
  output: ConfigCommandOutput,
  message: string,
  code: CLIExitCode,
  kind: CLIErrorKind,
): CLICommandResult => {
  if (output.format === "json" || output.jsonOnly)
    io.stdout(encode(errorPayload(message, code, kind), output.pretty));
  else io.stderr(`Error: ${message}`);
  return { exitCode: code };
};

const loadConfig = async (store: CLIConfigStore): Promise<PersistedCodexBarConfig> =>
  normalizeCodexBarConfig((await store.load()) ?? makeDefaultCodexBarConfig());

const metadataFor = (
  providers: readonly CLIProviderDescriptor[],
): readonly ConfigProviderMetadata[] => {
  const names = new Map(providers.map((provider) => [provider.id, provider.name]));
  return defaultConfigProviderMetadata().map((entry) => ({
    ...entry,
    displayName: names.get(entry.id) ?? entry.displayName,
  }));
};

const providerRows = (
  config: PersistedCodexBarConfig,
  providers: readonly CLIProviderDescriptor[],
) => {
  const metadata = metadataFor(providers);
  const byID = new Map(metadata.map((entry) => [entry.id, entry]));
  return config.providers.map((entry) => {
    const metadataEntry = byID.get(entry.id as ProviderId);
    const defaultEnabled = metadataEntry?.defaultEnabled ?? false;
    return {
      provider: entry.id,
      displayName: metadataEntry?.displayName ?? entry.id,
      enabled: entry.enabled ?? defaultEnabled,
      defaultEnabled,
    };
  });
};

const resolveProvider = (
  raw: string,
  providers: readonly CLIProviderDescriptor[],
): CLIProviderDescriptor | undefined =>
  providers.find((provider) => provider.id.toLowerCase() === raw.toLowerCase());

const runValidate = (
  io: CLIIO,
  output: ConfigCommandOutput,
  config: PersistedCodexBarConfig,
  capabilities: readonly ConfigProviderCapabilities[] | undefined,
): CLICommandResult => {
  const issues = validateCodexBarConfig(
    config,
    capabilities === undefined ? {} : { providers: capabilities },
  );
  const hasErrors = issues.some((entry) => entry.severity === "error");
  if (output.format === "json") io.stdout(encode(issues, output.pretty));
  else if (issues.length === 0) io.stdout("Config: OK");
  else {
    for (const entry of issues) {
      const provider = entry.provider ?? "config";
      const field = entry.field === undefined ? "" : ` (${entry.field})`;
      io.stdout(`[${entry.severity.toUpperCase()}] ${provider}${field}: ${entry.message}`);
    }
  }
  return { exitCode: hasErrors ? 1 : 0 };
};

export const runConfig = async (
  arguments_: readonly string[],
  io: CLIIO,
  runtime: ConfigCommandRuntime | undefined,
): Promise<CLICommandResult> => {
  const parsed = parseOutputAndAction(arguments_);
  const fallbackOutput = outputHint(arguments_);
  if (!parsed.ok) return writeFailure(io, fallbackOutput, parsed.message, 64, "args");
  const { action, output } = parsed.value;
  if (runtime === undefined)
    return writeFailure(io, output, "Configuration store is unavailable", 1, "config");

  let config: PersistedCodexBarConfig;
  try {
    config = await loadConfig(runtime.config);
  } catch (error) {
    const message = error instanceof ConfigDecodeError ? error.message : "Unable to load config";
    return writeFailure(io, output, message, 1, "config");
  }

  if (action === "validate") return runValidate(io, output, config, runtime.capabilities);
  if (action === "dump") {
    // Dump is inherently JSON in the upstream CLI. Secrets never leave the
    // process: this command intentionally has no reveal-secrets escape hatch.
    io.stdout(encode(sanitizedCodexBarConfigForDump(config), output.pretty));
    return { exitCode: 0 };
  }
  if (action === "providers") {
    const rows = providerRows(config, runtime.providers);
    if (output.format === "json") io.stdout(encode(rows, output.pretty));
    else {
      for (const row of rows)
        io.stdout(
          `${row.provider}: ${row.enabled ? "enabled" : "disabled"}${row.defaultEnabled ? " default" : ""} (${row.displayName})`,
        );
    }
    return { exitCode: 0 };
  }

  const provider = resolveProvider(parsed.value.provider ?? "", runtime.providers);
  if (provider === undefined)
    return writeFailure(
      io,
      output,
      `Unknown or missing provider. Use --provider <name>.`,
      64,
      "args",
    );
  const enabled = action === "enable";
  const updated: PersistedCodexBarConfig = {
    ...config,
    providers: config.providers.map((entry) =>
      entry.id === provider.id ? { ...entry, enabled } : entry,
    ),
  };
  try {
    await runtime.config.save(updated);
  } catch {
    return writeFailure(io, output, "Unable to save config", 1, "config");
  }
  const result = {
    provider: provider.id,
    displayName: provider.name,
    enabled,
    configPath: runtime.config.path,
  };
  if (output.format === "json") io.stdout(encode(result, output.pretty));
  else io.stdout(`Config: ${enabled ? "enabled" : "disabled"} ${provider.name}`);
  return { exitCode: 0 };
};

export const makeNodeCLIConfigStore = (
  repository: ConfigRepositoryService,
  path: string,
): CLIConfigStore => ({
  path,
  load: () => Effect.runPromise(repository.load),
  save: (config) => Effect.runPromise(repository.save(config)),
});
