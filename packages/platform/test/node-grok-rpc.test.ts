import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vite-plus/test";
import {
  isNodeGrokCliCommand,
  nodeGrokCliEnvironment,
  nodeGrokCliSearchPath,
  runNodeGrokCliBilling,
} from "../src/node-grok-rpc.ts";

type FakeChild = EventEmitter & {
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  killed: number;
  kill(signal?: NodeJS.Signals): boolean;
};

const fakeChild = (): FakeChild => {
  const child = new EventEmitter() as FakeChild;
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null as NodeJS.Signals | null,
    killed: 0,
    kill: (signal: NodeJS.Signals = "SIGTERM") => {
      child.killed += 1;
      child.signalCode = signal;
      queueMicrotask(() => child.emit("close", null, signal));
      return true;
    },
  });
  return child;
};

const spawnWith = (child: FakeChild) =>
  (() => child) as unknown as typeof import("node:child_process").spawn;

const options = (child: FakeChild, signal = new AbortController().signal) => ({
  command: "/fixture/bin/grok",
  environment: { PATH: "/fixture/bin" },
  signal,
  spawnImpl: spawnWith(child),
});

describe("Node Grok ACP billing capability", () => {
  it("streams initialize before billing, ignores notifications, and returns only matching RPC replies", async () => {
    const child = fakeChild();
    const sent: unknown[] = [];
    child.stdin.on("data", (chunk: Buffer) => {
      const line = chunk.toString("utf8").trim();
      if (line === "") return;
      const request = JSON.parse(line) as { readonly id?: number; readonly method?: string };
      sent.push(request);
      if (request.id === 1) {
        child.stdout.write(
          '{"jsonrpc":"2.0","method":"log","params":{"token":"fixture-secret"}}\n',
        );
        child.stderr.write("Bearer fixture-secret\n");
        child.stdout.write('{"jsonrpc":"2.0","id":1,"result":{}}\n');
      }
      if (request.id === 2)
        child.stdout.write(
          '{"jsonrpc":"2.0","id":2,"result":{"monthlyLimit":{"val":100},"usage":{"totalUsed":{"val":25}}}}\n',
        );
    });

    await expect(runNodeGrokCliBilling(options(child))).resolves.toEqual({
      exitCode: 0,
      signal: undefined,
      stdout:
        '{"jsonrpc":"2.0","id":1,"result":{}}\n{"jsonrpc":"2.0","id":2,"result":{"monthlyLimit":{"val":100},"usage":{"totalUsed":{"val":25}}}}\n',
      stderr: "",
    });
    expect(sent).toEqual([
      expect.objectContaining({ id: 1, method: "initialize" }),
      expect.objectContaining({ id: 2, method: "x.ai/billing" }),
    ]);
    expect(child.killed).toBeGreaterThan(0);
  });

  it("uses the Swift time budgets, tears down on timeout, and never includes child output in the error", async () => {
    const child = fakeChild();
    child.stdin.on("data", (chunk: Buffer) => {
      if (JSON.parse(chunk.toString("utf8")).id === 1)
        child.stdout.write('{"jsonrpc":"2.0","id":1,"result":{}}\n');
      else child.stderr.write("Bearer fixture-secret should not escape\n");
    });

    await expect(
      runNodeGrokCliBilling({ ...options(child), billingTimeoutMs: 5 }),
    ).rejects.toMatchObject({ code: "timeout", message: "Grok CLI JSON-RPC request timed out." });
    expect(child.killed).toBeGreaterThan(0);
  });

  it("cancels an in-flight initialized session and redacts JSON-RPC error messages", async () => {
    const child = fakeChild();
    const controller = new AbortController();
    child.stdin.on("data", (chunk: Buffer) => {
      const request = JSON.parse(chunk.toString("utf8")) as { readonly id?: number };
      if (request.id === 1) child.stdout.write('{"jsonrpc":"2.0","id":1,"result":{}}\n');
      if (request.id === 2)
        child.stdout.write(
          '{"jsonrpc":"2.0","id":2,"error":{"message":"Authorization: Bearer fixture-secret"}}\n',
        );
    });
    await expect(runNodeGrokCliBilling(options(child, controller.signal))).rejects.toMatchObject({
      code: "request-failed",
      message: expect.not.stringContaining("fixture-secret"),
    });

    const cancelled = fakeChild();
    cancelled.stdin.on("data", (chunk: Buffer) => {
      if (JSON.parse(chunk.toString("utf8")).id === 1)
        cancelled.stdout.write('{"jsonrpc":"2.0","id":1,"result":{}}\n');
    });
    const pending = runNodeGrokCliBilling(options(cancelled, controller.signal));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect(cancelled.killed).toBeGreaterThan(0);
  });

  it("bounds unterminated stdout and builds a sanitized fixed PATH", async () => {
    const child = fakeChild();
    queueMicrotask(() => child.stdout.write("x".repeat(17)));
    await expect(
      runNodeGrokCliBilling({ ...options(child), maximumOutputBytes: 32, maximumLineBytes: 16 }),
    ).rejects.toMatchObject({ code: "output-too-large" });

    const path = nodeGrokCliSearchPath(
      { PATH: "/attacker/bin", PROVIDER_SECRET: "fixture-secret" },
      "/fixture/home",
      "linux",
      "/fixture/bin/grok",
    );
    const environment = nodeGrokCliEnvironment(
      { PATH: "/attacker/bin", PROVIDER_SECRET: "fixture-secret", GROK_HOME: "/fixture/grok" },
      "/fixture/home",
      "linux",
      "/fixture/bin/grok",
    );
    expect(path).not.toContain("/attacker/bin");
    expect(environment).toMatchObject({ PATH: path, GROK_HOME: "/fixture/grok" });
    expect(environment).not.toHaveProperty("PROVIDER_SECRET");
    expect(
      nodeGrokCliSearchPath(
        { LOCALAPPDATA: "C:\\Users\\fixture\\AppData\\Local" },
        "C:\\Users\\fixture",
        "win32",
        "C:\\Tools\\grok.exe",
      ),
    ).toContain(";");
    expect(isNodeGrokCliCommand("C:\\Tools\\grok.exe")).toBe(true);
    expect(isNodeGrokCliCommand("grok; unexpected")).toBe(false);
  });

  it("allows test overrides to tighten but never widen host limits", async () => {
    const excessive = [
      { maximumOutputBytes: 1024 * 1024 + 1 },
      { maximumLineBytes: 256 * 1024 + 1 },
      { initializeTimeoutMs: 4_001 },
      { billingTimeoutMs: 3_001 },
    ] as const;
    for (const override of excessive) {
      await expect(
        runNodeGrokCliBilling({ ...options(fakeChild()), ...override }),
      ).rejects.toMatchObject({ code: "start-failed" });
    }
  });
});
