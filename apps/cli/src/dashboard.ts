import type { DashboardSnapshotDTO, ProviderIdentity, UsageSnapshot } from "@codexbar/contracts";
import type { CLICommandResult, CLIExitCode, CLIIO, CLIProviderRuntime } from "./runner.ts";

type IdentityMode = "full" | "redacted";

export interface DashboardCommandRuntime extends Pick<
  CLIProviderRuntime,
  "providers" | "fetch" | "now"
> {}

type ParsedDashboard = {
  readonly provider?: string;
  readonly identity: IdentityMode;
  readonly pretty: boolean;
  readonly output?: string;
  readonly timeoutMs?: number;
};

type ParseResult =
  | { readonly ok: true; readonly value: ParsedDashboard }
  | { readonly ok: false; readonly message: string };

const parseDashboardArguments = (arguments_: readonly string[]): ParseResult => {
  let provider: string | undefined;
  let identity: IdentityMode = "full";
  let pretty = false;
  let output: string | undefined;
  let timeoutMs: number | undefined;
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
    if (argument === "--pretty") {
      if (seen.has(argument))
        return { ok: false, message: "Option --pretty may only be specified once" };
      seen.add(argument);
      pretty = true;
      continue;
    }
    const option = ["--provider", "--identity", "--output", "--timeout"].find(
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
    else if (option === "--identity") {
      if (value !== "full" && value !== "redacted")
        return { ok: false, message: "--identity must be redacted or full" };
      identity = value;
    } else {
      if (!/^\d+(?:\.\d+)?$/u.test(value))
        return { ok: false, message: "--timeout must be a finite number from 0 through 86400" };
      const seconds = Number(value);
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86_400)
        return { ok: false, message: "--timeout must be a finite number from 0 through 86400" };
      timeoutMs = seconds * 1000;
    }
  }
  if (positional.length > 0)
    return { ok: false, message: "dashboard does not accept positional arguments" };
  return {
    ok: true,
    value: {
      ...(provider === undefined ? {} : { provider }),
      identity,
      pretty,
      ...(output === undefined ? {} : { output }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    },
  };
};

const redactIdentity = (
  identity: ProviderIdentity | undefined,
  mode: IdentityMode,
): ProviderIdentity | undefined => {
  if (identity === undefined || mode === "full") return identity;
  return {
    ...(identity.providerId === undefined ? {} : { providerId: identity.providerId }),
    ...(identity.accountEmail === undefined ? {} : { accountEmail: "<redacted>" }),
    ...(identity.accountOrganization === undefined ? {} : { accountOrganization: "<redacted>" }),
    ...(identity.loginMethod === undefined ? {} : { loginMethod: identity.loginMethod }),
    ...(identity.accountId === undefined ? {} : { accountId: "<redacted>" }),
  };
};

const windows = (snapshot: UsageSnapshot): DashboardSnapshotDTO["providers"][number]["windows"] => {
  const standard = [
    ["primary", "Primary", snapshot.primary],
    ["secondary", "Secondary", snapshot.secondary],
    ["tertiary", "Tertiary", snapshot.tertiary],
  ] as const;
  return [
    ...standard.flatMap(([kind, label, value]) =>
      value === undefined
        ? []
        : [
            {
              kind,
              label,
              usedPercent: value.usedPercent,
              remainingPercent: Math.max(0, 100 - value.usedPercent),
              ...(value.resetsAt === undefined ? {} : { resetAt: value.resetsAt }),
            },
          ],
    ),
    ...(snapshot.extraRateWindows ?? []).map(({ id, title, window }) => ({
      kind: id,
      label: title,
      usedPercent: window.usedPercent,
      remainingPercent: Math.max(0, 100 - window.usedPercent),
      ...(window.resetsAt === undefined ? {} : { resetAt: window.resetsAt }),
    })),
  ];
};

const fetchWithTimeout = async (
  runtime: DashboardCommandRuntime,
  providerId: Parameters<DashboardCommandRuntime["fetch"]>[0],
  timeoutMs: number | undefined,
) => {
  if (timeoutMs === undefined || timeoutMs === 0)
    return runtime.fetch(providerId, { sourceMode: "auto", includeCredits: true });
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("dashboard request timed out")),
    timeoutMs,
  );
  try {
    return await runtime.fetch(
      providerId,
      { sourceMode: "auto", includeCredits: true },
      controller.signal,
    );
  } finally {
    clearTimeout(timer);
  }
};

const dashboardSource = (
  source: Awaited<ReturnType<DashboardCommandRuntime["fetch"]>>["source"],
): DashboardSnapshotDTO["providers"][number]["source"] => {
  switch (source) {
    case "api-token":
      return "api";
    case "local-probe":
      return "cli";
    case "web-dashboard":
      return "web";
    default:
      return source;
  }
};

const failure = (message: string, output: boolean, io: CLIIO): CLICommandResult => {
  if (output)
    io.stdout(
      JSON.stringify({
        provider: "cli",
        source: "cli",
        error: { code: 64, message, kind: "args" },
      }),
    );
  else io.stderr(`Error: ${message}`);
  return { exitCode: 64 as CLIExitCode };
};

const atomicWrite = async (path: string, content: string): Promise<void> => {
  const fs = await import("node:fs/promises");
  const directory = (await import("node:path")).dirname(path);
  const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  await fs.writeFile(temporary, `${content}\n`, { encoding: "utf8", mode: 0o644 });
  await fs.rename(temporary, path).catch(async (error) => {
    await fs.rm(temporary, { force: true });
    throw error;
  });
  void directory;
};

export const runDashboard = async (
  arguments_: readonly string[],
  io: CLIIO,
  runtime: DashboardCommandRuntime,
): Promise<CLICommandResult> => {
  const parsed = parseDashboardArguments(arguments_);
  const structured = arguments_.some(
    (argument, index) =>
      argument === "--json" ||
      argument === "--json-only" ||
      argument === "--format=json" ||
      (argument === "--format" && arguments_[index + 1] === "json"),
  );
  if (!parsed.ok) return failure(parsed.message, structured, io);
  const selected = parsed.value.provider?.toLowerCase();
  const candidates =
    selected === undefined || selected === "all"
      ? runtime.providers
      : runtime.providers.filter((provider) => provider.id === selected);
  if (selected !== undefined && selected !== "all" && candidates.length === 0)
    return failure(`Unknown provider: ${parsed.value.provider}`, structured, io);
  const now = runtime.now?.() ?? Date.now();
  const generatedAt = new Date(now).toISOString();
  const rows: Array<DashboardSnapshotDTO["providers"][number]> = [];
  let exitCode: CLIExitCode = 0;
  for (const provider of candidates) {
    if (provider.status !== "partial") {
      rows.push({
        id: provider.id,
        name: provider.name,
        enabled: false,
        implementationStatus: provider.status,
        source: "auto",
        windows: [],
        error: { code: 1, kind: "provider", message: "Provider is mapped but not ported yet" },
        updatedAt: generatedAt,
      });
      exitCode = 1;
      continue;
    }
    try {
      const outcome = await fetchWithTimeout(runtime, provider.id, parsed.value.timeoutMs);
      rows.push({
        id: provider.id,
        name: provider.name,
        enabled: true,
        implementationStatus: provider.status,
        source: dashboardSource(outcome.source),
        ...(redactIdentity(outcome.snapshot.identity, parsed.value.identity) === undefined
          ? {}
          : { identity: redactIdentity(outcome.snapshot.identity, parsed.value.identity) }),
        windows: windows(outcome.snapshot),
        ...(outcome.snapshot.providerCost === undefined
          ? {}
          : { cost: outcome.snapshot.providerCost }),
        updatedAt: outcome.snapshot.updatedAt,
      });
    } catch (error) {
      rows.push({
        id: provider.id,
        name: provider.name,
        enabled: true,
        implementationStatus: provider.status,
        source: "auto",
        windows: [],
        error: {
          code: 1,
          kind: "provider",
          message: error instanceof Error ? error.message : String(error),
        },
        updatedAt: generatedAt,
      });
      exitCode = 1;
    }
  }
  const payload: DashboardSnapshotDTO = {
    schemaVersion: 1,
    generatedAt,
    staleAfterSeconds: 0,
    providers: rows,
  };
  const json = JSON.stringify(payload, undefined, parsed.value.pretty ? 2 : undefined);
  try {
    if (parsed.value.output === undefined) io.stdout(json);
    else await atomicWrite(parsed.value.output, json);
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error), structured, io);
  }
  return { exitCode };
};

export { parseDashboardArguments };
