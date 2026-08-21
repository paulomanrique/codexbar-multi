import { describe, expect, it } from "vite-plus/test";
import type { ProviderFetchOutcome } from "@codexbar/core";
import { makeDefaultCodexBarConfig } from "@codexbar/core";
import type { ProviderId, UsageSnapshot } from "@codexbar/contracts";
import type { ClaudeSwapAccountSnapshot } from "@codexbar/providers";
import { runCache, type CLICacheStore } from "../src/cache.ts";
import { runDashboard } from "../src/dashboard.ts";
import { runDiagnose } from "../src/diagnose.ts";
import { CLIExitCode, type CLIIO, type CLIProviderRuntime } from "../src/runner.ts";

const snapshot: UsageSnapshot = {
  primary: { usedPercent: 25, windowMinutes: 300, resetsAt: "2026-08-20T15:00:00Z" },
  details: [{ rows: [{ label: "Session", value: "secret-detail-value" }] }],
  updatedAt: "2026-08-20T12:00:00Z",
  identity: {
    providerId: "codex",
    accountEmail: "secret@example.com",
    accountId: "account-secret",
    loginMethod: "OAuth",
  },
};

const outcome = (providerId: ProviderId): ProviderFetchOutcome => ({
  snapshot,
  source: "api-token",
  strategyId: `${providerId}.test`,
  attempts: [],
});

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

const runtime = (cache?: CLICacheStore): CLIProviderRuntime => ({
  providers: [
    { id: "codex", name: "Codex", status: "partial", isPrimaryProvider: true },
    { id: "claude", name: "Claude", status: "unported" },
  ],
  fetch: async (providerId) => outcome(providerId),
  ...(cache === undefined ? {} : { cache }),
});

describe("CLI dashboard, cache, and diagnose", () => {
  it("emits a dashboard-v1 snapshot with windows and redacted identity", async () => {
    const output = capture();
    const result = await runDashboard(
      ["--provider", "codex", "--identity", "redacted", "--pretty"],
      output.io,
      runtime(),
    );
    expect(result.exitCode).toBe(CLIExitCode.success);
    const payload = JSON.parse(output.stdout[0] ?? "") as { providers: Array<Record<string, any>> };
    expect(payload.providers[0]).toMatchObject({
      id: "codex",
      source: "api",
      windows: [{ kind: "primary", remainingPercent: 75 }],
    });
    expect(payload.providers[0]?.identity).toMatchObject({
      accountEmail: "<redacted>",
      accountId: "<redacted>",
      loginMethod: "OAuth",
    });
    expect(output.stdout[0]).not.toContain("secret@example.com");
  });

  it("reports mapped-but-unported providers without attempting a fetch", async () => {
    let fetches = 0;
    const output = capture();
    const result = await runDashboard(["--provider", "claude"], output.io, {
      ...runtime(),
      fetch: async () => {
        fetches += 1;
        return outcome("claude");
      },
    });
    expect(result.exitCode).toBe(CLIExitCode.failure);
    expect(fetches).toBe(0);
    expect(JSON.parse(output.stdout[0] ?? "").providers[0]).toMatchObject({
      implementationStatus: "unported",
      error: { kind: "provider" },
    });
  });

  it("attaches opt-in Claude Swap accounts to the Claude dashboard row and redacts labels", async () => {
    const output = capture();
    const base = makeDefaultCodexBarConfig();
    const config = {
      ...base,
      providers: base.providers.map((provider) =>
        provider.id !== "claude"
          ? provider
          : {
              ...provider,
              enabled: true,
              extensions: {
                ...provider.extensions,
                claudeSwapEnabled: true,
                claudeSwapExecutablePath: "/safe/cswap",
              },
            },
      ),
    };
    const accounts: readonly ClaudeSwapAccountSnapshot[] = [
      {
        id: { source: "claude-swap", opaqueId: "2" },
        provider: "claude",
        displayLabel: "private@example.test",
        isActive: true,
        canActivate: false,
        snapshot,
        sourceLabel: "claude-swap",
      },
    ];
    const result = await runDashboard(
      ["--provider", "claude", "--identity", "redacted"],
      output.io,
      {
        ...runtime(),
        providers: [{ id: "claude", name: "Claude", status: "partial" }],
        config: { path: "/tmp/config.json", load: async () => config, save: async () => undefined },
        claudeSwap: {
          list: async ({ executablePath }) => {
            expect(executablePath).toBe("/safe/cswap");
            return accounts;
          },
        },
      },
    );
    expect(result.exitCode).toBe(CLIExitCode.success);
    const payload = JSON.parse(output.stdout[0] ?? "") as { providers: Array<Record<string, any>> };
    expect(payload.providers[0]?.accounts).toMatchObject([
      { id: "claude-swap:2", label: "<redacted>", active: true },
    ]);
    expect(output.stdout[0]).not.toContain("private@example.test");
  });

  it("keeps an adapter failure row-local without suppressing ambient Claude usage", async () => {
    const output = capture();
    const base = makeDefaultCodexBarConfig();
    const config = {
      ...base,
      providers: base.providers.map((provider) =>
        provider.id !== "claude"
          ? provider
          : {
              ...provider,
              enabled: true,
              extensions: {
                ...provider.extensions,
                claudeSwapEnabled: true,
                claudeSwapExecutablePath: "/safe/cswap",
              },
            },
      ),
    };
    const result = await runDashboard(["--provider", "claude"], output.io, {
      ...runtime(),
      providers: [{ id: "claude", name: "Claude", status: "partial" }],
      config: { path: "/tmp/config.json", load: async () => config, save: async () => undefined },
      claudeSwap: { list: async () => Promise.reject(new Error("\u001b[31mstore locked")) },
    });
    expect(result.exitCode).toBe(CLIExitCode.success);
    expect(JSON.parse(output.stdout[0] ?? "").providers[0]).toMatchObject({
      windows: [{ kind: "primary" }],
      accountsError: "store locked",
    });
  });

  it("keeps shared-mailbox dashboard account aliases distinct by opaque source slot", async () => {
    const output = capture();
    const base = makeDefaultCodexBarConfig();
    const config = {
      ...base,
      providers: base.providers.map((provider) =>
        provider.id !== "claude"
          ? provider
          : {
              ...provider,
              enabled: true,
              extensions: {
                ...provider.extensions,
                claudeSwapEnabled: true,
                claudeSwapExecutablePath: "/safe/cswap",
              },
            },
      ),
    };
    const accounts: readonly ClaudeSwapAccountSnapshot[] = [
      {
        id: { source: "claude-swap", opaqueId: "1" },
        provider: "claude",
        displayLabel: "Work",
        accountEmail: "shared@example.test",
        isActive: false,
        canActivate: true,
        sourceLabel: "claude-swap",
      },
      {
        id: { source: "claude-swap", opaqueId: "2" },
        provider: "claude",
        displayLabel: "shared@example.test · Sendbird",
        accountEmail: "shared@example.test",
        isActive: true,
        canActivate: false,
        sourceLabel: "claude-swap",
      },
    ];
    await runDashboard(["--provider", "claude"], output.io, {
      ...runtime(),
      providers: [{ id: "claude", name: "Claude", status: "partial" }],
      config: { path: "/tmp/config.json", load: async () => config, save: async () => undefined },
      claudeSwap: { list: async () => accounts },
    });
    expect(JSON.parse(output.stdout[0] ?? "").providers[0]?.accounts).toMatchObject([
      { id: "claude-swap:1", label: "Work", identity: { accountEmail: "shared@example.test" } },
      {
        id: "claude-swap:2",
        label: "shared@example.test · Sendbird",
        identity: { accountEmail: "shared@example.test" },
      },
    ]);
  });

  it("clears requested cache scopes and preserves provider scoping", async () => {
    const calls: string[] = [];
    const cache: CLICacheStore = {
      clearCookies: async (provider) => {
        calls.push(`cookies:${provider ?? "all"}`);
        return { cleared: 2 };
      },
      clearCost: async () => {
        calls.push("cost");
        return { cleared: 1 };
      },
    };
    const output = capture();
    const result = await runCache(
      ["clear", "--cookies", "--provider", "codex", "--format", "json"],
      output.io,
      runtime(cache),
    );
    expect(result.exitCode).toBe(CLIExitCode.success);
    expect(calls).toEqual(["cookies:codex"]);
    expect(JSON.parse(output.stdout[0] ?? "")[0]).toMatchObject({
      cache: "cookies",
      provider: "codex",
      cleared: 2,
    });
  });

  it("rejects cache provider scoping for cost and fails closed when no store is injected", async () => {
    const scoped = capture();
    expect((await runCache(["--cost", "--provider", "codex"], scoped.io, runtime())).exitCode).toBe(
      CLIExitCode.usage,
    );
    expect(scoped.stderr[0]).toContain("only scopes cookie");
    const unavailable = capture();
    expect((await runCache(["--all"], unavailable.io, runtime())).exitCode).toBe(
      CLIExitCode.failure,
    );
    expect(unavailable.stderr[0]).toContain("unavailable");
  });

  it("diagnoses provider results using a redacted JSON export", async () => {
    const output = capture();
    const result = await runDiagnose(
      ["--provider", "codex", "--format", "json"],
      output.io,
      runtime(),
    );
    expect(result.exitCode).toBe(CLIExitCode.success);
    const payload = JSON.parse(output.stdout[0] ?? "") as Record<string, any>;
    expect(payload).toMatchObject({
      provider: "codex",
      source: "api-token",
      usage: {
        windows: [{ label: "primary", usedPercent: 25 }],
        detailSectionCount: 1,
        providerCostPresent: false,
      },
    });
    expect(output.stdout[0]).not.toContain("secret@example.com");
    expect(output.stdout[0]).not.toContain("account-secret");
    expect(output.stdout[0]).not.toContain("secret-detail-value");
  });

  it("aborts a dashboard provider request when its deadline expires", async () => {
    let aborted = false;
    const output = capture();
    const result = await runDashboard(["--provider", "codex", "--timeout", "0.001"], output.io, {
      ...runtime(),
      fetch: (_provider, _context, signal) =>
        new Promise((_, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    });
    expect(result.exitCode).toBe(CLIExitCode.failure);
    expect(aborted).toBe(true);
  });

  it("rejects invalid diagnostic formats and provider names", async () => {
    const format = capture();
    expect((await runDiagnose(["--format", "text"], format.io, runtime())).exitCode).toBe(
      CLIExitCode.usage,
    );
    const unknown = capture();
    expect((await runDiagnose(["--provider", "unknown"], unknown.io, runtime())).exitCode).toBe(
      CLIExitCode.usage,
    );
    expect(unknown.stdout[0]).toContain("Unknown provider");
  });
});
