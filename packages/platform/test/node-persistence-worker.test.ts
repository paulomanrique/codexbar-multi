import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import type { ProviderId } from "@codexbar/contracts";
import { makeNodeSqliteWorkerPersistence } from "../src/node.ts";

const snapshot = (updatedAt: string) => ({ details: [], updatedAt });

describe("Node SQLite worker persistence", () => {
  it("runs history and cost repositories in a real worker and closes cleanly", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexbar-sqlite-worker-"));
    const databasePath = join(directory, "usage.sqlite");
    const persistence = await Effect.runPromise(makeNodeSqliteWorkerPersistence({ databasePath }));
    try {
      await Effect.runPromise(
        persistence.history.append({
          providerId: "codex" as ProviderId,
          recordedAt: 1,
          snapshot: snapshot("2026-01-01T00:00:00Z"),
        }),
      );
      await Effect.runPromise(
        persistence.costs.append({
          providerId: "codex" as ProviderId,
          recordedAt: 1,
          inputTokens: 3,
          outputTokens: 5,
          costUsd: 0.02,
        }),
      );

      await expect(Effect.runPromise(persistence.history.list("codex", 0))).resolves.toEqual([
        {
          providerId: "codex",
          recordedAt: 1,
          snapshot: snapshot("2026-01-01T00:00:00Z"),
        },
      ]);
      await expect(Effect.runPromise(persistence.costs.list("codex", 0))).resolves.toEqual([
        {
          providerId: "codex",
          recordedAt: 1,
          inputTokens: 3,
          outputTokens: 5,
          costUsd: 0.02,
        },
      ]);

      await Effect.runPromise(persistence.close);
      await expect(Effect.runPromise(persistence.history.list("codex", 0))).rejects.toMatchObject({
        _tag: "InfrastructureError",
        operation: "SQLite worker",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("applies repository limits inside the SQLite worker", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexbar-sqlite-worker-limit-"));
    const databasePath = join(directory, "usage.sqlite");
    const persistence = await Effect.runPromise(makeNodeSqliteWorkerPersistence({ databasePath }));
    try {
      for (const recordedAt of [1, 2, 3]) {
        await Effect.runPromise(
          persistence.history.append({
            providerId: "codex" as ProviderId,
            recordedAt,
            snapshot: snapshot(`2026-01-01T00:00:0${recordedAt}Z`),
          }),
        );
        await Effect.runPromise(
          persistence.costs.append({
            providerId: "codex" as ProviderId,
            recordedAt,
            inputTokens: recordedAt,
            outputTokens: recordedAt,
            costUsd: recordedAt / 100,
          }),
        );
      }
      await expect(
        Effect.runPromise(persistence.history.list("codex", 0, 2)),
      ).resolves.toHaveLength(2);
      await expect(Effect.runPromise(persistence.costs.list("codex", 0, 2))).resolves.toHaveLength(
        2,
      );
    } finally {
      await Effect.runPromise(persistence.close).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("gets the latest history record in the worker with ID tie-breaking", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexbar-sqlite-worker-latest-"));
    const databasePath = join(directory, "usage.sqlite");
    const persistence = await Effect.runPromise(makeNodeSqliteWorkerPersistence({ databasePath }));
    try {
      await Effect.runPromise(
        persistence.history.append({
          providerId: "codex" as ProviderId,
          recordedAt: 10,
          snapshot: snapshot("2026-01-01T00:00:00Z"),
        }),
      );
      await Effect.runPromise(
        persistence.history.append({
          providerId: "codex" as ProviderId,
          recordedAt: 20,
          snapshot: snapshot("2026-01-01T00:00:01Z"),
        }),
      );
      await Effect.runPromise(
        persistence.history.append({
          providerId: "codex" as ProviderId,
          recordedAt: 20,
          snapshot: snapshot("2026-01-01T00:00:02Z"),
        }),
      );
      await expect(Effect.runPromise(persistence.history.latest("codex"))).resolves.toEqual({
        providerId: "codex",
        recordedAt: 20,
        snapshot: snapshot("2026-01-01T00:00:02Z"),
      });
      await expect(
        Effect.runPromise(persistence.history.latest("claude")),
      ).resolves.toBeUndefined();
    } finally {
      await Effect.runPromise(persistence.close).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns a classified infrastructure error when worker startup cannot open SQLite", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexbar-sqlite-worker-failure-"));
    try {
      await expect(
        Effect.runPromise(makeNodeSqliteWorkerPersistence({ databasePath: directory })),
      ).rejects.toMatchObject({
        _tag: "InfrastructureError",
        operation: "open SQLite persistence",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("terminates a cancelled worker request so it cannot outlive the host", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexbar-sqlite-worker-cancel-"));
    const databasePath = join(directory, "usage.sqlite");
    const persistence = await Effect.runPromise(makeNodeSqliteWorkerPersistence({ databasePath }));
    const controller = new AbortController();
    controller.abort();
    try {
      await expect(
        Effect.runPromise(
          persistence.history.append({
            providerId: "codex" as ProviderId,
            recordedAt: 1,
            snapshot: snapshot("2026-01-01T00:00:00Z"),
          }),
          { signal: controller.signal },
        ),
      ).rejects.toBeDefined();
      await expect(Effect.runPromise(persistence.history.list("codex", 0))).rejects.toMatchObject({
        _tag: "InfrastructureError",
        operation: "SQLite worker",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("serves reads while a lock-delayed writer yields inside the worker", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexbar-sqlite-worker-reader-"));
    const databasePath = join(directory, "usage.sqlite");
    const persistence = await Effect.runPromise(makeNodeSqliteWorkerPersistence({ databasePath }));
    await Effect.runPromise(
      persistence.history.append({
        providerId: "codex" as ProviderId,
        recordedAt: 1,
        snapshot: snapshot("2026-01-01T00:00:00Z"),
      }),
    );
    const lockHolder = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { DatabaseSync } from "node:sqlite";
         const database = new DatabaseSync(process.argv[1]);
         database.exec("BEGIN IMMEDIATE");
         process.stdout.write("locked\\n");
         setTimeout(() => { database.exec("COMMIT"); database.close(); }, 500);`,
        databasePath,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const childExit = once(lockHolder, "exit");
    let lockReleased = false;
    void childExit.then(() => {
      lockReleased = true;
    });
    try {
      await once(lockHolder.stdout!, "data");
      const delayedWrite = Effect.runPromise(
        persistence.costs.append({
          providerId: "codex" as ProviderId,
          recordedAt: 2,
          inputTokens: 1,
          outputTokens: 1,
          costUsd: 0.01,
        }),
      );
      await expect(
        Promise.race([
          Effect.runPromise(persistence.history.list("codex", 0)),
          new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 200)),
        ]),
      ).resolves.toEqual([
        {
          providerId: "codex",
          recordedAt: 1,
          snapshot: snapshot("2026-01-01T00:00:00Z"),
        },
      ]);
      expect(lockReleased).toBe(false);
      await expect(delayedWrite).resolves.toBeUndefined();
      await childExit;
    } finally {
      lockHolder.kill();
      await Effect.runPromise(persistence.close).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });
});
