import { describe, expect, it } from "vite-plus/test";
import { ClassifiedFetchFailure, type ProviderFetchOutcome } from "@codexbar/core";
import type { ProviderId, UsageSnapshot } from "@codexbar/contracts";
import {
  CLIExitCode,
  readNonInteractiveSecret,
  runCLI,
  type CLIIO,
  type CLIProviderRuntime,
} from "../src/runner.ts";
import { encodeToon } from "../src/toon.ts";

const snapshot: UsageSnapshot = {
  primary: { usedPercent: 7, windowMinutes: 300 },
  secondary: { usedPercent: 42.5, windowMinutes: 10_080 },
  details: [
    {
      title: "Usage summary",
      rows: [
        { label: "Requests", value: "120" },
        { label: "Tokens", value: "4.2k" },
      ],
    },
  ],
  updatedAt: "2026-02-02T02:40:00Z",
  identity: { providerId: "openai", accountEmail: "dev@example.com", loginMethod: "OAuth" },
};

const outcome = (providerId: ProviderId, source = "api-token"): ProviderFetchOutcome => ({
  snapshot,
  source,
  strategyId: `${providerId}.api`,
  attempts: [{ strategyId: `${providerId}.api`, source, available: true }],
});

const runtime = (
  fetch: (providerId: ProviderId) => Promise<ProviderFetchOutcome> = async (providerId) =>
    outcome(providerId),
): CLIProviderRuntime => ({
  providers: [
    { id: "openai", name: "OpenAI", status: "partial" },
    { id: "t3chat", name: "T3 Chat", status: "partial" },
    { id: "claude", name: "Claude", status: "unported" },
  ],
  fetch: (providerId) => fetch(providerId),
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

describe("CodexBar Multi CLI runner", () => {
  it("accepts bounded non-interactive secret input and fails closed for terminals or oversized input", async () => {
    async function* input(value: string): AsyncGenerator<string> {
      yield value;
    }
    await expect(readNonInteractiveSecret(input("value\r\n"), false)).resolves.toBe("value");
    await expect(readNonInteractiveSecret(input("value"), true)).resolves.toBeUndefined();
    await expect(
      readNonInteractiveSecret(input("x".repeat(64 * 1024 + 1)), false),
    ).resolves.toBeUndefined();
  });

  it("prints top-level help without initializing a provider request", async () => {
    const output = capture();
    const result = await runCLI({ argv: ["--help"], io: output.io, runtime: runtime() });
    expect(result.exitCode).toBe(CLIExitCode.success);
    expect(output.stdout[0]).toContain("Usage: codexbar-multi");
    expect(output.stderr).toEqual([]);
  });

  it("runs implicit usage and retains positional-provider compatibility", async () => {
    const implicit = capture();
    const implicitResult = await runCLI({ argv: ["openai"], io: implicit.io, runtime: runtime() });
    expect(implicitResult.exitCode).toBe(CLIExitCode.success);
    expect(implicit.stdout.join("\n")).toContain("OpenAI (api-token)");

    const explicit = capture();
    const result = await runCLI({
      argv: ["usage", "openai", "--json"],
      io: explicit.io,
      runtime: runtime(),
    });
    expect(result.exitCode).toBe(CLIExitCode.success);
    const payload = JSON.parse(explicit.stdout[0] ?? "") as readonly Record<string, unknown>[];
    expect(payload).toHaveLength(1);
    expect(payload[0]).toMatchObject({ provider: "openai", source: "api-token" });
  });

  it("passes cancellation to usage fetches and records successful plan history best effort", async () => {
    const cancellation = new AbortController();
    const recorded: Array<{ providerId: ProviderId; outcome: ProviderFetchOutcome }> = [];
    const output = capture();
    const result = await runCLI({
      argv: ["usage", "openai", "--json"],
      io: output.io,
      signal: cancellation.signal,
      runtime: {
        ...runtime(),
        fetch: async (providerId, _context, signal) => {
          expect(signal).toBe(cancellation.signal);
          return outcome(providerId);
        },
        recordPlanUtilization: async (providerId, value, signal) => {
          expect(signal).toBe(cancellation.signal);
          recorded.push({ providerId, outcome: value });
          throw new Error("history unavailable");
        },
      },
    });
    expect(result.exitCode).toBe(CLIExitCode.success);
    expect(recorded).toEqual([{ providerId: "openai", outcome: outcome("openai") }]);
    const serialized = output.stdout[0] ?? "";
    expect(JSON.parse(serialized)[0]).toMatchObject({ provider: "openai" });
    expect(serialized).not.toContain("historyOwner");
  });

  it("uses the same JSON payload for JSON and TOON, including Swift snapshot wire keys", async () => {
    const json = capture();
    await runCLI({
      argv: ["usage", "--provider", "openai", "--format", "json", "--pretty"],
      io: json.io,
      runtime: runtime(),
    });
    const value = JSON.parse(json.stdout[0] ?? "") as readonly Record<string, unknown>[];
    expect(value[0]).toMatchObject({ provider: "openai", source: "api-token" });
    expect(value[0]?.usage).toMatchObject({
      primary: { usedPercent: 7 },
      secondary: { usedPercent: 42.5 },
      identity: { providerID: "openai", accountEmail: "dev@example.com" },
    });

    const toon = capture();
    await runCLI({
      argv: ["usage", "--provider=openai", "--format=toon"],
      io: toon.io,
      runtime: runtime(),
    });
    expect(toon.stdout[0]).toBe(encodeToon(value as never));
    expect(toon.stdout[0]).toBe(
      `
[1]:
  - provider: openai
    source: api-token
    usage:
      primary:
        usedPercent: 7
        windowMinutes: 300
      secondary:
        usedPercent: 42.5
        windowMinutes: 10080
      tertiary: null
      details[1]:
        - title: Usage summary
          rows[2]{label,value}:
            Requests,"120"
            Tokens,4.2k
      updatedAt: "2026-02-02T02:40:00Z"
      identity:
        providerID: openai
        accountEmail: dev@example.com
        loginMethod: OAuth
      accountEmail: dev@example.com
      loginMethod: OAuth`.trim(),
    );
  });

  it("honors --format over JSON shortcuts and supports all provider selection", async () => {
    const output = capture();
    const result = await runCLI({
      argv: ["usage", "--provider", "all", "--json", "--format", "text"],
      io: output.io,
      runtime: runtime(),
    });
    expect(result.exitCode).toBe(CLIExitCode.failure);
    expect(output.stdout.join("\n")).toContain("OpenAI (api-token)");
    expect(output.stderr.join("\n")).toContain("mapped but not ported");
  });

  it("selects upstream primary providers for both even when they are not first in the roster", async () => {
    const selected: ProviderId[] = [];
    const output = capture();
    const primaryRuntime: CLIProviderRuntime = {
      providers: [
        { id: "openai", name: "OpenAI", status: "partial" },
        { id: "t3chat", name: "T3 Chat", status: "partial" },
        { id: "codex", name: "Codex", status: "partial", isPrimaryProvider: true },
        { id: "clinepass", name: "ClinePass", status: "partial", isPrimaryProvider: true },
      ],
      fetch: async (providerId) => {
        selected.push(providerId);
        return outcome(providerId);
      },
    };
    const result = await runCLI({
      argv: ["usage", "--provider", "both", "--json"],
      io: output.io,
      runtime: primaryRuntime,
    });
    expect(result.exitCode).toBe(CLIExitCode.success);
    expect(selected).toEqual(["codex", "clinepass"]);

    const fallbackSelected: ProviderId[] = [];
    const fallback = await runCLI({
      argv: ["usage", "--provider", "both", "--json"],
      io: capture().io,
      runtime: {
        providers: [
          { id: "openai", name: "OpenAI", status: "partial" },
          { id: "t3chat", name: "T3 Chat", status: "partial" },
          { id: "codex", name: "Codex", status: "partial" },
        ],
        fetch: async (providerId) => {
          fallbackSelected.push(providerId);
          return outcome(providerId);
        },
      },
    });
    expect(fallback.exitCode).toBe(CLIExitCode.success);
    expect(fallbackSelected).toEqual(["openai", "t3chat"]);
  });

  it("emits classified provider failures as machine-readable error payloads", async () => {
    const output = capture();
    const result = await runCLI({
      argv: ["usage", "openai", "--json-only"],
      io: output.io,
      runtime: runtime(async () => {
        throw new ClassifiedFetchFailure("missing-credential", "Missing credential OPENAI_API_KEY");
      }),
    });
    expect(result.exitCode).toBe(CLIExitCode.failure);
    expect(JSON.parse(output.stdout[0] ?? "")).toEqual([
      {
        provider: "openai",
        source: "auto",
        error: {
          code: CLIExitCode.failure,
          message: "Missing credential OPENAI_API_KEY",
          kind: "provider",
        },
      },
    ]);
  });

  it("uses the upstream usage exit code for invalid selection and lists providers deterministically", async () => {
    const invalid = capture();
    const invalidResult = await runCLI({
      argv: ["usage", "unknown", "--format", "toon"],
      io: invalid.io,
      runtime: runtime(),
    });
    expect(invalidResult.exitCode).toBe(CLIExitCode.usage);
    expect(invalid.stdout[0]).toContain("kind: args");

    const providers = capture();
    const providerResult = await runCLI({
      argv: ["providers", "--format", "json", "--pretty"],
      io: providers.io,
      runtime: runtime(),
    });
    expect(providerResult.exitCode).toBe(CLIExitCode.success);
    expect(JSON.parse(providers.stdout[0] ?? "")).toEqual([
      { id: "openai", name: "OpenAI", status: "partial" },
      { id: "t3chat", name: "T3 Chat", status: "partial" },
      { id: "claude", name: "Claude", status: "unported" },
    ]);
  });

  it("rejects missing option values, unknown flags, and invalid formats with usage exit 64", async () => {
    for (const argv of [
      ["usage", "--provider"],
      ["usage", "--format"],
      ["usage", "--provider="],
      ["usage", "--format="],
      ["usage", "--unknown"],
      ["providers", "--unknown"],
      ["usage", "--format", "yaml"],
      ["providers", "--format", "toon"],
    ]) {
      const output = capture();
      const result = await runCLI({ argv, io: output.io, runtime: runtime() });
      expect(result.exitCode).toBe(CLIExitCode.usage);
      expect(output.stdout).toHaveLength(0);
      expect(output.stderr.join("\n")).toMatch(/Error:|Missing value|Unknown option|Invalid value/);
    }
  });

  it("preserves a requested structured format for parser failures", async () => {
    const toon = capture();
    const toonResult = await runCLI({
      argv: ["usage", "--format", "toon", "--unknown"],
      io: toon.io,
      runtime: runtime(),
    });
    expect(toonResult.exitCode).toBe(CLIExitCode.usage);
    expect(toon.stdout[0]).toContain("kind: args");
    expect(toon.stderr).toHaveLength(0);

    const json = capture();
    const jsonResult = await runCLI({
      argv: ["usage", "--json-only", "--format", "yaml"],
      io: json.io,
      runtime: runtime(),
    });
    expect(jsonResult.exitCode).toBe(CLIExitCode.usage);
    expect(JSON.parse(json.stdout[0] ?? "")[0]).toMatchObject({
      error: { code: CLIExitCode.usage, kind: "args" },
    });
    expect(json.stderr).toHaveLength(0);
  });

  it("maps classified and adapter errors to the Swift exit-code contract", async () => {
    const cases: Array<{ readonly error: unknown; readonly code: CLIExitCode }> = [
      {
        error: new ClassifiedFetchFailure("parse-failure", "response could not be parsed"),
        code: CLIExitCode.parseError,
      },
      {
        error: Object.assign(new Error("codex executable not found"), { code: "ENOENT" }),
        code: CLIExitCode.binaryNotFound,
      },
      {
        error: Object.assign(new Error("provider request timed out"), { name: "TimeoutError" }),
        code: CLIExitCode.timeout,
      },
      { error: new Error("provider exploded"), code: CLIExitCode.failure },
    ];

    for (const { error, code } of cases) {
      const output = capture();
      const result = await runCLI({
        argv: ["usage", "openai", "--json-only"],
        io: output.io,
        runtime: runtime(async () => {
          throw error;
        }),
      });
      expect(result.exitCode).toBe(code);
      expect(JSON.parse(output.stdout[0] ?? "")[0]?.error?.code).toBe(code);
    }
  });

  it("matches the exact Swift TOON fixture, including account/version and mixed detail rows", () => {
    // ProviderFetchOutcome intentionally has no account label or CLI-version field yet, so the runner
    // must not fabricate them. The serializer is nevertheless pinned to the complete upstream shape
    // so those fields can be carried unchanged once the multi-account/version adapters are ported.
    expect(
      encodeToon([
        {
          provider: "claude",
          account: "work",
          version: "1.2.3",
          source: "oauth",
          usage: {
            primary: { usedPercent: 7, windowMinutes: 300 },
            secondary: { usedPercent: 42.5, windowMinutes: 10_080 },
            tertiary: null,
            details: [
              {
                title: "Usage summary",
                rows: [
                  { label: "Requests", value: "120" },
                  { label: "Tokens", value: "4.2k" },
                ],
              },
              {
                title: "Extra usage",
                rows: [
                  { label: "Spend", value: "$5.00", secondaryValue: "of $20.00" },
                  { label: "Balance", value: "$100.00" },
                ],
              },
            ],
            updatedAt: "2026-02-02T02:40:00Z",
            identity: {
              providerID: "claude",
              accountEmail: "dev@example.com",
              loginMethod: "OAuth",
            },
            accountEmail: "dev@example.com",
            loginMethod: "OAuth",
          },
        },
      ]),
    ).toBe(
      `
[1]:
  - provider: claude
    account: work
    version: 1.2.3
    source: oauth
    usage:
      primary:
        usedPercent: 7
        windowMinutes: 300
      secondary:
        usedPercent: 42.5
        windowMinutes: 10080
      tertiary: null
      details[2]:
        - title: Usage summary
          rows[2]{label,value}:
            Requests,"120"
            Tokens,4.2k
        - title: Extra usage
          rows[2]:
            - label: Spend
              value: $5.00
              secondaryValue: of $20.00
            - label: Balance
              value: $100.00
      updatedAt: "2026-02-02T02:40:00Z"
      identity:
        providerID: claude
        accountEmail: dev@example.com
        loginMethod: OAuth
      accountEmail: dev@example.com
      loginMethod: OAuth`.trim(),
    );
  });
});
