import type { CLICommandResult, CLIExitCode, CLIIO } from "./runner.ts";

export type AgentSession = {
  readonly id: string;
  readonly state: "active" | "idle";
  readonly provider: string;
  readonly dialect?: string;
  readonly source: string;
  readonly projectName?: string;
  readonly lastActivityAt?: string;
  readonly startedAt?: string;
  readonly [key: string]: unknown;
};

export interface SessionsCommandRuntime {
  readonly scanSessions?: (signal: AbortSignal) => Promise<readonly AgentSession[]>;
  readonly focusSession?: (
    session: AgentSession,
    signal: AbortSignal,
  ) => Promise<"focused" | "activated" | "failed">;
  readonly now?: () => number;
}

const output = (
  args: readonly string[],
): { readonly json: boolean; readonly v2: boolean; readonly pretty: boolean } => ({
  json: args.includes("--json") || args.includes("--json-v2"),
  v2: args.includes("--json-v2"),
  pretty: args.includes("--pretty"),
});

const usage = (io: CLIIO, message: string): CLICommandResult => {
  io.stderr(`Error: ${message}`);
  return { exitCode: 64 as CLIExitCode };
};

const age = (session: AgentSession, now: number): string => {
  const raw = session.lastActivityAt ?? session.startedAt;
  if (raw === undefined) return "now";
  const seconds = Math.max(0, Math.floor((now - Date.parse(raw)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
};

export const renderSessionsTable = (sessions: readonly AgentSession[], now: number): string => {
  if (sessions.length === 0) return "No agent sessions found.";
  const rows = sessions.map((session) => [
    session.state,
    session.provider,
    session.dialect ?? "—",
    session.source,
    session.projectName ?? "—",
    age(session, now),
    session.id,
  ]);
  const headers = ["STATE", "PROVIDER", "DIALECT", "SOURCE", "PROJECT", "ACTIVITY", "ID"];
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const render = (row: readonly string[]): string =>
    row.map((value, index) => value.padEnd(widths[index] ?? value.length)).join("  ");
  return [render(headers), ...rows.map(render)].join("\n");
};

export const runSessions = async (
  args: readonly string[],
  io: CLIIO,
  runtime: SessionsCommandRuntime,
): Promise<CLICommandResult> => {
  const out = output(args);
  const unsupported = args.filter((arg) => !["--json", "--json-v2", "--pretty"].includes(arg));
  if (unsupported.length > 0) return usage(io, `Unknown sessions option ${unsupported[0]}`);
  if (runtime.scanSessions === undefined) {
    io.stderr(
      "Error: sessions scanning is not ported yet; no process or filesystem scan was attempted",
    );
    return { exitCode: 1 };
  }
  const controller = new AbortController();
  let sessions: readonly AgentSession[];
  try {
    sessions = await runtime.scanSessions(controller.signal);
  } catch (error) {
    io.stderr(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return { exitCode: 1 };
  }
  const filtered = out.v2
    ? sessions
    : sessions.filter((session) => session.provider === "codex" || session.provider === "claude");
  if (out.json) io.stdout(JSON.stringify(filtered, undefined, out.pretty ? 2 : undefined));
  else io.stdout(renderSessionsTable(sessions, runtime.now?.() ?? Date.now()));
  return { exitCode: 0 };
};

export const runSessionsFocus = async (
  args: readonly string[],
  io: CLIIO,
  runtime: SessionsCommandRuntime,
): Promise<CLICommandResult> => {
  if (args.length !== 1 || args[0] === undefined || args[0].startsWith("-"))
    return usage(io, "Missing session id.");
  if (runtime.scanSessions === undefined || runtime.focusSession === undefined) {
    io.stderr(
      "Error: session focus is not ported yet; no process or window operation was attempted",
    );
    return { exitCode: 2 };
  }
  const controller = new AbortController();
  const sessions = await runtime.scanSessions(controller.signal);
  const session = sessions.find((candidate) => candidate.id === args[0]);
  if (session === undefined) {
    io.stderr(`Unknown session: ${args[0]}`);
    return { exitCode: 1 };
  }
  const result = await runtime.focusSession(session, controller.signal);
  return { exitCode: result === "focused" || result === "activated" ? 0 : 2 };
};
