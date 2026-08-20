import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import type { ProviderId } from "@codexbar/contracts";
import { decodeCodexBarConfig } from "@codexbar/core";
import {
  NODE_PERSISTENCE_MIGRATIONS,
  makeNodeConfigRepository,
  makeNodeSqlitePersistence,
} from "../src/node.ts";

const snapshot = (updatedAt: string) => ({ details: [], updatedAt });

describe("Node SQLite persistence", () => {
  it("serializes concurrent appends, commits complete records, and enables durable SQLite settings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexbar-sqlite-"));
    const databasePath = join(directory, "usage.sqlite");
    const persistence = await Effect.runPromise(makeNodeSqlitePersistence({ databasePath }));
    try {
      await Promise.all(
        Array.from({ length: 40 }, (_, index) =>
          Effect.runPromise(
            persistence.history.append({
              providerId: "codex" as ProviderId,
              recordedAt: index,
              snapshot: snapshot(`2026-01-01T00:00:${String(index).padStart(2, "0")}Z`),
            }),
          ),
        ),
      );
      await Promise.all(
        Array.from({ length: 40 }, (_, index) =>
          Effect.runPromise(
            persistence.costs.append({
              providerId: "codex" as ProviderId,
              recordedAt: index,
              inputTokens: index,
              outputTokens: index + 1,
              costUsd: index / 100,
            }),
          ),
        ),
      );

      await expect(Effect.runPromise(persistence.history.list("codex", 0))).resolves.toHaveLength(
        40,
      );
      await expect(Effect.runPromise(persistence.costs.list("codex", 0))).resolves.toHaveLength(40);
      expect((await stat(`${databasePath}-wal`)).mode & 0o777).toBe(0o600);
      expect((await stat(`${databasePath}-shm`)).mode & 0o777).toBe(0o600);
    } finally {
      await Effect.runPromise(persistence.close);
    }

    const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
    try {
      expect(database.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
      expect(database.prepare("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
      expect(database.prepare("PRAGMA quick_check").get()?.quick_check).toBe("ok");
      expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("backs up before a flagged destructive migration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexbar-migration-"));
    const databasePath = join(directory, "usage.sqlite");
    const initial = await Effect.runPromise(makeNodeSqlitePersistence({ databasePath }));
    await Effect.runPromise(initial.close);

    const migrated = await Effect.runPromise(
      makeNodeSqlitePersistence({
        databasePath,
        migrations: [
          ...NODE_PERSISTENCE_MIGRATIONS,
          {
            version: 2,
            destructive: true,
            sql: "CREATE TABLE migration_witness (id INTEGER PRIMARY KEY)",
          },
        ],
      }),
    );
    try {
      expect(
        (await readdir(directory)).some((name) => name.startsWith("usage.sqlite.backup-v2-")),
      ).toBe(true);
      const backupName = (await readdir(directory)).find((name) =>
        name.startsWith("usage.sqlite.backup-v2-"),
      );
      expect(backupName).toBeDefined();
      expect((await stat(join(directory, backupName!))).mode & 0o777).toBe(0o600);
    } finally {
      await Effect.runPromise(migrated.close);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("opens a completed store read-only and rejects writes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexbar-read-only-"));
    const databasePath = join(directory, "usage.sqlite");
    const writable = await Effect.runPromise(makeNodeSqlitePersistence({ databasePath }));
    await Effect.runPromise(
      writable.history.append({
        providerId: "codex" as ProviderId,
        recordedAt: 1,
        snapshot: snapshot("2026-01-01T00:00:00Z"),
      }),
    );
    await Effect.runPromise(writable.close);

    const readOnly = await Effect.runPromise(
      makeNodeSqlitePersistence({ databasePath, readOnly: true }),
    );
    try {
      await expect(Effect.runPromise(readOnly.history.list("codex", 0))).resolves.toHaveLength(1);
      await expect(
        Effect.runPromise(
          readOnly.costs.append({
            providerId: "codex" as ProviderId,
            recordedAt: 2,
            inputTokens: 1,
            outputTokens: 1,
            costUsd: 0.01,
          }),
        ),
      ).rejects.toMatchObject({
        _tag: "InfrastructureError",
        operation: "append cost usage record",
      });
    } finally {
      await Effect.runPromise(readOnly.close);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("waits for an external writer lock instead of failing immediately", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexbar-lock-"));
    const databasePath = join(directory, "usage.sqlite");
    const persistence = await Effect.runPromise(makeNodeSqlitePersistence({ databasePath }));
    const lockHolder = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { DatabaseSync } from "node:sqlite";
         const database = new DatabaseSync(process.argv[1]);
         database.exec("BEGIN IMMEDIATE");
         process.stdout.write("locked\\n");
         setTimeout(() => { database.exec("COMMIT"); database.close(); }, 150);`,
        databasePath,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const childExit = once(lockHolder, "exit");
    try {
      await once(lockHolder.stdout!, "data");
      await expect(
        Effect.runPromise(
          persistence.costs.append({
            providerId: "codex" as ProviderId,
            recordedAt: 1,
            inputTokens: 1,
            outputTokens: 1,
            costUsd: 0.01,
          }),
        ),
      ).resolves.toBeUndefined();
      await childExit;
    } finally {
      lockHolder.kill();
      await Effect.runPromise(persistence.close);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("serves a committed read while its writer FIFO is waiting on another process", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexbar-reader-wal-"));
    const databasePath = join(directory, "usage.sqlite");
    const persistence = await Effect.runPromise(makeNodeSqlitePersistence({ databasePath }));
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
         setTimeout(() => { database.exec("COMMIT"); database.close(); }, 400);`,
        databasePath,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const childExit = once(lockHolder, "exit");
    try {
      await once(lockHolder.stdout!, "data");
      const blockedWrite = Effect.runPromise(
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
          new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 150)),
        ]),
      ).resolves.toEqual([
        {
          providerId: "codex",
          recordedAt: 1,
          snapshot: snapshot("2026-01-01T00:00:00Z"),
        },
      ]);
      await expect(blockedWrite).resolves.toBeUndefined();
      await childExit;
    } finally {
      lockHolder.kill();
      await Effect.runPromise(persistence.close);
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("Node JSON configuration persistence", () => {
  it("uses a complete owner-only JSON replacement", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexbar-config-"));
    const path = join(directory, "config.json");
    const repository = makeNodeConfigRepository(path);
    const config = { version: 1, providers: [], hooks: { enabled: false, events: [] } };
    try {
      await Effect.runPromise(repository.save(config));
      const written = JSON.parse(await readFile(path, "utf8")) as {
        providers: Array<{ id: string; enabled?: boolean }>;
        hooks?: unknown;
      };
      expect(written.providers).toHaveLength(69);
      expect(written.providers[0]).toMatchObject({ id: "codex", enabled: true });
      expect(written.hooks).toEqual(config.hooks);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      await expect(Effect.runPromise(repository.load)).resolves.toMatchObject({
        version: 1,
        providers: expect.arrayContaining([expect.objectContaining({ id: "codex" })]),
        hooks: config.hooks,
      });
      await expect(
        Effect.runPromise(repository.save({ version: 1, providers: "not-an-array" } as never)),
      ).rejects.toMatchObject({ _tag: "InfrastructureError", operation: "write config" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not strip flattened provider extensions on an atomic round trip", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexbar-config-extensions-"));
    const path = join(directory, "config.json");
    const repository = makeNodeConfigRepository(path);
    const config = decodeCodexBarConfig({
      version: 1,
      providers: [
        {
          id: "moonshot",
          apiKey: "fixture-key",
          apiKeyRegion: "china",
          providerOwnedValue: { nested: true },
        },
      ],
    });
    try {
      await Effect.runPromise(repository.save(config));
      const written = JSON.parse(await readFile(path, "utf8")) as {
        providers: Array<Record<string, unknown>>;
      };
      expect(written.providers).toHaveLength(69);
      expect(written.providers[0]).toEqual({
        id: "moonshot",
        apiKey: "fixture-key",
        apiKeyRegion: "china",
        providerOwnedValue: { nested: true },
      });
      await expect(Effect.runPromise(repository.load)).resolves.toMatchObject({
        providers: expect.arrayContaining([
          expect.objectContaining({
            id: "moonshot",
            extensions: expect.objectContaining({ providerOwnedValue: { nested: true } }),
          }),
        ]),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("deduplicates and fills a sparse config when loading", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexbar-config-normalize-"));
    const path = join(directory, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        providers: [
          { id: "codex", enabled: false },
          { id: "codex", enabled: true },
          { id: "moonshot", apiKey: "fixture", region: "china" },
        ],
      }),
    );
    try {
      const loaded = await Effect.runPromise(makeNodeConfigRepository(path).load);
      expect(loaded?.providers).toHaveLength(69);
      expect(loaded?.providers.filter((provider) => provider.id === "codex")).toHaveLength(1);
      expect(loaded?.providers.find((provider) => provider.id === "codex")?.enabled).toBe(false);
      expect(
        loaded?.providers.find((provider) => provider.id === "moonshot")?.extensions.apiKeyRegion,
      ).toBe("china");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
