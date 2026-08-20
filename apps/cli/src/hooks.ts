import type { PersistedCodexBarConfig } from "@codexbar/core";
import type { HookEventType, HookRule } from "@codexbar/contracts";
import { makeDefaultCodexBarConfig, normalizeCodexBarConfig } from "@codexbar/core";
import type { CLICommandResult, CLIExitCode, CLIIO } from "./runner.ts";
import type { CLIConfigStore } from "./config.ts";

const eventNames = [
  "quota_low",
  "quota_reached",
  "quota_reset",
  "provider_unavailable",
  "provider_recovered",
  "refresh_failed",
] as const satisfies readonly HookEventType[];
type HookEvent = HookEventType;

export interface HookProcessRequest {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly input: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

export interface HooksCommandRuntime {
  readonly config?: CLIConfigStore;
  readonly providers?: readonly { readonly id: string }[];
  readonly runHook?: (request: HookProcessRequest) => Promise<{ readonly stdout: string }>;
  readonly now?: () => number;
}

type Output = { readonly json: boolean; readonly jsonOnly: boolean; readonly pretty: boolean };
const output = (args: readonly string[]): Output => ({
  json: args.includes("--json") || args.includes("--json-only"),
  jsonOnly: args.includes("--json-only"),
  pretty: args.includes("--pretty"),
});

const configOrDefault = async (store: CLIConfigStore): Promise<PersistedCodexBarConfig> =>
  normalizeCodexBarConfig((await store.load()) ?? makeDefaultCodexBarConfig());

const result = (io: CLIIO, out: Output, value: unknown): void => {
  if (out.json) io.stdout(JSON.stringify(value, undefined, out.pretty ? 2 : undefined));
};

const failure = (
  io: CLIIO,
  out: Output,
  message: string,
  code: CLIExitCode = 1,
): CLICommandResult => {
  if (out.json)
    result(io, out, { provider: "cli", source: "cli", error: { code, message, kind: "runtime" } });
  else if (!out.jsonOnly) io.stderr(`Error: ${message}`);
  return { exitCode: code };
};

const parseAction = (
  args: readonly string[],
): { readonly action: string; readonly rest: readonly string[] } | string => {
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--provider" || arg === "--event") {
      index += 1;
      continue;
    }
    if (arg !== undefined && !arg.startsWith("-")) positional.push(arg);
  }
  if (positional.length > 2 || (positional.length === 2 && positional[0] !== "test"))
    return "hooks accepts at most one action";
  const action = positional[0] ?? "list";
  if (!["list", "enable", "disable", "test", "watch"].includes(action))
    return `Unknown hooks command '${action}'`;
  return { action, rest: args.filter((arg) => arg.startsWith("-")) };
};

const isAbsoluteExecutable = (value: string): boolean =>
  value.startsWith("/") ||
  /^[A-Za-z]:[\\/]/u.test(value) ||
  /^\\\\[^\\/]+[\\/][^\\/]+/u.test(value);

const utf8Length = (value: string): number => new TextEncoder().encode(value).byteLength;

const validRule = (rule: HookRule): boolean => {
  const commandBytes =
    utf8Length(rule.executable) +
    rule.arguments.reduce((total, argument) => total + utf8Length(argument), 0);
  return (
    utf8Length(rule.id) > 0 &&
    utf8Length(rule.id) <= 128 &&
    rule.arguments.length <= 32 &&
    rule.arguments.every((value) => utf8Length(value) <= 4_096) &&
    isAbsoluteExecutable(rule.executable) &&
    utf8Length(rule.executable) <= 4_096 &&
    commandBytes <= 32 * 1_024 &&
    (rule.threshold === undefined ||
      (Number.isFinite(rule.threshold) && rule.threshold > 0 && rule.threshold <= 1)) &&
    Number.isFinite(rule.timeoutSeconds) &&
    rule.timeoutSeconds >= 0.1 &&
    rule.timeoutSeconds <= 300
  );
};

const matchingRules = (
  config: PersistedCodexBarConfig,
  event: HookEvent,
  provider: string,
): readonly HookRule[] => {
  const hooks = config.hooks;
  if (hooks === undefined || !hooks.enabled || hooks.events.length > 32) return [];
  return hooks.events.filter(
    (rule) =>
      validRule(rule) &&
      rule.enabled &&
      rule.event === event &&
      (rule.provider === undefined || rule.provider === provider),
  );
};

const optionValue = (args: readonly string[], name: string): string | undefined => {
  const direct = args.find((arg) => arg.startsWith(`${name}=`));
  if (direct !== undefined) return direct.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

export const runHooks = async (
  args: readonly string[],
  io: CLIIO,
  runtime: HooksCommandRuntime,
): Promise<CLICommandResult> => {
  const out = output(args);
  const parsed = parseAction(args);
  if (typeof parsed === "string") return failure(io, out, parsed, 64 as CLIExitCode);
  if (runtime.config === undefined)
    return failure(io, out, "hooks are unavailable because configuration is not connected");
  const store = runtime.config;
  if (parsed.action === "watch")
    return failure(io, out, "hooks watch is not ported yet; no provider polling was attempted");
  let config: PersistedCodexBarConfig;
  try {
    config = await configOrDefault(store);
  } catch (error) {
    return failure(io, out, error instanceof Error ? error.message : String(error));
  }
  if (parsed.action === "list") {
    const hooks = config.hooks ?? { enabled: false, events: [] };
    if (out.json) result(io, out, hooks);
    else if (!out.jsonOnly) {
      io.stdout(`Hooks: ${hooks.enabled ? "enabled" : "disabled"}`);
      if (hooks.events.length === 0) io.stdout("No rules configured.");
      for (const rule of hooks.events)
        io.stdout(
          `[${rule.enabled ? "on" : "off"}] ${rule.event} provider=${rule.provider ?? "any"}: ${[rule.executable, ...rule.arguments].join(" ")}`,
        );
    }
    return { exitCode: 0 };
  }
  if (parsed.action === "enable" || parsed.action === "disable") {
    const hooks = config.hooks ?? { enabled: false, events: [] };
    const updated = { ...config, hooks: { ...hooks, enabled: parsed.action === "enable" } };
    try {
      await store.save(updated);
    } catch (error) {
      return failure(io, out, error instanceof Error ? error.message : String(error));
    }
    if (out.json) result(io, out, updated.hooks);
    else if (!out.jsonOnly) io.stdout(`Hooks: ${updated.hooks.enabled ? "enabled" : "disabled"}`);
    return { exitCode: 0 };
  }
  const event =
    optionValue(args, "--event") ?? args.find((arg) => !arg.startsWith("-") && arg !== "test");
  const provider = optionValue(args, "--provider");
  if (!event || !(eventNames as readonly string[]).includes(event))
    return failure(
      io,
      out,
      `Unknown or missing event. Use one of: ${eventNames.join(", ")}`,
      64 as CLIExitCode,
    );
  if (!provider)
    return failure(
      io,
      out,
      "Unknown or missing provider. Use --provider <name>.",
      64 as CLIExitCode,
    );
  const normalizedProvider = provider.toLowerCase();
  if (runtime.providers?.some((candidate) => candidate.id === normalizedProvider) !== true)
    return failure(
      io,
      out,
      "Unknown or missing provider. Use --provider <name>.",
      64 as CLIExitCode,
    );
  const rules = matchingRules(config, event as HookEvent, normalizedProvider);
  if (rules.length === 0)
    return failure(
      io,
      out,
      config.hooks?.enabled
        ? `No hook rule matches ${event} for ${provider}.`
        : "Hooks are disabled.",
    );
  if (runtime.runHook === undefined)
    return failure(
      io,
      out,
      "hook execution is unavailable in this CLI composition; no executable was launched",
    );
  const timestamp = new Date(runtime.now?.() ?? Date.now()).toISOString();
  const status =
    event === "provider_unavailable"
      ? "major"
      : event === "provider_recovered"
        ? "none"
        : event === "refresh_failed"
          ? "error"
          : undefined;
  const eventPayload = {
    event,
    provider: normalizedProvider,
    window: event.startsWith("quota_") ? "session" : undefined,
    usagePercent:
      event === "quota_low" || event === "quota_reached"
        ? 1
        : event === "quota_reset"
          ? 0
          : undefined,
    status,
    timestamp,
  };
  const rows: Array<Record<string, unknown>> = [];
  for (const rule of rules) {
    const controller = new AbortController();
    try {
      const response = await runtime.runHook({
        executable: rule.executable,
        arguments: rule.arguments,
        input: JSON.stringify(eventPayload),
        environment: {
          CODEXBAR_EVENT: event,
          CODEXBAR_PROVIDER: normalizedProvider,
          CODEXBAR_TIMESTAMP: timestamp,
        },
        timeoutMs: rule.timeoutSeconds * 1000,
        signal: controller.signal,
      });
      rows.push({
        ruleID: rule.id,
        executable: rule.executable,
        event,
        provider: normalizedProvider,
        success: true,
        ...(response.stdout ? { stdout: response.stdout.trim() } : {}),
      });
    } catch (error) {
      rows.push({
        ruleID: rule.id,
        executable: rule.executable,
        event,
        provider: normalizedProvider,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (out.json) result(io, out, rows);
  else if (!out.jsonOnly)
    for (const row of rows)
      io.stdout(`ran ${String(row.executable)}: ${row.success ? "OK" : String(row.error)}`);
  return { exitCode: rows.every((row) => row.success === true) ? 0 : 1 };
};
