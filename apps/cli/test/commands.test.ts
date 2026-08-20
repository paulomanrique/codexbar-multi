import { describe, expect, it } from "vite-plus/test";
import type { ProviderFetchOutcome } from "@codexbar/core";
import type { ProviderId, UsageSnapshot } from "@codexbar/contracts";
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
