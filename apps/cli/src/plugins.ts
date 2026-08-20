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

export interface CLIPluginApprovalPreview {
  readonly pluginId: string;
  readonly origins: readonly string[];
  readonly authMode: string;
  readonly secretNames: readonly string[];
  readonly capabilities: readonly string[];
  readonly cookieDomains: readonly string[];
  readonly typedConfirmationOrigins: readonly string[];
}

/** Host owns discovery, approval storage, and QuickJS execution. CLI only formats safe DTOs. */
export interface CLIPluginStore {
  readonly list: () => Promise<{
    readonly plugins: readonly CLIInstalledPlugin[];
    readonly invalidFiles: readonly CLIInvalidPluginFile[];
  }>;
  readonly fetch: (pluginId: string) => Promise<CLIPluginFetchResult>;
  /** True only when the host validates desktop-exported, per-plugin cookie credentials. */
  readonly supportsExportedBrowserCookies?: boolean;
  readonly install?: (sourcePath: string) => Promise<CLIInstalledPlugin>;
  readonly previewApproval?: (
    pluginId: string,
    settings: Readonly<Record<string, string>>,
  ) => Promise<CLIPluginApprovalPreview>;
  readonly approve?: (
    pluginId: string,
    settings: Readonly<Record<string, string>>,
    typedConfirmations: Readonly<Record<string, string>>,
  ) => Promise<CLIPluginApprovalPreview>;
  readonly test?: (pluginId: string) => Promise<CLIPluginFetchResult>;
  readonly remove?: (pluginId: string) => Promise<void>;
  readonly setSecret?: (pluginId: string, key: string, value: string) => Promise<void>;
  readonly removeSecret?: (pluginId: string, key: string) => Promise<void>;
}

type PluginRuntime = CLIProviderRuntime & { readonly plugins?: CLIPluginStore };
type PluginFormat = "text" | "json";

type ParsedPluginArguments = {
  readonly action:
    | "list"
    | "fetch"
    | "install"
    | "preview"
    | "approve"
    | "test"
    | "remove"
    | "set-secret"
    | "remove-secret";
  readonly id?: string;
  readonly sourcePath?: string;
  readonly secretKey?: string;
  readonly settings: Readonly<Record<string, string>>;
  readonly typedConfirmations: Readonly<Record<string, string>>;
  readonly format: PluginFormat;
  readonly pretty: boolean;
};
type PluginParseResult =
  | { readonly ok: true; readonly value: ParsedPluginArguments }
  | { readonly ok: false; readonly message: string };

const terminalText = (value: string, maximum = 512): string => {
  const normalized = [...value]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || code === 127 ? " " : character;
    })
    .join("")
    .trim();
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
  const settings: Record<string, string> = {};
  const typedConfirmations: Record<string, string> = {};
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
    if (
      argument === "--setting" ||
      argument.startsWith("--setting=") ||
      argument === "--confirm" ||
      argument.startsWith("--confirm=")
    ) {
      const isConfirmation = argument === "--confirm" || argument.startsWith("--confirm=");
      const name = isConfirmation ? "--confirm" : "--setting";
      const value = argument === name ? arguments_[index + 1] : argument.slice(`${name}=`.length);
      if (value === undefined || value === "" || value.startsWith("-")) return missing(name);
      if (argument === name) index += 1;
      const separator = value.indexOf("=");
      if (separator <= 0 || separator === value.length - 1)
        return { ok: false, message: `${name} expects KEY=VALUE` };
      const key = value.slice(0, separator);
      const settingValue = value.slice(separator + 1);
      if (isConfirmation) typedConfirmations[key] = settingValue;
      else settings[key] = settingValue;
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
  const leadingAction = positional[0];
  const action =
    leadingAction === "secret" && positional[1] === "set"
      ? "set-secret"
      : leadingAction === "secret" && positional[1] === "remove"
        ? "remove-secret"
        : leadingAction;
  if (
    action !== "list" &&
    action !== "fetch" &&
    action !== "install" &&
    action !== "preview" &&
    action !== "approve" &&
    action !== "test" &&
    action !== "remove" &&
    action !== "set-secret" &&
    action !== "remove-secret"
  )
    return {
      ok: false,
      message:
        "plugins accepts list, install <file>, preview <id>, approve <id>, test <id>, fetch <id>, remove <id>, or secret set|remove <id> <key>",
    };
  if (action === "list" && positional.length !== 1)
    return { ok: false, message: "plugins list accepts no positional arguments" };
  if (action === "install" && (positional.length !== 2 || positional[1] === ""))
    return { ok: false, message: "plugins install requires <file>" };
  if (
    (action === "fetch" ||
      action === "preview" ||
      action === "approve" ||
      action === "test" ||
      action === "remove") &&
    (positional.length !== 2 || positional[1] === "")
  )
    return { ok: false, message: `plugins ${action} requires <id>` };
  if (
    (action === "set-secret" || action === "remove-secret") &&
    (positional.length !== 4 || positional[2] === "" || positional[3] === "")
  )
    return { ok: false, message: "plugins secret set|remove requires <id> <key>" };
  if (action !== "preview" && action !== "approve" && Object.keys(settings).length > 0)
    return { ok: false, message: "--setting is only valid with plugins preview or approve" };
  if (action !== "approve" && Object.keys(typedConfirmations).length > 0)
    return { ok: false, message: "--confirm is only valid with plugins approve" };
  return {
    ok: true,
    value: {
      action,
      ...(positional[1] === undefined ? {} : { id: positional[1] }),
      ...(action === "install" && positional[1] !== undefined ? { sourcePath: positional[1] } : {}),
      ...(action === "set-secret" || action === "remove-secret"
        ? { id: positional[2], secretKey: positional[3] }
        : {}),
      settings,
      typedConfirmations,
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

const emitLifecycleUnavailable = (
  io: CLIIO,
  format: PluginFormat,
  pretty: boolean,
  action: string,
): CLICommandResult => {
  const message = `Plugin ${action} is unavailable; this host does not provide a secure plugin lifecycle adapter`;
  if (format === "json")
    io.stdout(JSON.stringify({ error: message }, undefined, pretty ? 2 : undefined));
  else io.stderr(`Error: ${message}`);
  return { exitCode: 69 };
};

const safeApprovalPreview = (value: CLIPluginApprovalPreview): Record<string, unknown> => ({
  plugin: terminalText(value.pluginId, 128),
  origins: value.origins.slice(0, 16).map((origin) => terminalText(origin, 512)),
  authMode: terminalText(value.authMode, 64),
  secretNames: value.secretNames.slice(0, 32).map((name) => terminalText(name, 64)),
  capabilities: value.capabilities.slice(0, 8).map((name) => terminalText(name, 64)),
  cookieDomains: value.cookieDomains.slice(0, 64).map((domain) => terminalText(domain, 253)),
  typedConfirmationOrigins: value.typedConfirmationOrigins
    .slice(0, 16)
    .map((origin) => terminalText(origin, 512)),
});

const lifecycleFailure = (
  io: CLIIO,
  format: PluginFormat,
  pretty: boolean,
  action: string,
): CLICommandResult => {
  const message = `Plugin ${action} failed`;
  if (format === "json")
    io.stdout(JSON.stringify({ error: message }, undefined, pretty ? 2 : undefined));
  else io.stderr(`Error: ${message}`);
  return { exitCode: 1 };
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
  const { action, id, sourcePath, secretKey, settings, typedConfirmations, format, pretty } =
    parsed.value;
  if (runtime.plugins === undefined) return emitUnavailable(io, format, pretty);
  if (action === "set-secret" || action === "remove-secret") {
    const operation =
      action === "set-secret" ? runtime.plugins.setSecret : runtime.plugins.removeSecret;
    if (operation === undefined)
      return emitLifecycleUnavailable(io, format, pretty, "secret configuration");
    try {
      if (action === "set-secret") {
        const value = await io.readSecret?.();
        if (
          value === undefined ||
          value === "" ||
          new TextEncoder().encode(value).byteLength > 64 * 1024
        )
          return emitLifecycleUnavailable(io, format, pretty, "secret input");
        await runtime.plugins.setSecret!(id as string, secretKey as string, value);
      } else await runtime.plugins.removeSecret!(id as string, secretKey as string);
      const safe = {
        plugin: terminalText(id as string, 128),
        key: terminalText(secretKey as string, 64),
        configured: action === "set-secret",
      };
      if (format === "json") io.stdout(JSON.stringify(safe, undefined, pretty ? 2 : undefined));
      else io.stdout(`${safe.plugin}\t${safe.key}\t${safe.configured ? "configured" : "removed"}`);
      return { exitCode: 0 };
    } catch {
      return lifecycleFailure(io, format, pretty, "secret configuration");
    }
  }
  if (action === "install") {
    if (runtime.plugins.install === undefined)
      return emitLifecycleUnavailable(io, format, pretty, action);
    try {
      const plugin = safePluginDescriptor(await runtime.plugins.install(sourcePath as string));
      if (format === "json")
        io.stdout(JSON.stringify({ plugin }, undefined, pretty ? 2 : undefined));
      else io.stdout(`${plugin.id}\t${plugin.name}\tinstalled`);
      return { exitCode: 0 };
    } catch {
      return lifecycleFailure(io, format, pretty, action);
    }
  }
  if (action === "preview" || action === "approve") {
    const operation =
      action === "preview" ? runtime.plugins.previewApproval : runtime.plugins.approve;
    if (operation === undefined) return emitLifecycleUnavailable(io, format, pretty, action);
    try {
      const result =
        action === "preview"
          ? await runtime.plugins.previewApproval!(id as string, settings)
          : await runtime.plugins.approve!(id as string, settings, typedConfirmations);
      const safe = safeApprovalPreview(result);
      if (format === "json") io.stdout(JSON.stringify(safe, undefined, pretty ? 2 : undefined));
      else {
        const typed = safe.typedConfirmationOrigins as readonly string[];
        io.stdout(
          [
            `${safe.plugin}`,
            `Origins: ${(safe.origins as readonly string[]).join(", ") || "<none>"}`,
            ...(typed.length === 0 ? [] : [`Typed confirmation: ${typed.join(", ")}`]),
          ].join("\n"),
        );
      }
      return { exitCode: 0 };
    } catch {
      return lifecycleFailure(io, format, pretty, action);
    }
  }
  if (action === "remove") {
    if (runtime.plugins.remove === undefined)
      return emitLifecycleUnavailable(io, format, pretty, action);
    try {
      await runtime.plugins.remove(id as string);
      if (format === "json")
        io.stdout(
          JSON.stringify(
            { plugin: terminalText(id as string, 128), removed: true },
            undefined,
            pretty ? 2 : undefined,
          ),
        );
      else io.stdout(`${terminalText(id as string, 128)}\tremoved`);
      return { exitCode: 0 };
    } catch {
      return lifecycleFailure(io, format, pretty, action);
    }
  }
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
  if (
    plugin.capabilities.includes("browser-cookies") &&
    runtime.plugins.supportsExportedBrowserCookies !== true
  ) {
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
    const result = await (action === "test" && runtime.plugins.test !== undefined
      ? runtime.plugins.test(pluginId)
      : runtime.plugins.fetch(pluginId));
    if (
      result.plugin.id !== pluginId ||
      result.plugin.approvalStatus !== "approved" ||
      (result.plugin.capabilities.includes("browser-cookies") &&
        runtime.plugins.supportsExportedBrowserCookies !== true)
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
