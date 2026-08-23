import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { makeNodePtyRunner, type NodePtySession } from "../src/node-pty.ts";

describe("Node PTY fake (synthetic)", () => {
  it("uses onExit, disposes handlers once, and awaits tree termination on close/abort", async () => {
    const order: string[] = [];
    let dataDisposed = 0;
    let exitDisposed = 0;
    let written = "";
    const runner = makeNodePtyRunner({
      spawnImpl: (_cmd, args, opts) => {
        expect(args).toContain("--allowed-tools");
        expect(opts.cols).toBe(160);
        expect(opts.rows).toBe(50);
        return {
          pid: 9999,
          onData: (cb) => {
            cb("Current session\n90% left");
            return {
              dispose: () => {
                dataDisposed += 1;
              },
            };
          },
          onExit: (cb) => {
            cb({ exitCode: 0 });
            return {
              dispose: () => {
                exitDisposed += 1;
              },
            };
          },
          write: (data) => {
            written += data;
          },
          resize: () => undefined,
          kill: () => {
            order.push("kill");
          },
        };
      },
      terminator: async (pid) => {
        expect(pid).toBe(9999);
        order.push("terminate");
      },
    });
    const session = (await Effect.runPromise(
      runner.start({
        command: "claude",
        args: ["--allowed-tools", "", "--strict-mcp-config", "--session-id", "uuid-123"],
        cwd: "/var/app/ClaudeProbe",
        env: { DISABLE_AUTOUPDATER: "1", PATH: "/bin" },
        columns: 160,
        rows: 50,
      }),
    )) as NodePtySession;
    await Effect.runPromise(session.write(new TextEncoder().encode("/usage\r")));
    const data = await Effect.runPromise(session.read);
    expect(new TextDecoder().decode(data)).toContain("Current session");
    expect(written).toContain("/usage");
    await Effect.runPromise(session.close);
    await Effect.runPromise(session.close);
    expect(order).toEqual(["kill", "terminate"]);
    expect(dataDisposed).toBe(1);
    expect(exitDisposed).toBe(1);
    expect(session.exitCode()).toBe(0);

    const controller = new AbortController();
    let abortTerminated = 0;
    const abortRunner = makeNodePtyRunner({
      spawnImpl: () => ({
        pid: 7,
        onData: () => ({ dispose: () => undefined }),
        onExit: () => ({ dispose: () => undefined }),
        write: () => undefined,
        resize: () => undefined,
        kill: () => undefined,
      }),
      terminator: async () => {
        abortTerminated += 1;
      },
    });
    const session2 = await Effect.runPromise(
      abortRunner.start({
        command: "claude",
        args: [],
        cwd: "/var/app/ClaudeProbe",
        env: {},
        columns: 160,
        rows: 50,
      }),
      { signal: controller.signal },
    );
    controller.abort();
    await Effect.runPromise(session2.close);
    expect(abortTerminated).toBe(1);
  });

  it("rejects NUL in the command", async () => {
    const runner = makeNodePtyRunner({
      spawnImpl: () => {
        throw new Error("must not spawn");
      },
    });
    await expect(
      Effect.runPromise(
        runner.start({ command: "claude\u0000", args: [], cwd: "/var/app/ClaudeProbe", env: {} }),
      ),
    ).rejects.toBeDefined();
  });

  it("shares an in-flight close and propagates descendant termination failure", async () => {
    let releaseTermination: (() => void) | undefined;
    const termination = new Promise<void>((resolve) => {
      releaseTermination = resolve;
    });
    let terminatorCalls = 0;
    const runner = makeNodePtyRunner({
      spawnImpl: () => ({
        pid: 23,
        onData: () => ({ dispose: () => undefined }),
        onExit: () => ({ dispose: () => undefined }),
        write: () => undefined,
        resize: () => undefined,
        kill: () => undefined,
      }),
      terminator: async () => {
        terminatorCalls += 1;
        await termination;
        throw new Error("tree termination failed");
      },
    });
    const session = await Effect.runPromise(
      runner.start({ command: "claude", args: [], cwd: "/private/probe", env: {} }),
    );
    let firstSettled = false;
    const first = Effect.runPromise(session.close).finally(() => {
      firstSettled = true;
    });
    const second = Effect.runPromise(session.close);
    await Promise.resolve();
    expect(terminatorCalls).toBe(1);
    expect(firstSettled).toBe(false);
    releaseTermination!();
    await expect(first).rejects.toMatchObject({ operation: "close pty" });
    await expect(second).rejects.toMatchObject({ operation: "close pty" });
    expect(terminatorCalls).toBe(1);
  });
});
