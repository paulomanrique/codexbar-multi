import { describe, expect, it } from "vite-plus/test";
import type { LegacyImportInspection } from "@codexbar/core";
import {
  parseLegacyImportArguments,
  runLegacyImport,
  type CLILegacyImportStore,
} from "../src/legacy-import.ts";
import { CLIExitCode, type CLIIO } from "../src/runner.ts";

const inspection: LegacyImportInspection = {
  candidates: [
    {
      kind: "config",
      source: "legacy-config",
      state: "invalid",
      itemCount: 0,
      byteCount: 17,
      reason: "parser leaked password=do-not-print",
    },
    { kind: "history", source: "legacy-history", state: "ready", itemCount: 2, byteCount: 42 },
  ],
  excludedFeatures: ["icloud", "widgetkit", "sparkle", "approvals"],
  sqliteCompatibility: "not-attempted",
};

const args = [
  "--allow-legacy-import",
  "--legacy-root",
  "/tmp/old",
  "--destination-root",
  "/tmp/new",
  "--database-path",
  "/tmp/new/usage.sqlite",
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

describe("legacy-import CLI", () => {
  it("refuses discovery-like invocations without opt-in and mutations without confirmation", async () => {
    const noOptIn = capture();
    await expect(
      runLegacyImport(["inspect", ...args.slice(1)], noOptIn.io, undefined),
    ).resolves.toEqual({
      exitCode: CLIExitCode.usage,
    });
    expect(noOptIn.stderr[0]).toContain("--allow-legacy-import");

    const noConfirmation = capture();
    await expect(
      runLegacyImport(["execute", ...args], noConfirmation.io, undefined),
    ).resolves.toEqual({
      exitCode: CLIExitCode.usage,
    });
    expect(noConfirmation.stderr[0]).toContain("--yes");
  });

  it("emits a sanitized inspection report and does not expose source paths or parser text", async () => {
    const output = capture();
    const store: CLILegacyImportStore = {
      inspect: async () => inspection,
      execute: async () => {
        throw new Error("not used");
      },
      rollback: async () => {
        throw new Error("not used");
      },
    };
    const result = await runLegacyImport(["inspect", ...args, "--json"], output.io, store);
    expect(result.exitCode).toBe(CLIExitCode.success);
    expect(output.stdout[0]).not.toContain("password=do-not-print");
    expect(output.stdout[0]).not.toContain("/tmp/old");
    const report = JSON.parse(output.stdout[0] ?? "") as {
      candidates: readonly Record<string, unknown>[];
    };
    expect(report.candidates[0]).toMatchObject({
      source: "legacy-config",
      reason: "source could not be decoded",
    });
  });

  it("passes an explicit namespace to execute and rollback, preserving ownership", async () => {
    const calls: string[] = [];
    const store: CLILegacyImportStore = {
      inspect: async () => inspection,
      execute: async (options) => {
        calls.push(`execute:${options.importId ?? "generated"}:${options.legacyRoot}`);
        return {
          importId: options.importId ?? "generated",
          status: "completed",
          inspection,
          imported: { config: 1, history: 2, cost: 0, plugins: 0 },
          skipped: [],
        };
      },
      rollback: async (options) => {
        calls.push(`rollback:${options.importId}:${options.legacyRoot}`);
        return {
          importId: options.importId,
          removed: { config: 1, history: 2, cost: 0, plugins: 0 },
          skipped: [],
        };
      },
    };
    const execute = capture();
    expect(
      (
        await runLegacyImport(
          ["execute", ...args, "--import-id=import-a", "--yes"],
          execute.io,
          store,
        )
      ).exitCode,
    ).toBe(CLIExitCode.success);
    const rollback = capture();
    expect(
      (
        await runLegacyImport(
          [
            "rollback",
            ...args,
            "--import-id=import-a",
            "--confirm=legacy-import",
            "--non-interactive",
          ],
          rollback.io,
          store,
        )
      ).exitCode,
    ).toBe(CLIExitCode.success);
    expect(calls).toEqual(["execute:import-a:/tmp/old", "rollback:import-a:/tmp/old"]);
  });

  it("maps host failures to a generic failure without printing exception data", async () => {
    const output = capture();
    const store: CLILegacyImportStore = {
      inspect: async () => {
        throw new Error("cookie=super-secret");
      },
      execute: async () => {
        throw new Error("unused");
      },
      rollback: async () => {
        throw new Error("unused");
      },
    };
    const result = await runLegacyImport(["inspect", ...args], output.io, store);
    expect(result.exitCode).toBe(CLIExitCode.failure);
    expect(output.stderr[0]).toContain("inspection failed");
    expect(output.stderr.join("\n")).not.toContain("super-secret");
  });

  it("requires all source and destination roots explicitly", () => {
    expect(parseLegacyImportArguments(["inspect", "--allow-legacy-import"]).ok).toBe(false);
    expect(parseLegacyImportArguments(["rollback", ...args, "--allow-legacy-import"]).ok).toBe(
      false,
    );
    expect(
      parseLegacyImportArguments(["rollback", ...args, "--import-id=../../outside", "--yes"]).ok,
    ).toBe(false);
  });
});
