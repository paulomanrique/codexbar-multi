import type { UsageSnapshot } from "@codexbar/contracts";
import type { CLICommandResult, CLIIO, CLIProviderRuntime } from "./runner.ts";

export interface CLIInstalledPlugin {
  readonly id: string;
  readonly name: string;
  readonly language: "javascript" | "typescript";
  readonly path?: string;
  readonly capabilities: readonly string[];
  readonly cookieDomains: readonly string[];
  readonly approvalStatus: "approved" | "needs-approval";
}

export interface CLIInvalidPluginFile {
  readonly fileName: string;
  readonly error: string;
}

export interface CLIPluginFetchResult {
  readonly plugin: CLIInstalledPlugin;
  readonly snapshot: UsageSnapshot;
}

/** Host owns discovery, approval storage, and QuickJS execution. CLI only formats safe DTOs. */
export interface CLIPluginStore {
  readonly list: () => Promise<{
    readonly plugins: readonly CLIInstalledPlugin[];
    readonly invalidFiles: readonly CLIInvalidPluginFile[];
  }>;
  readonly fetch: (pluginId: string) => Promise<CLIPluginFetchResult>;
}

type PluginRuntime = CLIProviderRuntime & { readonly plugins?: CLIPluginStore };
type PluginFormat = "text" | "json";

type ParsedPluginArguments = {
  readonly action: "list" | "fetch";
  readonly id?: string;
  readonly format: PluginFormat;
  readonly pretty: boolean;
};
type PluginParseResult =
  | { readonly ok: true; readonly value: ParsedPluginArguments }
  | { readonly ok: false; readonly message: string };

const terminalText = (value: string, maximum = 512): string => {
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 3)}...`;
};

const safePluginDescriptor = (plugin: CLIInstalledPlugin): CLIInstalledPlugin => ({
  id: terminalText(plugin.id, 128),
  name: terminalText(plugin.name, 256),
  language: plugin.language,
  ...(plugin.path === undefined ? {} : { path: terminalText(plugin.path, 4_096) }),
  capabilities: plugin.capabilities.slice(0, 64).map((value) => terminalText(value, 128)),
  cookieDomains: plugin.cookieDomains.slice(0, 64).map((value) => terminalText(value, 253)),
  approvalStatus: plugin.approvalStatus,
});

const parsePluginArguments = (arguments_: readonly string[]): PluginParseResult => {
  const positional: string[] = [];
  let format: PluginFormat = "text";
  let pretty = false;
  const seen = new Set<string>();
  const duplicate = (name: string): PluginParseResult => ({
    ok: false,
    message: `Option ${name} may only be specified once`,
  });
  const missing = (name: string): PluginParseResult => ({
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
    if (argument === "--format" || argument.startsWith("--format=")) {
      if (seen.has("--format")) return duplicate("--format");
      seen.add("--format");
      const value =
        argument === "--format" ? arguments_[index + 1] : argument.slice("--format=".length);
      if (value === undefined || value === "" || value.startsWith("-")) return missing("--format");
      if (argument === "--format") index += 1;
      if (value.toLowerCase() !== "text" && value.toLowerCase() !== "json")
        return { ok: false, message: "Invalid value for --format (expected text or json)" };
      format = value.toLowerCase() as PluginFormat;
      continue;
    }
    return { ok: false, message: `Unknown option ${argument}` };
  }
  const action = positional[0];
  if (action !== "list" && action !== "fetch")
    return { ok: false, message: "plugins accepts list or fetch <id>" };
  if (action === "list" && positional.length !== 1)
    return { ok: false, message: "plugins list accepts no positional arguments" };
  if (action === "fetch" && (positional.length !== 2 || positional[1] === ""))
    return { ok: false, message: "plugins fetch requires <id>" };
  return {
    ok: true,
    value: {
      action,
      ...(positional[1] === undefined ? {} : { id: positional[1] }),
      format,
      pretty,
    },
  };
};

const usageWindow = (window: UsageSnapshot["primary"]): Record<string, unknown> | undefined => {
  if (window === undefined) return undefined;
  return {
    usedPercent: window.usedPercent,
    ...(window.windowMinutes === undefined ? {} : { windowMinutes: window.windowMinutes }),
    ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
  };
};

/** Deliberately excludes details, identity, opaque provider JSON, and raw credentials. */
const safeSnapshot = (snapshot: UsageSnapshot): Record<string, unknown> => ({
  ...(usageWindow(snapshot.primary) === undefined
    ? {}
    : { primary: usageWindow(snapshot.primary) }),
  ...(usageWindow(snapshot.secondary) === undefined
    ? {}
    : { secondary: usageWindow(snapshot.secondary) }),
  ...(usageWindow(snapshot.tertiary) === undefined
    ? {}
    : { tertiary: usageWindow(snapshot.tertiary) }),
  ...(snapshot.providerCost === undefined
    ? {}
    : {
        providerCost: {
          used: snapshot.providerCost.used,
          limit: snapshot.providerCost.limit,
          currencyCode: snapshot.providerCost.currencyCode,
          ...(snapshot.providerCost.period === undefined
            ? {}
            : { period: snapshot.providerCost.period }),
          ...(snapshot.providerCost.resetsAt === undefined
            ? {}
            : { resetsAt: snapshot.providerCost.resetsAt }),
        },
      }),
  updatedAt: snapshot.updatedAt,
});

const emitUnavailable = (io: CLIIO, format: PluginFormat, pretty: boolean): CLICommandResult => {
  const message = "Plugin store is unavailable; user plugins require a host QuickJS adapter";
  if (format === "json")
    io.stdout(JSON.stringify({ plugins: [], error: message }, undefined, pretty ? 2 : undefined));
  else io.stderr(`Error: ${message}`);
  return { exitCode: 69 };
};

export const runPlugins = async (
  arguments_: readonly string[],
  io: CLIIO,
  runtime: PluginRuntime,
): Promise<CLICommandResult> => {
  const jsonHint = arguments_.some(
    (argument) =>
      argument === "--json" || argument === "--json-only" || argument === "--format=json",
  );
  const parsed = parsePluginArguments(arguments_);
  if (!parsed.ok) {
    if (jsonHint) io.stdout(JSON.stringify({ plugins: [], error: parsed.message }));
    else io.stderr(`Error: ${parsed.message}`);
    return { exitCode: 64 };
  }
  const { action, id, format, pretty } = parsed.value;
  if (runtime.plugins === undefined) return emitUnavailable(io, format, pretty);
  if (action === "list") {
    let result: Awaited<ReturnType<CLIPluginStore["list"]>>;
    try {
      result = await runtime.plugins.list();
    } catch {
      const message = "Plugin discovery failed";
      if (format === "json") io.stdout(JSON.stringify({ plugins: [], error: message }));
      else io.stderr(`Error: ${message}`);
      return { exitCode: 1 };
    }
    const plugins = [...result.plugins]
      .slice(0, 10_000)
      .sort((left, right) => left.id.localeCompare(right.id));
    const invalidFiles = [...result.invalidFiles].sort((left, right) =>
      left.fileName.localeCompare(right.fileName),
    );
    // Parser failures can include snippets of untrusted plugin source. Keep the
    // CLI diagnostic intentionally generic so source, tokens, and cookies never
    // cross the output boundary.
    const safePlugins = plugins.map(safePluginDescriptor);
    const safeInvalidFiles = invalidFiles.slice(0, 10_000).map((file) => ({
      fileName: terminalText(file.fileName, 256),
      error: "Invalid plugin file",
    }));
    if (format === "json") {
      io.stdout(
        JSON.stringify(
          { plugins: safePlugins, invalidFiles: safeInvalidFiles },
          undefined,
          pretty ? 2 : undefined,
        ),
      );
    } else {
      const lines = safePlugins.map(
        (plugin) =>
          `${terminalText(plugin.id, 128)}\t${terminalText(plugin.name, 256)}\t${terminalText(plugin.path ?? "<host>", 4_096)}`,
      );
      lines.push(...safeInvalidFiles.map((file) => `error\t${file.fileName}\t${file.error}`));
      io.stdout(lines.join("\n"));
    }
    return { exitCode: invalidFiles.length === 0 ? 0 : 1 };
  }
  const pluginId = id as string;
  let listed: Awaited<ReturnType<CLIPluginStore["list"]>>;
  try {
    listed = await runtime.plugins.list();
  } catch {
    const message = "Plugin discovery failed";
    if (format === "json") io.stdout(JSON.stringify({ plugin: pluginId, error: message }));
    else io.stderr(`Error: ${message}`);
    return { exitCode: 1 };
  }
  const plugin = listed.plugins.find((candidate) => candidate.id === pluginId);
  if (plugin === undefined) {
    const message = "Plugin was not found";
    if (format === "json") io.stdout(JSON.stringify({ plugin: pluginId, error: message }));
    else io.stderr(`Error: ${message}`);
    return { exitCode: 1 };
  }
  if (plugin.capabilities.includes("browser-cookies")) {
    const message = "Browser-cookie plugins are unavailable in the CLI";
    if (format === "json") io.stdout(JSON.stringify({ plugin: pluginId, error: message }));
    else io.stderr(`Error: ${message}`);
    return { exitCode: 69 };
  }
  if (plugin.approvalStatus !== "approved") {
    const message = "Plugin approval is required; approve it from the desktop host first";
    if (format === "json") io.stdout(JSON.stringify({ plugin: pluginId, error: message }));
    else io.stderr(`Error: ${message}`);
    return { exitCode: 69 };
  }
  try {
    const result = await runtime.plugins.fetch(pluginId);
    if (
      result.plugin.id !== pluginId ||
      result.plugin.approvalStatus !== "approved" ||
      result.plugin.capabilities.includes("browser-cookies")
    ) {
      throw new Error("plugin approval binding changed during execution");
    }
    const safe = {
      plugin: terminalText(result.plugin.id, 128),
      name: terminalText(result.plugin.name, 256),
      usage: safeSnapshot(result.snapshot),
    };
    if (format === "json") io.stdout(JSON.stringify(safe, undefined, pretty ? 2 : undefined));
    else {
      const lines = [terminalText(result.plugin.name, 256)];
      if (result.snapshot.primary !== undefined)
        lines.push(`Primary: ${Math.round(result.snapshot.primary.usedPercent)}% used`);
      if (result.snapshot.secondary !== undefined)
        lines.push(`Secondary: ${Math.round(result.snapshot.secondary.usedPercent)}% used`);
      if (result.snapshot.providerCost !== undefined)
        lines.push(
          `Cost: ${result.snapshot.providerCost.used} ${result.snapshot.providerCost.currencyCode}`,
        );
      io.stdout(lines.join("\n"));
    }
    return { exitCode: 0 };
  } catch {
    const message = "Plugin execution failed";
    if (format === "json") io.stdout(JSON.stringify({ plugin: pluginId, error: message }));
    else io.stderr(`Error: ${message}`);
    return { exitCode: 1 };
  }
};

export { parsePluginArguments };
