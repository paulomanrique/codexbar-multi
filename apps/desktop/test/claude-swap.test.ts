import { describe, expect, it } from "vite-plus/test";
import {
  InfrastructureError,
  type PersistedCodexBarConfig,
  type PrivateFileStoreService,
  type ProcessRunnerService,
} from "@codexbar/core";
import { Effect } from "effect";

import {
  DesktopClaudeSwapController,
  desktopClaudeSwapAccounts,
  desktopClaudeSwapSettings,
} from "../src/main/claude-swap.ts";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

const config = (): PersistedCodexBarConfig => ({
  version: 1,
  providers: [
    {
      id: "claude",
      enabled: true,
      extensions: { claudeSwapEnabled: true, claudeSwapExecutablePath: " /safe/cswap " },
    },
  ],
});

const list = (active: number) => ({
  schemaVersion: 1,
  activeAccountNumber: active,
  accounts: [
    { number: 1, email: "one@example.test", active: active === 1, usageStatus: "ok" },
    { number: 2, email: "two@example.test", active: active === 2, usageStatus: "ok" },
  ],
});

const privateFiles = (): PrivateFileStoreService => ({
  read: () => Effect.succeed(undefined),
  writeAtomic: () => Effect.void,
  remove: () => Effect.void,
});

describe("desktop Claude Swap controller", () => {
  it("requires the Claude provider opt-in and hides source helper errors from overview", async () => {
    expect(desktopClaudeSwapSettings({ ...config(), providers: [] })).toEqual({
      enabled: false,
      executablePath: "",
    });
    const failing: ProcessRunnerService = {
      run: () =>
        Effect.fail(new InfrastructureError("run process", "/private/token must not escape")),
    };
    const controller = new DesktopClaudeSwapController({
      config,
      processes: failing,
      files: privateFiles(),
      retentionPath: "/private/retained.json",
    });
    await expect(controller.refreshForOverview()).resolves.toBeUndefined();
  });

  it("normalizes the configured Claude Swap executable path in the desktop host", () => {
    expect(
      desktopClaudeSwapSettings({
        ...config(),
        providers: [
          {
            id: "claude",
            enabled: true,
            extensions: {
              claudeSwapEnabled: true,
              claudeSwapExecutablePath: " ~/bin/cswap ",
            },
          },
        ],
      }).executablePath,
    ).toMatch(/[/\\]bin[/\\]cswap$/u);
  });

  it("rechecks a fresh eligible opaque ID, uses fixed commands, and reconciles active cards", async () => {
    let active = 1;
    const calls: unknown[] = [];
    const processes: ProcessRunnerService = {
      run: (spec) => {
        calls.push(spec);
        if (spec.args?.[0] === "--switch-to") active = Number(spec.args[1]);
        return Effect.succeed({
          exitCode: 0,
          signal: undefined,
          stdout:
            spec.args?.[0] === "--switch-to"
              ? bytes({
                  schemaVersion: 1,
                  switched: true,
                  from: { number: 1 },
                  to: { number: 2 },
                  reason: "selected",
                })
              : bytes(list(active)),
          stderr: new Uint8Array(),
        });
      },
    };
    const controller = new DesktopClaudeSwapController({
      config,
      processes,
      files: privateFiles(),
      retentionPath: "/private/retained.json",
    });
    await expect(controller.activate("2")).resolves.toEqual({ accountId: "2", switched: true });
    expect(calls).toEqual([
      { command: "/safe/cswap", args: ["--list", "--json"], timeoutMs: 30_000 },
      { command: "/safe/cswap", args: ["--switch-to", "2", "--json"] },
      { command: "/safe/cswap", args: ["--list", "--json"], timeoutMs: 30_000 },
    ]);
    await expect(controller.refreshForOverview()).resolves.toMatchObject([
      { id: "2", active: true, canActivate: false },
      { id: "1", active: false, canActivate: true },
    ]);
    await expect(controller.activate("not-listed")).rejects.toThrow("not available");
    expect(
      calls.filter((call) => (call as { args?: readonly string[] }).args?.[0] === "--switch-to"),
    ).toHaveLength(1);
  });

  it("keeps renderer account IDs opaque while preserving activation eligibility", () => {
    expect(
      desktopClaudeSwapAccounts([
        {
          id: { source: "claude-swap", opaqueId: "source-account" },
          provider: "claude",
          displayLabel: "Work",
          isActive: false,
          canActivate: true,
          sourceLabel: "claude-swap",
        },
      ]),
    ).toEqual([
      { id: "source-account", label: "Work", active: false, canActivate: true, windows: [] },
    ]);
  });

  it("fails closed when settings change after the fresh listing but before activation", async () => {
    let reads = 0;
    const original = config();
    const changed: PersistedCodexBarConfig = {
      ...original,
      providers: original.providers.map((provider) =>
        provider.id === "claude"
          ? {
              ...provider,
              extensions: { ...provider.extensions, claudeSwapExecutablePath: "/other/cswap" },
            }
          : provider,
      ),
    };
    const commands: string[][] = [];
    const controller = new DesktopClaudeSwapController({
      config: () => (++reads <= 2 ? original : changed),
      processes: {
        run: (spec) => {
          commands.push([spec.command, ...(spec.args ?? [])]);
          return Effect.succeed({
            exitCode: 0,
            signal: undefined,
            stdout: bytes(list(1)),
            stderr: new Uint8Array(),
          });
        },
      },
      files: privateFiles(),
      retentionPath: "/private/retained.json",
    });

    await expect(controller.activate("2")).rejects.toThrow("settings changed");
    expect(commands).toEqual([["/safe/cswap", "--list", "--json"]]);
  });
});
