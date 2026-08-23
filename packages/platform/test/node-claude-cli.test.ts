import { access, lstat, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import type { ProcessRunnerService } from "@codexbar/core";
import {
  claudeProbeEnvironment,
  claudeProjectDirectoryName,
  cleanupClaudeProbeArtifacts,
  fetchNodeClaudeCliUsage,
  resolveClaudeProbeDirectory,
} from "../src/node-claude-cli.ts";

let capturedAuth:
  | { readonly command: string; readonly args?: readonly string[]; readonly cwd?: string }
  | undefined;

const makeFakeProcessRunner = (response: {
  stdout: string;
  exitCode?: number;
}): ProcessRunnerService => ({
  run: (spec) => {
    capturedAuth = spec;
    return Effect.succeed({
      stdout: new TextEncoder().encode(response.stdout),
      stderr: new Uint8Array(),
      exitCode: response.exitCode ?? 0,
      signal: undefined,
    });
  },
});

const panel = "Current session\n80% left\nCurrent week (all models)\n60% left";

const withProbe = async (run: (probeDirectory: string) => Promise<void>): Promise<void> => {
  const probeDirectory = await mkdtemp(join(tmpdir(), "codexbar-claude-probe-"));
  try {
    await run(probeDirectory);
  } finally {
    await rm(probeDirectory, { recursive: true, force: true });
  }
};

describe("Node Claude CLI probe", () => {
  it("requires an explicit private probe directory", () => {
    expect(() => resolveClaudeProbeDirectory({})).toThrow(/explicit private app-data path/);
    expect(resolveClaudeProbeDirectory({ userDataPath: "/var/app" })).toBe(
      join("/var/app", "ClaudeProbe"),
    );
  });

  it("loggedOut never starts PTY", async () => {
    await withProbe(async (probeDirectory) => {
      capturedAuth = undefined;
      let ptyStarted = false;
      const result = await fetchNodeClaudeCliUsage(
        {
          environment: {},
          processRunner: makeFakeProcessRunner({ stdout: JSON.stringify({ loggedIn: false }) }),
          ptyRunner: {
            start: () => {
              ptyStarted = true;
              return Effect.succeed({} as never);
            },
          },
          probeDirectory,
          restrictDirectory: async () => undefined,
        },
        new AbortController().signal,
      );
      expect(result.loggedIn).toBe(false);
      expect(ptyStarted).toBe(false);
      expect(capturedAuth).toMatchObject({
        args: ["auth", "status", "--json"],
        cwd: probeDirectory,
      });
    });
  });

  it("garbage auth never starts PTY", async () => {
    await withProbe(async (probeDirectory) => {
      let ptyStarted = false;
      const result = await fetchNodeClaudeCliUsage(
        {
          environment: {},
          processRunner: makeFakeProcessRunner({ stdout: "not-json" }),
          ptyRunner: {
            start: () => {
              ptyStarted = true;
              return Effect.succeed({} as never);
            },
          },
          probeDirectory,
          restrictDirectory: async () => undefined,
        },
        new AbortController().signal,
      );
      expect(result.loggedIn).toBe(false);
      expect(ptyStarted).toBe(false);
    });
  });

  it("non-zero auth status never trusts a loggedIn payload or starts PTY", async () => {
    await withProbe(async (probeDirectory) => {
      let ptyStarted = false;
      const result = await fetchNodeClaudeCliUsage(
        {
          environment: {},
          processRunner: makeFakeProcessRunner({
            stdout: JSON.stringify({ loggedIn: true }),
            exitCode: 1,
          }),
          ptyRunner: {
            start: () => {
              ptyStarted = true;
              return Effect.succeed({} as never);
            },
          },
          probeDirectory,
          restrictDirectory: async () => undefined,
        },
        new AbortController().signal,
      );
      expect(result).toMatchObject({ loggedIn: false, exitCode: 1 });
      expect(ptyStarted).toBe(false);
    });
  });

  it("loggedIn starts fake PTY and captures fixed args/env/cwd/dimensions", async () => {
    await withProbe(async (probeDirectory) => {
      const captured: {
        command: string | undefined;
        args: readonly string[] | undefined;
        cwd: string | undefined;
        columns: number | undefined;
        rows: number | undefined;
        env: Record<string, string> | undefined;
        sentUsage: boolean;
        closed: boolean;
      } = {
        command: undefined,
        args: undefined,
        cwd: undefined,
        columns: undefined,
        rows: undefined,
        env: undefined,
        sentUsage: false,
        closed: false,
      };
      const result = await fetchNodeClaudeCliUsage(
        {
          environment: {
            ANTHROPIC_API_KEY: "secret-should-not-forward",
            PATH: "/usr/bin",
            CLAUDE_CLI_PATH: "claude",
            CLAUDE_OAUTH_ACCESS_TOKEN: "tok",
          },
          processRunner: makeFakeProcessRunner({ stdout: JSON.stringify({ loggedIn: true }) }),
          ptyRunner: {
            start: (spec) => {
              captured.command = spec.command;
              captured.args = spec.args;
              captured.cwd = spec.cwd;
              captured.columns = spec.columns;
              captured.rows = spec.rows;
              captured.env = spec.env as Record<string, string>;
              return Effect.succeed({
                write: (input: Uint8Array) => {
                  if (new TextDecoder().decode(input).includes("/usage")) captured.sentUsage = true;
                  return Effect.void;
                },
                read: Effect.succeed(new TextEncoder().encode(panel)),
                resize: () => Effect.void,
                close: Effect.sync(() => {
                  captured.closed = true;
                }),
              });
            },
          },
          probeDirectory,
          restrictDirectory: async () => undefined,
        },
        new AbortController().signal,
      );
      expect(result.loggedIn).toBe(true);
      expect(captured.args).toEqual([
        "--allowed-tools",
        "",
        "--strict-mcp-config",
        "--session-id",
        expect.any(String),
      ]);
      expect(captured.columns).toBe(160);
      expect(captured.rows).toBe(50);
      expect(captured.cwd).toBe(probeDirectory);
      expect(captured.sentUsage).toBe(true);
      expect(captured.env?.DISABLE_AUTOUPDATER).toBe("1");
      expect(captured.env?.ANTHROPIC_API_KEY).toBeUndefined();
      expect(captured.env?.CLAUDE_OAUTH_ACCESS_TOKEN).toBeUndefined();
      expect(captured.closed).toBe(true);
    });
  });

  it("enforces an independent timeout even when PTY read never completes", async () => {
    await withProbe(async (probeDirectory) => {
      let closed = false;
      await expect(
        fetchNodeClaudeCliUsage(
          {
            environment: {},
            processRunner: makeFakeProcessRunner({ stdout: JSON.stringify({ loggedIn: true }) }),
            ptyRunner: {
              start: () =>
                Effect.succeed({
                  write: () => Effect.void,
                  read: Effect.promise(() => new Promise<Uint8Array>(() => undefined)),
                  resize: () => Effect.void,
                  close: Effect.sync(() => {
                    closed = true;
                  }),
                }),
            },
            probeDirectory,
            restrictDirectory: async () => undefined,
            ptyTimeoutMs: 40,
          },
          new AbortController().signal,
        ),
      ).rejects.toThrow(/timed out/);
      expect(closed).toBe(true);
    });
  });

  it("abort closes the session after tree termination", async () => {
    await withProbe(async (probeDirectory) => {
      let closed = false;
      const controller = new AbortController();
      const pending = fetchNodeClaudeCliUsage(
        {
          environment: {},
          processRunner: makeFakeProcessRunner({ stdout: JSON.stringify({ loggedIn: true }) }),
          ptyRunner: {
            start: () =>
              Effect.succeed({
                write: () => Effect.void,
                read: Effect.promise(
                  () =>
                    new Promise<Uint8Array>((resolve) => {
                      setTimeout(() => resolve(new Uint8Array()), 5_000);
                    }),
                ),
                resize: () => Effect.void,
                close: Effect.sync(() => {
                  closed = true;
                }),
              }),
          },
          probeDirectory,
          restrictDirectory: async () => undefined,
        },
        controller.signal,
      );
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(closed).toBe(true);
    });
  });

  it("sanitized env does not forward ANTHROPIC_* or token-shaped keys", () => {
    const env = claudeProbeEnvironment({
      ANTHROPIC_API_KEY: "k",
      ANTHROPIC_AUTH_TOKEN: "t",
      PATH: "/bin",
      HOME: "/home/x",
      CLAUDE_OAUTH_ACCESS_TOKEN: "tok",
      OPENAI_API_KEY: "openai",
      REFRESH_TOKEN: "refresh",
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_OAUTH_ACCESS_TOKEN).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.REFRESH_TOKEN).toBeUndefined();
    expect(env.PATH).toBe("/bin");
    expect(env.DISABLE_AUTOUPDATER).toBe("1");
  });

  it("encodes Claude Code project directory names including utf16 emoji", () => {
    expect(
      claudeProjectDirectoryName("/Users/test/Library/Application Support/CodexBar/ClaudeProbe"),
    ).toBe("-Users-test-Library-Application-Support-CodexBar-ClaudeProbe");
    expect(claudeProjectDirectoryName("/Users/test/emoji_\u{1F600}/ClaudeProbe")).toBe(
      "-Users-test-emoji----ClaudeProbe",
    );
  });

  it("cleanup lstats, skips symlinks, and never recursively deletes", async () => {
    const root = await mkdtemp(join(tmpdir(), "codexbar-claude-cleanup-"));
    try {
      const probeDirectory = join(root, "probe");
      const claudeRoot = join(root, "claude");
      const projectDir = join(claudeRoot, "projects", claudeProjectDirectoryName(probeDirectory));
      const unrelated = join(claudeRoot, "projects", "unrelated-project");
      await mkdir(projectDir, { recursive: true });
      await mkdir(unrelated, { recursive: true });
      await writeFile(join(projectDir, "probe-session.jsonl"), "{}\n");
      await writeFile(join(projectDir, "keep.txt"), "keep");
      await writeFile(join(unrelated, "user-session.jsonl"), "{}\n");
      const outside = join(root, "outside.jsonl");
      await writeFile(outside, "nope");
      await symlink(outside, join(projectDir, "linked.jsonl"));
      const removed = await cleanupClaudeProbeArtifacts(probeDirectory, {
        CLAUDE_CONFIG_DIR: claudeRoot,
        HOME: claudeRoot,
      });
      expect(removed.map((path) => path.split("/").at(-1))).toEqual(["probe-session.jsonl"]);
      await expect(access(join(projectDir, "keep.txt"))).resolves.toBeUndefined();
      await expect(access(join(unrelated, "user-session.jsonl"))).resolves.toBeUndefined();
      expect((await lstat(join(projectDir, "linked.jsonl"))).isSymbolicLink()).toBe(true);
      await expect(access(projectDir)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
