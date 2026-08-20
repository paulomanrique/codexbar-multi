import { describe, expect, it } from "vite-plus/test";
import type { ProviderFetchOutcome } from "@codexbar/core";
import type { ProviderId, UsageSnapshot } from "@codexbar/contracts";
import { runCookie, type CLICookieStore } from "../src/cookie.ts";
import { runPlugins, type CLIPluginStore } from "../src/plugins.ts";
import { runCLI, type CLIIO, type CLIProviderRuntime } from "../src/runner.ts";

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

const snapshot: UsageSnapshot = {
  primary: { usedPercent: 25, windowMinutes: 60, resetsAt: "2026-08-20T15:00:00Z" },
  details: [{ rows: [{ label: "secret", value: "never-print-this-token" }] }],
  identity: { accountEmail: "secret@example.com", accountId: "secret-account" },
  updatedAt: "2026-08-20T12:00:00Z",
};

const runtime = (extra: Partial<CLIProviderRuntime> = {}): CLIProviderRuntime => ({
  providers: [{ id: "codex", name: "Codex", status: "partial" }],
  fetch: async (): Promise<ProviderFetchOutcome> => ({
    snapshot,
    source: "api-token",
    strategyId: "test",
    attempts: [],
  }),
  ...extra,
});

describe("CLI cookie refresh", () => {
  it("requires exactly one target and fails closed without a host adapter", async () => {
    const output = capture();
    expect((await runCookie([], output.io, runtime())).exitCode).toBe(64);
    expect((await runCookie(["--all", "--provider", "codex"], output.io, runtime())).exitCode).toBe(
      64,
    );
    const unavailable = capture();
    expect((await runCookie(["--all", "--json"], unavailable.io, runtime())).exitCode).toBe(69);
    expect(JSON.parse(unavailable.stdout[0] ?? "")).toMatchObject({ cookie: "refresh" });
  });

  it("refreshes the injected provider sequentially and forwards prompt acknowledgement", async () => {
    const calls: Array<{ provider: ProviderId; allowKeychainPrompt: boolean }> = [];
    const cookies: CLICookieStore = {
      refreshableProviders: ["codex"],
      refresh: async (provider, options) => {
        calls.push({ provider, ...options });
        return { provider, status: "refreshed", message: "Browser cookie refreshed." };
      },
    };
    const output = capture();
    expect(
      (
        await runCookie(
          ["refresh", "--provider", "codex", "--allow-keychain-prompt", "--json"],
          output.io,
          runtime({ cookies }),
        )
      ).exitCode,
    ).toBe(0);
    expect(calls).toEqual([{ provider: "codex", allowKeychainPrompt: true }]);
    expect(JSON.parse(output.stdout[0] ?? "")).toEqual([
      { provider: "codex", status: "refreshed", message: "Browser cookie refreshed." },
    ]);
  });

  it("does not call an adapter for unsupported providers", async () => {
    let called = false;
    const output = capture();
    const cookies: CLICookieStore = {
      refreshableProviders: [],
      refresh: async () => {
        called = true;
        return { provider: "claude", status: "refreshed", message: "unexpected" };
      },
    };
    expect(
      (await runCookie(["--provider", "codex", "--json"], output.io, runtime({ cookies })))
        .exitCode,
    ).toBe(1);
    expect(called).toBe(false);
    expect(output.stdout[0]).not.toContain("unexpected");
  });

  it("rejects a refresh result bound to a different provider", async () => {
    const output = capture();
    const cookies: CLICookieStore = {
      refreshableProviders: ["codex"],
      refresh: async () => ({
        provider: "claude",
        status: "refreshed",
        message: "must not be trusted",
      }),
    };
    expect(
      (await runCookie(["--provider", "codex", "--json"], output.io, runtime({ cookies })))
        .exitCode,
    ).toBe(1);
    expect(output.stdout[0]).not.toContain("must not be trusted");
  });
});

const plugin = {
  id: "sample-plugin",
  name: "Sample Plugin",
  language: "typescript" as const,
  path: "/private/plugin.ts",
  capabilities: [],
  cookieDomains: [],
  approvalStatus: "approved" as const,
};

describe("CLI user plugins", () => {
  const store: CLIPluginStore = {
    list: async () => ({
      plugins: [plugin],
      invalidFiles: [{ fileName: "broken.ts", error: "malformed source with secret=do-not-print" }],
    }),
    fetch: async () => ({ plugin, snapshot }),
  };

  it("lists deterministically and exposes no plugin source secret", async () => {
    const output = capture();
    expect(
      (await runPlugins(["list", "--json", "--pretty"], output.io, runtime({ plugins: store })))
        .exitCode,
    ).toBe(1);
    const payload = JSON.parse(output.stdout[0] ?? "") as {
      plugins: unknown[];
      invalidFiles: unknown[];
    };
    expect(payload.plugins).toHaveLength(1);
    expect(payload.invalidFiles).toHaveLength(1);
    expect(output.stdout[0]).not.toContain("do-not-print");
  });

  it("requires approval and rejects browser-cookie plugins before execution", async () => {
    let fetches = 0;
    const pending: CLIPluginStore = {
      ...store,
      list: async () => ({
        plugins: [{ ...plugin, approvalStatus: "needs-approval" }],
        invalidFiles: [],
      }),
      fetch: async () => {
        fetches += 1;
        return { plugin, snapshot };
      },
    };
    const pendingOutput = capture();
    expect(
      (
        await runPlugins(
          ["fetch", "sample-plugin", "--json"],
          pendingOutput.io,
          runtime({ plugins: pending }),
        )
      ).exitCode,
    ).toBe(69);
    expect(fetches).toBe(0);
    const browserOutput = capture();
    const browser: CLIPluginStore = {
      ...store,
      list: async () => ({
        plugins: [{ ...plugin, capabilities: ["browser-cookies"] }],
        invalidFiles: [],
      }),
    };
    expect(
      (
        await runPlugins(
          ["fetch", "sample-plugin", "--json"],
          browserOutput.io,
          runtime({ plugins: browser }),
        )
      ).exitCode,
    ).toBe(69);
    expect(fetches).toBe(0);
  });

  it("renders only bounded usage fields and never identity or detail values", async () => {
    const output = capture();
    expect(
      (
        await runPlugins(
          ["fetch", "sample-plugin", "--json"],
          output.io,
          runtime({
            plugins: { ...store, list: async () => ({ plugins: [plugin], invalidFiles: [] }) },
          }),
        )
      ).exitCode,
    ).toBe(0);
    const payload = JSON.parse(output.stdout[0] ?? "") as { usage: Record<string, unknown> };
    expect(payload.usage).toMatchObject({ primary: { usedPercent: 25 } });
    expect(output.stdout[0]).not.toContain("secret@example.com");
    expect(output.stdout[0]).not.toContain("never-print-this-token");
  });

  it("rejects approval drift after fetch and sanitizes terminal control characters", async () => {
    const output = capture();
    const drifting: CLIPluginStore = {
      list: async () => ({ plugins: [plugin], invalidFiles: [] }),
      fetch: async () => ({
        plugin: { ...plugin, id: "different-plugin" },
        snapshot,
      }),
    };
    expect(
      (
        await runPlugins(
          ["fetch", "sample-plugin", "--json"],
          output.io,
          runtime({ plugins: drifting }),
        )
      ).exitCode,
    ).toBe(1);
    expect(output.stdout[0]).not.toContain("different-plugin");

    const terminal = capture();
    await runPlugins(
      ["list"],
      terminal.io,
      runtime({
        plugins: {
          ...drifting,
          list: async () => ({
            plugins: [{ ...plugin, name: "safe\u001b[31mname" }],
            invalidFiles: [{ fileName: "bad\nfile.ts", error: "ignored" }],
          }),
        },
      }),
    );
    expect(terminal.stdout[0]).not.toContain("\u001b");
    expect(terminal.stdout[0]).not.toContain("bad\nfile");

    const fetchTerminal = capture();
    await runPlugins(
      ["fetch", "sample-plugin"],
      fetchTerminal.io,
      runtime({
        plugins: {
          list: async () => ({ plugins: [plugin], invalidFiles: [] }),
          fetch: async () => ({ plugin: { ...plugin, name: "safe\u001b[31mname" }, snapshot }),
        },
      }),
    );
    expect(fetchTerminal.stdout[0]).not.toContain("\u001b");
  });

  it("does not silently execute when no store is injected", async () => {
    const output = capture();
    expect((await runPlugins(["list"], output.io, runtime())).exitCode).toBe(69);
    expect(output.stderr[0]).toContain("unavailable");
  });
});

describe("CLI command dispatch", () => {
  it("routes cookie and plugins through explicit command handlers", async () => {
    const cookie = capture();
    expect(
      (await runCLI({ argv: ["cookie", "--all"], io: cookie.io, runtime: runtime() })).exitCode,
    ).toBe(69);
    const plugins = capture();
    expect(
      (await runCLI({ argv: ["plugins", "list"], io: plugins.io, runtime: runtime() })).exitCode,
    ).toBe(69);
  });
});
