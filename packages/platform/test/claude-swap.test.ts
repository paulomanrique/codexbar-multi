import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import type { PrivateFileStoreService, ProcessRunnerService } from "@codexbar/core";
import {
  ClaudeSwapAdapterError,
  parseClaudeSwapAccountList,
  readClaudeSwapAccountList,
  refreshClaudeSwapAccounts,
} from "../src/claude-swap.ts";
import { resolveNodeClaudeSwapExecutablePath } from "../src/node.ts";

const bytes = (value: string) => new TextEncoder().encode(value);

const listJSON = JSON.stringify({
  schemaVersion: 1,
  activeAccountNumber: 2,
  accounts: [
    {
      number: 1,
      email: "work@example.test",
      active: false,
      usageStatus: "ok",
      usage: { fiveHour: { pct: 12.5 } },
    },
    {
      number: 2,
      email: "personal@example.test",
      active: true,
      usageStatus: "unavailable",
      usage: { sevenDay: { pct: 100, resetsAt: "2030-01-01T00:00:00Z" } },
    },
  ],
});

const runner = (
  stdout: string,
  exitCode = 0,
): { readonly service: ProcessRunnerService; calls: unknown[] } => {
  const calls: unknown[] = [];
  return {
    calls,
    service: {
      run: (spec) => {
        calls.push(spec);
        return Effect.succeed({
          exitCode,
          signal: undefined,
          stdout: bytes(stdout),
          stderr: new Uint8Array(),
        });
      },
    },
  };
};

const memoryFiles = (): {
  readonly service: PrivateFileStoreService;
  readonly values: Map<string, Uint8Array>;
} => {
  const values = new Map<string, Uint8Array>();
  return {
    values,
    service: {
      read: (path) => Effect.succeed(values.get(path)?.slice()),
      writeAtomic: (path, value) => Effect.sync(() => void values.set(path, value.slice())),
      remove: (path) => Effect.sync(() => void values.delete(path)),
    },
  };
};

describe("Claude Swap host adapter", () => {
  it("parses only the schema-v1 allowlist and keeps active-first projection inputs", () => {
    const result = parseClaudeSwapAccountList(bytes(listJSON));
    expect(result).toMatchObject({ activeAccountNumber: 2 });
    expect(result.accounts).toHaveLength(2);
    expect(result.accounts[0]).toMatchObject({
      number: 1,
      email: "work@example.test",
      usageStatus: "ok",
      fiveHour: { usedPercent: 12.5 },
    });
  });

  it("rejects malformed top-level state and preserves schema error envelopes", () => {
    expect(() => parseClaudeSwapAccountList(bytes("[]"))).toThrow(
      "claude-swap returned output that is not a JSON object.",
    );
    expect(() =>
      parseClaudeSwapAccountList(
        bytes('{"schemaVersion":1,"error":{"type":"SwitchError","message":"store locked"}}'),
      ),
    ).toThrow("claude-swap reported SwitchError: store locked");
    expect(() =>
      parseClaudeSwapAccountList(
        bytes('{"schemaVersion":1,"activeAccountNumber":1,"accounts":[]}'),
      ),
    ).toThrow("active account fields disagree");
  });

  it("runs only the fixed read-only command and parses an error envelope from non-zero exit", async () => {
    const fixture = runner(
      '{"schemaVersion":1,"error":{"type":"SwitchError","message":"store locked"}}',
      1,
    );
    await expect(
      Effect.runPromise(readClaudeSwapAccountList(fixture.service, "/safe/cswap")),
    ).rejects.toBeInstanceOf(ClaudeSwapAdapterError);
    expect(fixture.calls).toEqual([
      { command: "/safe/cswap", args: ["--list", "--json"], timeoutMs: 30_000 },
    ]);
  });

  it("bounds output before JSON parsing", () => {
    expect(() => parseClaudeSwapAccountList(new Uint8Array(262_145))).toThrow(
      "refusing to parse more than 262144",
    );
  });

  it("expands only the current user's tilde before Node launches the configured executable", () => {
    expect(resolveNodeClaudeSwapExecutablePath(" ~/bin/cswap ")).toMatch(/[/\\]bin[/\\]cswap$/u);
    expect(resolveNodeClaudeSwapExecutablePath("/safe/cswap")).toBe("/safe/cswap");
  });

  it("writes redacted retained usage only after the freshness guard", async () => {
    const fixture = runner(listJSON);
    const files = memoryFiles();
    let fresh = false;
    const stale = await Effect.runPromise(
      refreshClaudeSwapAccounts({
        processes: fixture.service,
        files: files.service,
        executablePath: "/safe/cswap",
        retentionPath: "/private/claude-swap.json",
        isFresh: () => fresh,
        now: new Date("2029-01-01T00:00:00Z"),
      }),
    );
    expect(stale).toEqual({ fresh: false, accounts: [] });
    expect(files.values.size).toBe(0);

    fresh = true;
    const result = await Effect.runPromise(
      refreshClaudeSwapAccounts({
        processes: fixture.service,
        files: files.service,
        executablePath: "/safe/cswap",
        retentionPath: "/private/claude-swap.json",
        isFresh: () => fresh,
        now: new Date("2029-01-01T00:00:00Z"),
      }),
    );
    expect(result).toMatchObject({ fresh: true });
    const stored = new TextDecoder().decode(files.values.get("/private/claude-swap.json"));
    expect(stored).not.toContain("personal@example.test");
    expect(stored).not.toContain("work@example.test");
    expect(stored).toContain("accountFingerprint");
  });
});
