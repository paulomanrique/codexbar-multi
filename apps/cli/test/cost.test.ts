import { describe, expect, it } from "vite-plus/test";
import type { CostUsageRecord } from "@codexbar/core";
import { CLIExitCode, runCLI, type CLIIO, type CLIProviderRuntime } from "../src/runner.ts";

const now = Date.parse("2026-03-10T12:00:00.000Z");
const records: readonly CostUsageRecord[] = [
  {
    providerId: "codex",
    recordedAt: Date.parse("2026-03-10T09:00:00.000Z"),
    inputTokens: 100,
    outputTokens: 25,
    costUsd: 0.12,
  },
  {
    providerId: "codex",
    recordedAt: Date.parse("2026-03-09T09:00:00.000Z"),
    inputTokens: 200,
    outputTokens: 50,
    costUsd: 0.2,
  },
  {
    providerId: "codex",
    recordedAt: Date.parse("2025-01-01T09:00:00.000Z"),
    inputTokens: 9_000,
    outputTokens: 1_000,
    costUsd: 9,
  },
];

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

const runtime = (): CLIProviderRuntime => ({
  providers: [
    { id: "codex", name: "Codex", status: "partial", isPrimaryProvider: true },
    { id: "claude", name: "Claude", status: "unported", isPrimaryProvider: true },
    { id: "openai", name: "OpenAI", status: "partial" },
  ],
  fetch: async () => {
    throw new Error("not used");
  },
  costs: {
    list: async (providerId, since) =>
      records.filter((record) => record.providerId === providerId && record.recordedAt >= since),
  },
  now: () => now,
});

describe("CodexBar Multi cost CLI", () => {
  it("aggregates the shared cost history with Swift-compatible JSON fields", async () => {
    const output = capture();
    const result = await runCLI({
      argv: ["cost", "--provider", "codex", "--days", "2", "--format", "json", "--pretty"],
      io: output.io,
      runtime: runtime(),
    });
    expect(result.exitCode).toBe(CLIExitCode.success);
    const payload = JSON.parse(output.stdout[0] ?? "") as readonly Record<string, any>[];
    expect(payload).toHaveLength(1);
    expect(payload[0]).toMatchObject({
      provider: "codex",
      source: "local",
      historyDays: 2,
      sessionTokens: 125,
      sessionCostUSD: 0.12,
      last30DaysTokens: 375,
      last30DaysCostUSD: 0.32,
      totals: { inputTokens: 300, outputTokens: 75, totalTokens: 375, totalCost: 0.32 },
    });
    expect(payload[0]?.daily).toHaveLength(2);
  });

  it("supports text, TOON, and JSONL without exposing paths or secrets", async () => {
    const text = capture();
    const textResult = await runCLI({
      argv: ["cost", "codex", "--days=2"],
      io: text.io,
      runtime: runtime(),
    });
    expect(textResult.exitCode).toBe(0);
    expect(text.stdout[0]).toContain("Codex Cost (API-rate estimate)");
    expect(text.stdout[0]).toContain("Today: $0.12 · 125 tokens");

    const toon = capture();
    const toonResult = await runCLI({
      argv: ["cost", "--provider=codex", "--days=2", "--format=toon"],
      io: toon.io,
      runtime: runtime(),
    });
    expect(toonResult.exitCode).toBe(0);
    expect(toon.stdout[0]).toContain("provider: codex");

    const jsonl = capture();
    const jsonlResult = await runCLI({
      argv: ["cost", "--provider=codex", "--days=2", "--format=jsonl"],
      io: jsonl.io,
      runtime: runtime(),
    });
    expect(jsonlResult.exitCode).toBe(0);
    expect(jsonl.stdout).toHaveLength(1);
    expect(JSON.parse(jsonl.stdout[0] ?? "")).toMatchObject({ provider: "codex" });
  });

  it("rejects invalid ranges and unsupported providers with strict CLI exit codes", async () => {
    for (const argv of [
      ["cost", "--days", "0"],
      ["cost", "--days", "366"],
      ["cost", "--format", "yaml"],
    ]) {
      const output = capture();
      const result = await runCLI({ argv, io: output.io, runtime: runtime() });
      expect(result.exitCode).toBe(CLIExitCode.usage);
      expect(output.stderr[0]).toContain("Error:");
    }
    const unsupported = capture();
    const unsupportedResult = await runCLI({
      argv: ["cost", "--provider", "openai", "--format", "json"],
      io: unsupported.io,
      runtime: runtime(),
    });
    expect(unsupportedResult.exitCode).toBe(CLIExitCode.failure);
    expect(JSON.parse(unsupported.stdout[0] ?? "")[0]).toMatchObject({ provider: "cli" });

    for (const argv of [
      ["cost", "codex", "--refresh"],
      ["cost", "codex", "--provider-native-only"],
      ["cost", "codex", "--group-by", "project"],
    ]) {
      const output = capture();
      const result = await runCLI({ argv, io: output.io, runtime: runtime() });
      expect(result.exitCode).toBe(CLIExitCode.failure);
      expect(output.stderr[0]).toContain("requires the JSONL cost scanner");
    }
  });
});
