import { describe, expect, it } from "vite-plus/test";
import type { ProviderFetchOutcome } from "@codexbar/core";
import type { PersistedCodexBarConfig } from "@codexbar/core";
import { makeDefaultCodexBarConfig } from "@codexbar/core";
import type { UsageSnapshot } from "@codexbar/contracts";
import { runGuard } from "../src/guard.ts";
import { runHooks } from "../src/hooks.ts";
import {
  renderSessionsTable,
  runSessions,
  runSessionsFocus,
  type AgentSession,
} from "../src/sessions.ts";
import type { CLIConfigStore } from "../src/config.ts";
import type { CLIIO, CLIProviderRuntime } from "../src/runner.ts";

const capture = (): {
  readonly io: CLIIO;
  readonly stdout: string[];
  readonly stderr: string[];
} => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: { stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value) },
    stdout,
    stderr,
  };
};
const snapshot = (primary: number, secondary?: number): UsageSnapshot => ({
  primary: { usedPercent: primary },
  ...(secondary === undefined ? {} : { secondary: { usedPercent: secondary } }),
  details: [],
  updatedAt: "2026-08-20T12:00:00Z",
});
const outcome = (snapshot_: UsageSnapshot): ProviderFetchOutcome => ({
  snapshot: snapshot_,
  source: "api-token",
  strategyId: "test",
  attempts: [],
});
const runtime = (fetch: CLIProviderRuntime["fetch"]): CLIProviderRuntime => ({
  providers: [{ id: "codex", name: "Codex", status: "partial" }],
  fetch,
});

describe("CLI guard", () => {
  it("returns the Swift-compatible blocked decision and exit code", async () => {
    const output = capture();
    const result = await runGuard(
      ["--provider", "codex", "--min-remaining", "20", "--json"],
      output.io,
      runtime(async () => outcome(snapshot(90))),
    );
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(output.stdout[0] ?? "")).toMatchObject({
      provider: "codex",
      remainingPercent: 10,
      decision: "blocked",
      exitCode: 1,
    });
  });
  it("aborts a timed out fetch and supports fail-open", async () => {
    let aborted = false;
    const output = capture();
    const result = await runGuard(
      ["--provider", "codex", "--timeout", "0.001", "--fail-open", "--json"],
      output.io,
      runtime(
        (_id, _context, signal) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => {
                aborted = true;
                reject(new Error("aborted"));
              },
              { once: true },
            );
          }),
      ),
    );
    expect(result.exitCode).toBe(0);
    expect(aborted).toBe(true);
    expect(JSON.parse(output.stdout[0] ?? "")).toMatchObject({
      decision: "unknown",
      unavailableReason: "timeout",
      exitCode: 0,
    });
  });
  it("does not pass synthetic windows as free quota", async () => {
    const output = capture();
    const result = await runGuard(
      ["--provider", "codex", "--json"],
      output.io,
      runtime(async () =>
        outcome({ ...snapshot(0), primary: { usedPercent: 0, isSyntheticPlaceholder: true } }),
      ),
    );
    expect(result.exitCode).toBe(69);
    expect(JSON.parse(output.stdout[0] ?? "")).toMatchObject({
      decision: "unknown",
      unavailableReason: "window-unavailable",
    });
  });
});

describe("CLI hooks", () => {
  const store = (
    initial: PersistedCodexBarConfig,
  ): CLIConfigStore & { readonly saved: PersistedCodexBarConfig[] } => {
    const saved: PersistedCodexBarConfig[] = [];
    return {
      path: "/tmp/codexbar-test.json",
      load: async () => initial,
      save: async (value) => {
        saved.push(value);
      },
      saved,
    };
  };
  it("lists and toggles hooks through the shared config store", async () => {
    const initial = { ...makeDefaultCodexBarConfig(), hooks: { enabled: false, events: [] } };
    const config = store(initial);
    const listed = capture();
    expect((await runHooks(["list", "--json"], listed.io, { config })).exitCode).toBe(0);
    expect(JSON.parse(listed.stdout[0] ?? "")).toEqual({ enabled: false, events: [] });
    const enabled = capture();
    expect((await runHooks(["enable"], enabled.io, { config })).exitCode).toBe(0);
    expect(config.saved[0]?.hooks?.enabled).toBe(true);
  });
  it("fails closed when execution is not connected and never launches a configured path", async () => {
    const config = store({
      ...makeDefaultCodexBarConfig(),
      hooks: {
        enabled: true,
        events: [
          {
            id: "one",
            enabled: true,
            event: "quota_reached",
            executable: "/tmp/should-not-run",
            arguments: [],
            timeoutSeconds: 1,
          },
        ],
      },
    });
    const output = capture();
    const result = await runHooks(["test", "quota_reached", "--provider", "codex"], output.io, {
      config,
      providers: [{ id: "codex" }],
    });
    expect(result.exitCode).toBe(1);
    expect(output.stderr[0]).toContain("no executable was launched");
  });
  it("does not silently implement watch", async () => {
    const config = store(makeDefaultCodexBarConfig());
    const output = capture();
    const result = await runHooks(["watch"], output.io, { config });
    expect(result.exitCode).toBe(1);
    expect(output.stderr[0]).toContain("not ported");
  });

  it("accepts Windows absolute hook paths and passes only the bounded event contract", async () => {
    const config = store({
      ...makeDefaultCodexBarConfig(),
      hooks: {
        enabled: true,
        events: [
          {
            id: "windows",
            enabled: true,
            event: "quota_reached",
            executable: "C:\\Tools\\quota-hook.exe",
            arguments: ["--machine"],
            timeoutSeconds: 2,
          },
        ],
      },
    });
    const requests: unknown[] = [];
    const output = capture();
    const result = await runHooks(
      ["test", "quota_reached", "--provider", "CODEX", "--json"],
      output.io,
      {
        config,
        providers: [{ id: "codex" }],
        runHook: async (request) => {
          requests.push(request);
          return { stdout: "ok" };
        },
      },
    );
    expect(result.exitCode).toBe(0);
    expect(requests).toMatchObject([
      {
        executable: "C:\\Tools\\quota-hook.exe",
        arguments: ["--machine"],
        environment: {
          CODEXBAR_EVENT: "quota_reached",
          CODEXBAR_PROVIDER: "codex",
        },
      },
    ]);
  });
});

describe("CLI sessions", () => {
  const sessions: readonly AgentSession[] = [
    {
      id: "s1",
      state: "active",
      provider: "codex",
      source: "local",
      projectName: "demo",
      lastActivityAt: "2026-08-20T11:59:00Z",
    },
    { id: "s2", state: "idle", provider: "pi", dialect: "pi", source: "file" },
  ];
  it("keeps legacy JSON filtering and v2 expansion", async () => {
    const output = capture();
    const runtime = {
      scanSessions: async () => sessions,
      now: () => Date.parse("2026-08-20T12:00:00Z"),
    };
    expect((await runSessions(["--json"], output.io, runtime)).exitCode).toBe(0);
    expect(JSON.parse(output.stdout[0] ?? "")).toHaveLength(1);
    const v2 = capture();
    await runSessions(["--json-v2"], v2.io, runtime);
    expect(JSON.parse(v2.stdout[0] ?? "")).toHaveLength(2);
  });
  it("renders deterministic activity ages and refuses focus without a platform adapter", async () => {
    expect(renderSessionsTable(sessions, Date.parse("2026-08-20T12:00:00Z"))).toContain("1m");
    const output = capture();
    expect(
      (await runSessionsFocus(["s1"], output.io, { scanSessions: async () => sessions })).exitCode,
    ).toBe(2);
    expect(output.stderr[0]).toContain("not ported");
  });

  it("focuses a scanned session through the explicit platform adapter", async () => {
    const output = capture();
    const focused: AgentSession[] = [];
    const result = await runSessionsFocus(["s1"], output.io, {
      scanSessions: async () => sessions,
      focusSession: async (session) => {
        focused.push(session);
        return "focused";
      },
    });
    expect(result.exitCode).toBe(0);
    expect(focused.map((session) => session.id)).toEqual(["s1"]);
  });

  it("redacts scanner failures from the user-facing sessions command", async () => {
    const output = capture();
    const result = await runSessions([], output.io, {
      scanSessions: async () => {
        throw new Error("/private/session.jsonl should not be displayed");
      },
    });
    expect(result.exitCode).toBe(1);
    expect(output.stderr).toEqual(["Error: Unable to scan sessions."]);
  });
});
