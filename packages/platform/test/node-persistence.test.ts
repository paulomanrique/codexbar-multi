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

const expectOwnerOnlyFileMode = async (path: string): Promise<void> => {
  if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
};

describe("Node SQLite persistence", () => {
  it("atomically replaces a vendor daily ledger by provider/day/source without duplicate refreshes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexbar-daily-cost-"));
    const databasePath = join(directory, "usage.sqlite");
    const persistence = await Effect.runPromise(makeNodeSqlitePersistence({ databasePath }));
    const day = Date.parse("2026-08-20T00:00:00.000Z");
    const replacement = (costUsd: number) => ({
      providerId: "xai" as ProviderId,
      sourceKey: "vendor-daily-spend",
      since: day,
      until: day,
      availability: "available" as const,
      coverage: "exact" as const,
      records: [
        {
          providerId: "xai" as ProviderId,
          recordedAt: day,
          inputTokens: 0,
          outputTokens: 0,
          costUsd,
        },
      ],
    });
    try {
      await Effect.runPromise(persistence.costs.replaceDaily(replacement(0.5)));
      await Effect.runPromise(persistence.costs.replaceDaily(replacement(1.25)));
      await expect(Effect.runPromise(persistence.costs.list("xai", 0))).resolves.toEqual([
        { providerId: "xai", recordedAt: day, inputTokens: 0, outputTokens: 0, costUsd: 1.25 },
      ]);
      await expect(
        Effect.runPromise(persistence.costs.dailySourceState("xai", "vendor-daily-spend")),
      ).resolves.toEqual({ availability: "available", coverage: "exact" });

      await Effect.runPromise(
        persistence.costs.replaceDaily({
          ...replacement(0),
          availability: "unavailable",
          coverage: "estimated",
          records: [],
        }),
      );
      // Keeping the last complete transaction allows a later successful
      // refresh to replace it, while the unavailable state prevents display.
      await expect(Effect.runPromise(persistence.costs.list("xai", 0))).resolves.toHaveLength(1);
      await expect(
        Effect.runPromise(persistence.costs.dailySourceState("xai", "vendor-daily-spend")),
      ).resolves.toEqual({ availability: "unavailable", coverage: "estimated" });

      await Effect.runPromise(persistence.costs.replaceDaily({ ...replacement(0), records: [] }));
      await expect(Effect.runPromise(persistence.costs.list("xai", 0))).resolves.toEqual([]);
    } finally {
      await Effect.runPromise(persistence.close);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("serializes concurrent daily replacements and rolls back a failed replacement as one transaction", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexbar-daily-cost-atomic-"));
    const databasePath = join(directory, "usage.sqlite");
    const persistence = await Effect.runPromise(makeNodeSqlitePersistence({ databasePath }));
    const day = Date.parse("2026-08-20T00:00:00.000Z");
    const replacement = (costUsd: number) => ({
      providerId: "xai" as ProviderId,
      sourceKey: "vendor-daily-spend",
      since: day,
      until: day,
      availability: "available" as const,
      coverage: "exact" as const,
      records: [
        {
          providerId: "xai" as ProviderId,
          recordedAt: day,
          inputTokens: 0,
          outputTokens: 0,
          costUsd,
        },
      ],
    });
    try {
      await Promise.all([
        Effect.runPromise(persistence.costs.replaceDaily(replacement(0.5))),
        Effect.runPromise(persistence.costs.replaceDaily(replacement(1.25))),
      ]);
      await expect(Effect.runPromise(persistence.costs.list("xai", 0))).resolves.toEqual([
        { providerId: "xai", recordedAt: day, inputTokens: 0, outputTokens: 0, costUsd: 1.25 },
      ]);

      const inspection = new DatabaseSync(databasePath);
      try {
        inspection.exec(`
          CREATE TRIGGER fixture_abort_daily_replace
          BEFORE INSERT ON cost_usage_records
          WHEN NEW.provider_id = 'xai' AND NEW.cost_usd = 2
          BEGIN SELECT RAISE(ABORT, 'fixture daily replacement failure'); END;
        `);
      } finally {
        inspection.close();
      }
      await expect(
        Effect.runPromise(persistence.costs.replaceDaily(replacement(2))),
      ).rejects.toMatchObject({
        _tag: "InfrastructureError",
        operation: "replace daily cost usage records",
      });
      await expect(Effect.runPromise(persistence.costs.list("xai", 0))).resolves.toEqual([
        { providerId: "xai", recordedAt: day, inputTokens: 0, outputTokens: 0, costUsd: 1.25 },
      ]);
    } finally {
      await Effect.runPromise(persistence.close);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("prunes only records strictly before the inclusive retention edge and honors namespaces", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexbar-retention-"));
    const databasePath = join(directory, "usage.sqlite");
    const persistence = await Effect.runPromise(makeNodeSqlitePersistence({ databasePath }));
    try {
      for (const [providerId, recordedAt] of [
        ["fixture-meter", 1],
        ["fixture-meter", 2],
        ["other-meter", 1],
      ] as const) {
        await Effect.runPromise(
          persistence.history.append({
            providerId,
            recordedAt,
            snapshot: snapshot(`2026-01-01T00:00:0${recordedAt}Z`),
          }),
        );
      }
      for (const [providerId, recordedAt] of [
        ["codex", 1],
        ["codex", 2],
        ["claude", 1],
      ] as const) {
        await Effect.runPromise(
          persistence.costs.append({
            providerId,
            recordedAt,
            inputTokens: recordedAt,
            outputTokens: recordedAt,
            costUsd: recordedAt / 100,
          }),
        );
      }

      // Swift CostUsageStore retention keeps both requested-window edges.
      await expect(
        Effect.runPromise(
          persistence.retention.prune({
            before: 2,
            historyProviderId: "fixture-meter",
            costProviderId: "codex",
          }),
        ),
      ).resolves.toEqual({ deletedHistoryRecords: 1, deletedCostUsageRecords: 1 });
      await expect(
        Effect.runPromise(persistence.history.list("fixture-meter", 0)),
      ).resolves.toEqual([
        {
          providerId: "fixture-meter",
          recordedAt: 2,
          snapshot: snapshot("2026-01-01T00:00:02Z"),
        },
      ]);
      await expect(
        Effect.runPromise(persistence.history.list("other-meter", 0)),
      ).resolves.toHaveLength(1);
      await expect(Effect.runPromise(persistence.costs.list("codex", 0))).resolves.toEqual([
        { providerId: "codex", recordedAt: 2, inputTokens: 2, outputTokens: 2, costUsd: 0.02 },
      ]);
      await expect(Effect.runPromise(persistence.costs.list("claude", 0))).resolves.toHaveLength(1);
    } finally {
      await Effect.runPromise(persistence.close);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rolls back history and cost pruning together when SQLite rejects either delete", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexbar-retention-atomic-"));
    const databasePath = join(directory, "usage.sqlite");
    const persistence = await Effect.runPromise(makeNodeSqlitePersistence({ databasePath }));
    try {
      for (const recordedAt of [1, 2]) {
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
      const inspection = new DatabaseSync(databasePath);
      try {
        inspection.exec(`
          CREATE TRIGGER fixture_abort_cost_retention
          BEFORE DELETE ON cost_usage_records
          WHEN OLD.recorded_at = 2
          BEGIN SELECT RAISE(ABORT, 'fixture retention failure'); END;
        `);
      } finally {
        inspection.close();
      }

      await expect(
        Effect.runPromise(persistence.retention.prune({ before: 3 })),
      ).rejects.toMatchObject({
        _tag: "InfrastructureError",
        operation: "prune usage records",
      });
      await expect(Effect.runPromise(persistence.history.list("codex", 0))).resolves.toHaveLength(
        2,
      );
      await expect(Effect.runPromise(persistence.costs.list("codex", 0))).resolves.toHaveLength(2);
    } finally {
      await Effect.runPromise(persistence.close);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps user-plugin history isolated and removes only the requested instance", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexbar-plugin-history-"));
    const databasePath = join(directory, "usage.sqlite");
    const persistence = await Effect.runPromise(makeNodeSqlitePersistence({ databasePath }));
    try {
      await Effect.runPromise(
        persistence.history.append({
          providerId: "fixture-meter",
          recordedAt: 1,
          snapshot: snapshot("2026-01-01T00:00:00Z"),
        }),
      );
      await Effect.runPromise(
        persistence.history.append({
          providerId: "other-meter",
          recordedAt: 2,
          snapshot: snapshot("2026-01-01T00:01:00Z"),
        }),
      );
      await Effect.runPromise(persistence.history.removeProvider("fixture-meter"));
      await expect(
        Effect.runPromise(persistence.history.list("fixture-meter", 0)),
      ).resolves.toEqual([]);
      await expect(Effect.runPromise(persistence.history.list("other-meter", 0))).resolves.toEqual([
        {
          providerId: "other-meter",
          recordedAt: 2,
          snapshot: snapshot("2026-01-01T00:01:00Z"),
        },
      ]);
    } finally {
      await Effect.runPromise(persistence.close);
      await rm(directory, { recursive: true, force: true });
    }
  });

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
      await expectOwnerOnlyFileMode(`${databasePath}-wal`);
      await expectOwnerOnlyFileMode(`${databasePath}-shm`);
    } finally {
      await Effect.runPromise(persistence.close);
    }

    const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
    try {
      expect(database.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
      expect(database.prepare("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
      expect(database.prepare("PRAGMA quick_check").get()?.quick_check).toBe("ok");
      expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(2);
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
            version: 3,
            destructive: true,
            sql: "CREATE TABLE migration_witness (id INTEGER PRIMARY KEY)",
          },
        ],
      }),
    );
    try {
      expect(
        (await readdir(directory)).some((name) => name.startsWith("usage.sqlite.backup-v3-")),
      ).toBe(true);
      const backupName = (await readdir(directory)).find((name) =>
        name.startsWith("usage.sqlite.backup-v3-"),
      );
      expect(backupName).toBeDefined();
      await expectOwnerOnlyFileMode(join(directory, backupName!));
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
      await expectOwnerOnlyFileMode(path);
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
