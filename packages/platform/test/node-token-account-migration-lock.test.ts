import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { Effect, Fiber } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { InfrastructureError } from "@codexbar/core";
import { makeNodeTokenAccountMigrationLock, tokenAccountMigrationLockPath } from "../src/node.ts";

const holderFixturePath = fileURLToPath(
  new URL("./fixtures/token-account-lock-holder.ts", import.meta.url),
);

const expectOwnerOnlyFileMode = async (path: string): Promise<void> => {
  if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
};

const temporaryDirectory = (name: string): Promise<string> =>
  mkdtemp(join(tmpdir(), `codexbar-token-account-lock-${name}-`));

const waitForOutput = (
  child: ReturnType<typeof spawn>,
  expected: string,
  timeoutMs = 5_000,
): Promise<void> =>
  new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(
      () => finish(new Error("Lock holder readiness timed out.")),
      timeoutMs,
    );
    const onData = (chunk: Buffer | string): void => {
      output += chunk.toString();
      if (output.includes(expected)) finish();
    };
    const onExit = (): void => finish(new Error("Lock holder exited before readiness."));
    const onError = (): void => finish(new Error("Lock holder failed before readiness."));
    const finish = (error?: Error): void => {
      clearTimeout(timeout);
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
      if (error === undefined) resolve();
      else reject(error);
    };
    child.stdout?.on("data", onData);
    child.once("exit", onExit);
    child.once("error", onError);
  });

const terminateChild = async (child: ReturnType<typeof spawn>): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill(process.platform === "win32" ? undefined : "SIGKILL");
  await Promise.race([
    exited,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("Lock holder termination timed out.")), 5_000),
    ),
  ]);
};

describe("Node token account migration lock", () => {
  it("derives a stable path and reuses the lock database across acquire/release cycles", async () => {
    const directory = await temporaryDirectory("reuse");
    const lockPath = tokenAccountMigrationLockPath(directory);
    const lock = makeNodeTokenAccountMigrationLock({
      lockPath,
      acquireTimeoutMs: 200,
      retryDelayMs: 5,
    });
    const entered: string[] = [];

    try {
      expect(lockPath).toBe(join(directory, ".codexbar-multi", "token-account-migration.sqlite"));
      await Effect.runPromise(lock.runExclusive(Effect.sync(() => entered.push("first"))));
      await Effect.runPromise(lock.runExclusive(Effect.sync(() => entered.push("second"))));

      expect(entered).toEqual(["first", "second"]);
      await expectOwnerOnlyFileMode(lockPath);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("times out a contender while a child holds the SQLite transaction, then acquires after termination", async () => {
    const directory = await temporaryDirectory("contender");
    const configPaths = [join(directory, "first", "config.json"), join(directory, "second.json")];
    const lockPath = tokenAccountMigrationLockPath(directory);
    const holder = spawn(
      process.execPath,
      ["--experimental-strip-types", holderFixturePath, lockPath, "10000"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let entered = false;
    let directoryRestrictions = 0;
    let fileRestrictions = 0;

    try {
      await waitForOutput(holder, "locked\n");
      const contender = makeNodeTokenAccountMigrationLock({
        lockPath,
        acquireTimeoutMs: 300,
        retryDelayMs: 10,
        restrictDirectory: async () => {
          directoryRestrictions += 1;
        },
        restrictFile: async () => {
          fileRestrictions += 1;
        },
      });

      await expect(
        Effect.runPromise(
          contender.runExclusive(
            Effect.sync(() => {
              entered = true;
            }),
          ),
        ),
      ).rejects.toMatchObject({
        _tag: "InfrastructureError",
        operation: "acquire token account migration lock",
      });
      expect(entered).toBe(false);
      expect(configPaths[0]).not.toBe(configPaths[1]);
      expect(lockPath).not.toContain("first");
      expect(lockPath).not.toContain("second.json");
      expect(directoryRestrictions).toBe(1);
      expect(fileRestrictions).toBe(1);
      const lockedStat = await stat(lockPath);

      const waitingFiber = Effect.runFork(
        contender.runExclusive(
          Effect.sync(() => {
            entered = true;
          }),
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
      const interruptStartedAt = performance.now();
      await Promise.race([
        Effect.runPromise(Fiber.interrupt(waitingFiber)),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("Lock wait interruption timed out.")), 500),
        ),
      ]);
      expect(performance.now() - interruptStartedAt).toBeLessThan(500);
      expect(entered).toBe(false);

      await terminateChild(holder);

      const recovered = makeNodeTokenAccountMigrationLock({
        lockPath,
        acquireTimeoutMs: 2_000,
        retryDelayMs: 10,
      });
      await Effect.runPromise(
        recovered.runExclusive(
          Effect.sync(() => {
            entered = true;
          }),
        ),
      );
      expect(entered).toBe(true);
      expect((await stat(lockPath)).size).toBe(lockedStat.size);
    } finally {
      await terminateChild(holder);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("releases the real SQLite lock after failure, defect, and interruption", async () => {
    const directory = await temporaryDirectory("release");
    const lockPath = tokenAccountMigrationLockPath(directory);
    const lock = makeNodeTokenAccountMigrationLock({ lockPath, acquireTimeoutMs: 500 });

    try {
      await expect(
        Effect.runPromise(lock.runExclusive(Effect.fail(new Error("typed failure")))),
      ).rejects.toBeInstanceOf(Error);
      await Effect.runPromise(lock.runExclusive(Effect.void));

      await expect(
        Effect.runPromise(lock.runExclusive(Effect.die(new Error("defect")))),
      ).rejects.toBeInstanceOf(Error);
      await Effect.runPromise(lock.runExclusive(Effect.void));

      const fiber = Effect.runFork(lock.runExclusive(Effect.never));
      await new Promise((resolve) => setTimeout(resolve, 20));
      await Effect.runPromise(Fiber.interrupt(fiber));
      await Effect.runPromise(lock.runExclusive(Effect.void));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed for a corrupt lock database without exposing the config path", async () => {
    const directory = await temporaryDirectory("corrupt");
    const lockPath = tokenAccountMigrationLockPath(directory);
    await mkdir(join(directory, ".codexbar-multi"), { mode: 0o700 });
    await writeFile(lockPath, "not a sqlite database", { mode: 0o600 });
    const lock = makeNodeTokenAccountMigrationLock({
      lockPath,
      acquireTimeoutMs: 50,
      retryDelayMs: 5,
    });

    try {
      let entered = false;
      await expect(
        Effect.runPromise(
          lock.runExclusive(
            Effect.sync(() => {
              entered = true;
            }),
          ),
        ),
      ).rejects.toBeInstanceOf(InfrastructureError);

      expect(entered).toBe(false);
      await expect(Effect.runPromise(lock.runExclusive(Effect.void))).rejects.toMatchObject({
        message: "Token account migration lock is unavailable.",
      });
      expect((await readFile(lockPath, "utf8")).startsWith("not a sqlite")).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps lock error text path-safe", async () => {
    const directory = await temporaryDirectory("safe-error");
    const configPath = join(directory, "config-with-secret-name.json");
    const lockPath = tokenAccountMigrationLockPath(directory);
    await mkdir(join(directory, ".codexbar-multi"), { mode: 0o700 });
    await writeFile(lockPath, "not sqlite", { mode: 0o600 });
    const lock = makeNodeTokenAccountMigrationLock({ lockPath, acquireTimeoutMs: 10 });

    try {
      let caught: unknown;
      try {
        await Effect.runPromise(lock.runExclusive(Effect.void));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(InfrastructureError);
      expect((caught as Error).message).toBe("Token account migration lock is unavailable.");
      expect(String((caught as Error).message)).not.toContain(configPath);
      expect(String((caught as Error).message)).not.toContain(lockPath);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
