import { describe, expect, it } from "vite-plus/test";
import {
  makeDefaultCodexBarConfig,
  type ProviderFetchOutcome,
  type UsageSnapshot,
} from "@codexbar/core";
import type { ClaudeSwapAccountSnapshot } from "@codexbar/providers";
import {
  activateClaudeSwapAccount,
  claudeSwapActivatableSlot,
  claudeSwapProcessEnvironment,
} from "../src/claude-swap.ts";
import { CLIExitCode, runCLI, type CLIIO, type CLIProviderRuntime } from "../src/runner.ts";

const snapshot: UsageSnapshot = {
  primary: {
    usedPercent: 37.5,
    windowMinutes: 300,
    resetsAt: "2026-03-10T17:00:00Z",
    resetDescription: "resets in 5h",
  },
  secondary: { usedPercent: 72, windowMinutes: 10_080 },
  details: [{ title: "Account", rows: [{ label: "Plan", value: "Pro" }] }],
  providerCost: {
    used: 2.5,
    limit: 10,
    currencyCode: "USD",
    updatedAt: "2026-03-10T12:00:00Z",
  },
  updatedAt: "2026-03-10T12:00:00Z",
  identity: { providerId: "codex", accountEmail: "person@example.com", loginMethod: "OAuth" },
};

const outcome: ProviderFetchOutcome = {
  snapshot,
  source: "web",
  strategyId: "codex.web",
  attempts: [{ strategyId: "codex.web", source: "web", available: true }],
};

const capture = (): {
  readonly io: CLIIO;
  readonly stdout: string[];
  readonly stderr: string[];
} => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
    stdout,
    stderr,
  };
};

const runtime = (fetch: CLIProviderRuntime["fetch"] = async () => outcome): CLIProviderRuntime => ({
  providers: [
    { id: "codex", name: "Codex", status: "partial", isPrimaryProvider: true },
    { id: "claude", name: "Claude", status: "partial", isPrimaryProvider: true },
  ],
  fetch,
});

describe("CodexBar Multi cards CLI", () => {
  const claudeSwapConfig = () => {
    const base = makeDefaultCodexBarConfig();
    return {
      ...base,
      providers: base.providers.map((provider) =>
        provider.id !== "claude"
          ? provider
          : {
              ...provider,
              extensions: {
                ...provider.extensions,
                claudeSwapEnabled: true,
                claudeSwapExecutablePath: "  '/safe/cswap' ",
              },
            },
      ),
    };
  };

  it("does not pass provider credentials to the Claude Swap helper", () => {
    expect(
      claudeSwapProcessEnvironment({
        PATH: "/safe/bin",
        HOME: "/safe/home",
        SYSTEMROOT: "C:\\Windows",
        OPENAI_API_KEY: "secret-openai",
        ANTHROPIC_API_KEY: "secret-claude",
        CODEX_ACCESS_TOKEN: "secret-codex",
      }),
    ).toEqual({ PATH: "/safe/bin", HOME: "/safe/home", SYSTEMROOT: "C:\\Windows" });
  });

  it("accepts only a current, eligible opaque Claude Swap slot for activation", () => {
    expect(
      claudeSwapActivatableSlot({
        id: { source: "claude-swap", opaqueId: "2" },
        provider: "claude",
        displayLabel: "Account 2",
        isActive: false,
        canActivate: true,
        sourceLabel: "claude-swap",
      }),
    ).toBe(2);
    expect(() =>
      claudeSwapActivatableSlot({
        id: { source: "claude-swap", opaqueId: "../../2" },
        provider: "claude",
        displayLabel: "Account",
        isActive: false,
        canActivate: true,
        sourceLabel: "claude-swap",
      }),
    ).toThrow("invalid source-issued slot");
  });

  it("requires the explicit Claude Swap opt-in before requesting an activation", async () => {
    const account: ClaudeSwapAccountSnapshot = {
      id: { source: "claude-swap", opaqueId: "2" },
      provider: "claude",
      displayLabel: "Account 2",
      isActive: false,
      canActivate: true,
      sourceLabel: "claude-swap",
    };
    const activate = async () => ({
      switched: true,
      toAccountNumber: 2,
      reason: "selected",
    });
    await expect(
      activateClaudeSwapAccount(
        { list: async () => [], activate },
        { enabled: false, executablePath: "/safe/cswap", showSingleAccount: false },
        account,
      ),
    ).rejects.toThrow("not enabled");
    await expect(
      activateClaudeSwapAccount(
        { list: async () => [], activate },
        { enabled: true, executablePath: "/safe/cswap", showSingleAccount: false },
        account,
      ),
    ).resolves.toMatchObject({ toAccountNumber: 2 });
  });

  it("renders a deterministic JSON card from the shared usage snapshot", async () => {
    const output = capture();
    const result = await runCLI({
      argv: ["cards", "--provider", "codex", "--format", "json", "--pretty"],
      io: output.io,
      runtime: runtime(),
    });
    expect(result.exitCode).toBe(CLIExitCode.success);
    const cards = JSON.parse(output.stdout[0] ?? "") as readonly Record<string, any>[];
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      provider: "codex",
      title: "Codex",
      sourceLabel: "web",
      accountLine: "person@example.com",
      infoLines: ["Login: OAuth", "Account", "Plan: Pro"],
      extraLines: ["Cost: 2.5 USD of 10"],
    });
    expect(cards[0]?.metrics).toContainEqual(
      expect.objectContaining({
        label: "Primary",
        remainingPercent: 62.5,
        resetText: "resets in 5h",
      }),
    );
    expect(output.stdout[0]).not.toContain("apiKey");
  });

  it("fails explicitly while provider status probes are not connected", async () => {
    const output = capture();
    const result = await runCLI({
      argv: ["cards", "--provider", "codex", "--status"],
      io: output.io,
      runtime: runtime(),
    });
    expect(result.exitCode).toBe(CLIExitCode.failure);
    expect(output.stderr[0]).toContain("status probes are not connected");
  });

  it("renders eligible Claude Swap accounts in active-slot order without ambient Claude", async () => {
    const output = capture();
    const accounts: readonly ClaudeSwapAccountSnapshot[] = [
      {
        id: { source: "claude-swap", opaqueId: "2" },
        provider: "claude",
        displayLabel: "active@example.test",
        isActive: true,
        canActivate: false,
        snapshot: {
          primary: { usedPercent: 20, windowMinutes: 300 },
          details: [],
          updatedAt: "2026-03-10T12:00:00Z",
        },
        sourceLabel: "claude-swap",
      },
      {
        id: { source: "claude-swap", opaqueId: "1" },
        provider: "claude",
        displayLabel: "work@example.test",
        isActive: false,
        canActivate: true,
        error: "Token expired. Switch to this account in claude-swap to refresh it.",
        sourceLabel: "claude-swap",
      },
    ];
    const result = await runCLI({
      argv: ["cards", "--provider", "claude", "--format", "json"],
      io: output.io,
      runtime: {
        ...runtime(async () => {
          throw new Error("ambient Claude must not run");
        }),
        config: {
          path: "/tmp/codexbar-multi/config.json",
          load: async () => claudeSwapConfig(),
          save: async () => undefined,
        },
        claudeSwap: {
          list: async ({ executablePath }) => {
            expect(executablePath).toBe("/safe/cswap");
            return accounts;
          },
        },
      },
    });
    expect(result.exitCode).toBe(CLIExitCode.success);
    expect(JSON.parse(output.stdout[0] ?? "")).toMatchObject([
      {
        provider: "claude",
        sourceLabel: "claude-swap",
        accountLine: "active@example.test",
        isActive: true,
      },
      {
        accountLine: "work@example.test",
        statusLine: "Token expired. Switch to this account in claude-swap to refresh it.",
      },
    ]);
  });

  it("keeps the ambient Claude path for explicit source intent and reports adapter failure separately", async () => {
    const sourceOutput = capture();
    let adapterCalls = 0;
    await runCLI({
      argv: ["cards", "--provider", "claude", "--source", "oauth", "--format", "json"],
      io: sourceOutput.io,
      runtime: {
        ...runtime(),
        config: {
          path: "/tmp/codexbar-multi/config.json",
          load: async () => claudeSwapConfig(),
          save: async () => undefined,
        },
        claudeSwap: { list: async () => ((adapterCalls += 1), []) },
      },
    });
    expect(adapterCalls).toBe(0);

    const errorOutput = capture();
    const result = await runCLI({
      argv: ["cards", "--provider", "claude", "--format", "json"],
      io: errorOutput.io,
      runtime: {
        ...runtime(),
        config: {
          path: "/tmp/codexbar-multi/config.json",
          load: async () => claudeSwapConfig(),
          save: async () => undefined,
        },
        claudeSwap: { list: async () => Promise.reject(new Error("\u001b[31mreader failed")) },
      },
    });
    expect(result.exitCode).toBe(CLIExitCode.failure);
    expect(JSON.parse(errorOutput.stdout[0] ?? "")).toContainEqual(
      expect.objectContaining({
        account: "claude-swap",
        error: expect.objectContaining({ message: "reader failed" }),
      }),
    );
  });

  it("supports brief text output and forwards source/account options to the runtime", async () => {
    let seenContext: unknown;
    const output = capture();
    const result = await runCLI({
      argv: [
        "cards",
        "--provider",
        "codex",
        "--brief",
        "--no-color",
        "--source",
        "cli",
        "--account",
        "work",
        "--web-timeout",
        "12",
      ],
      io: output.io,
      runtime: runtime(async (_provider, context) => {
        seenContext = context;
        return { ...outcome, source: "cli" };
      }),
    });
    expect(result.exitCode).toBe(0);
    expect(output.stdout[0]).toContain("Provider             Usage");
    expect(output.stdout[0]).toContain("Codex");
    expect(seenContext).toMatchObject({
      sourceMode: "cli",
      metadata: { account: "work", webTimeoutSeconds: "12" },
    });
  });

  it("uses the Swift default enablement when the shared config file is absent", async () => {
    const output = capture();
    const fetched: string[] = [];
    const base = runtime(async (provider) => {
      fetched.push(provider);
      return outcome;
    });
    const result = await runCLI({
      argv: ["cards", "--format", "json"],
      io: output.io,
      runtime: {
        ...base,
        config: {
          path: "/tmp/codexbar-multi/config.json",
          load: async () => undefined,
          save: async () => undefined,
        },
      },
    });
    expect(result.exitCode).toBe(0);
    expect(fetched).toEqual(["codex"]);
  });

  it("fails closed on invalid source/account combinations and preserves provider errors in JSON", async () => {
    for (const argv of [
      ["cards", "--source", "invalid"],
      ["cards", "--all-accounts", "--account", "work"],
      ["cards", "--account-index", "0"],
    ]) {
      const output = capture();
      const result = await runCLI({ argv, io: output.io, runtime: runtime() });
      expect(result.exitCode).toBe(CLIExitCode.usage);
      expect(output.stderr[0]).toContain("Error:");
    }

    const output = capture();
    const result = await runCLI({
      argv: ["cards", "--provider", "codex", "--json"],
      io: output.io,
      runtime: runtime(async () => {
        throw new Error("not authenticated");
      }),
    });
    expect(result.exitCode).toBe(CLIExitCode.failure);
    expect(JSON.parse(output.stdout[0] ?? "")[0]).toMatchObject({
      provider: "codex",
      error: { message: "not authenticated", kind: "provider" },
    });
  });
});
