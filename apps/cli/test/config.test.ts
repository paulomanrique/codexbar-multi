import { describe, expect, it } from "vite-plus/test";
import { makeDefaultCodexBarConfig, type PersistedCodexBarConfig } from "@codexbar/core";
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

const configWithSecret = (): PersistedCodexBarConfig => {
  const config = makeDefaultCodexBarConfig();
  return {
    ...config,
    providers: config.providers.map((provider) =>
      provider.id === "openai"
        ? { ...provider, enabled: false, apiKey: "sk-test-only", extensions: {} }
        : provider,
    ),
  };
};

const runtime = (
  initial = configWithSecret(),
  load: () => Promise<PersistedCodexBarConfig | undefined> = async () => initial,
): CLIProviderRuntime & { current: PersistedCodexBarConfig } => {
  let current = initial;
  const value: CLIProviderRuntime & { current: PersistedCodexBarConfig } = {
    current,
    providers: [
      { id: "codex", name: "Codex", status: "partial", isPrimaryProvider: true },
      { id: "openai", name: "OpenAI", status: "partial" },
    ],
    fetch: async () => {
      throw new Error("not used");
    },
    config: {
      path: "/tmp/codexbar-multi/config.json",
      load,
      save: async (next) => {
        current = next;
        value.current = next;
      },
    },
  };
  return value;
};

describe("CodexBar Multi config CLI", () => {
  it("validates and dumps a redacted normalized config", async () => {
    const target = runtime();
    const validate = capture();
    const validated = await runCLI({
      argv: ["config", "validate"],
      io: validate.io,
      runtime: target,
    });
    expect(validated.exitCode).toBe(0);
    expect(validate.stdout.some((line) => line.startsWith("[WARNING]"))).toBe(true);

    const dump = capture();
    const dumped = await runCLI({
      argv: ["config", "dump", "--format", "json"],
      io: dump.io,
      runtime: target,
    });
    expect(dumped.exitCode).toBe(0);
    expect(dump.stdout[0]).not.toContain("sk-test-only");
    const dumpedValue = JSON.parse(dump.stdout[0] ?? "") as {
      providers: readonly { id: string; apiKey?: string }[];
    };
    expect(dumpedValue.providers.find((provider) => provider.id === "openai")).toMatchObject({
      id: "openai",
      apiKey: "[REDACTED]",
    });
  });

  it("lists provider status and changes the shared config atomically through the injected store", async () => {
    const target = runtime();
    const listed = capture();
    const listResult = await runCLI({
      argv: ["config", "providers", "--format", "json"],
      io: listed.io,
      runtime: target,
    });
    expect(listResult.exitCode).toBe(0);
    expect(JSON.parse(listed.stdout[0] ?? "")).toContainEqual({
      provider: "openai",
      displayName: "OpenAI",
      enabled: false,
      defaultEnabled: false,
    });

    const enabled = capture();
    const enableResult = await runCLI({
      argv: ["config", "enable", "--provider", "openai"],
      io: enabled.io,
      runtime: target,
    });
    expect(enableResult.exitCode).toBe(0);
    expect(enabled.stdout).toEqual(["Config: enabled OpenAI"]);
    expect(target.current.providers.find((provider) => provider.id === "openai")?.enabled).toBe(
      true,
    );
  });

  it("rejects unknown options, duplicate flags, and secret reveal attempts", async () => {
    const target = runtime();
    for (const argv of [
      ["config", "dump", "--unknown"],
      ["config", "dump", "--pretty", "--pretty"],
      ["config", "dump", "--show-secrets"],
    ]) {
      const output = capture();
      const result = await runCLI({ argv, io: output.io, runtime: target });
      expect(result.exitCode).toBe(64);
      expect(output.stderr[0]).toContain("Error:");
    }
  });

  it("uses defaults for an absent config and reports malformed config as a config failure", async () => {
    const absent = runtime(makeDefaultCodexBarConfig(), async () => undefined);
    const output = capture();
    const result = await runCLI({
      argv: ["config", "providers", "--format", "json"],
      io: output.io,
      runtime: absent,
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(output.stdout[0] ?? "")).toContainEqual(
      expect.objectContaining({ provider: "codex", enabled: true }),
    );

    const malformed = runtime(configWithSecret(), async () => {
      throw new Error("malformed");
    });
    const failed = capture();
    const failedResult = await runCLI({
      argv: ["config", "validate", "--json"],
      io: failed.io,
      runtime: malformed,
    });
    expect(failedResult.exitCode).toBe(1);
    expect(JSON.parse(failed.stdout[0] ?? "")).toMatchObject({
      error: { kind: "config", code: 1 },
    });
  });
});
