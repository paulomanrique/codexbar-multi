import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
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
  it("commits local scanner rows and checkpoints together, including source replacement", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexbar-local-cost-scan-"));
    const databasePath = join(directory, "usage.sqlite");
    const persistence = await Effect.runPromise(makeNodeSqlitePersistence({ databasePath }));
    const sourceKey = "local-jsonl:fixture";
    const first = {
      providerId: "codex" as ProviderId,
      sourceKey,
      checkpointJson: JSON.stringify({ cursor: 10 }),
      records: [
        {
          providerId: "codex" as ProviderId,
          recordedAt: 10,
          inputTokens: 3,
          outputTokens: 2,
          costUsd: 0.01,
        },
      ],
    };
    try {
      await Effect.runPromise(persistence.costs.commitLocalScan(first));
      await expect(
        Effect.runPromise(persistence.costs.localScanCheckpoint("codex", sourceKey)),
      ).resolves.toBe(first.checkpointJson);

      // A source replacement still has to own the checkpoint it replaces;
      // otherwise a stale CLI could erase rows just committed by desktop.
      await expect(
        Effect.runPromise(
          persistence.costs.commitLocalScan({
            ...first,
            checkpointJson: JSON.stringify({ cursor: 11 }),
            reset: true,
            records: [{ ...first.records[0]!, recordedAt: 11, costUsd: 0.011 }],
          }),
        ),
      ).rejects.toMatchObject({
        _tag: "InfrastructureError",
        causeValue: { name: "CostUsageScanCheckpointConflictError" },
      });
      await expect(Effect.runPromise(persistence.costs.list("codex", 0))).resolves.toEqual(
        first.records,
      );

      const inspection = new DatabaseSync(databasePath);
      try {
        inspection.exec(`
          CREATE TRIGGER fixture_abort_local_cost_scan
          BEFORE INSERT ON cost_usage_records
          WHEN NEW.provider_id = 'codex' AND NEW.cost_usd = 0.02
          BEGIN SELECT RAISE(ABORT, 'fixture local scan failure'); END;
        `);
      } finally {
        inspection.close();
      }
      await expect(
        Effect.runPromise(
          persistence.costs.commitLocalScan({
            ...first,
            expectedCheckpointJson: first.checkpointJson,
            checkpointJson: JSON.stringify({ cursor: 20 }),
            records: [{ ...first.records[0]!, recordedAt: 20, costUsd: 0.02 }],
          }),
        ),
      ).rejects.toMatchObject({
        _tag: "InfrastructureError",
        operation: "commit local cost usage scan",
      });
      await expect(
        Effect.runPromise(persistence.costs.localScanCheckpoint("codex", sourceKey)),
      ).resolves.toBe(first.checkpointJson);
      await expect(Effect.runPromise(persistence.costs.list("codex", 0))).resolves.toEqual(
        first.records,
      );

      await Effect.runPromise(
        persistence.costs.commitLocalScan({
          ...first,
          expectedCheckpointJson: first.checkpointJson,
          checkpointJson: JSON.stringify({ cursor: 30 }),
          reset: true,
          records: [{ ...first.records[0]!, recordedAt: 30, costUsd: 0.03 }],
        }),
      );
      await expect(Effect.runPromise(persistence.costs.list("codex", 0))).resolves.toEqual([
        { ...first.records[0]!, recordedAt: 30, costUsd: 0.03 },
      ]);
      await expect(
        Effect.runPromise(persistence.costs.localScanCheckpoint("codex", sourceKey)),
      ).resolves.toBe(JSON.stringify({ cursor: 30 }));
    } finally {
      await Effect.runPromise(persistence.close);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("allows exactly one stale local scanner commit across two database instances", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexbar-local-cost-scan-cas-"));
    const databasePath = join(directory, "usage.sqlite");
    const first = await Effect.runPromise(makeNodeSqlitePersistence({ databasePath }));
    const second = await Effect.runPromise(makeNodeSqlitePersistence({ databasePath }));
    const sourceKey = "local-jsonl:cas-fixture";
    const initialCheckpoint = JSON.stringify({ cursor: 0 });
    const commit = (cursor: number, costUsd: number) => ({
      providerId: "codex" as ProviderId,
      sourceKey,
      expectedCheckpointJson: initialCheckpoint,
      checkpointJson: JSON.stringify({ cursor }),
      records: [
        {
          providerId: "codex" as ProviderId,
          recordedAt: cursor,
          inputTokens: cursor,
          outputTokens: 1,
          costUsd,
        },
      ],
    });
    try {
      await Effect.runPromise(
        first.costs.commitLocalScan({
          providerId: "codex",
          sourceKey,
          checkpointJson: initialCheckpoint,
          records: [],
        }),
      );
      const results = await Promise.allSettled([
        Effect.runPromise(first.costs.commitLocalScan(commit(10, 0.1))),
        Effect.runPromise(second.costs.commitLocalScan(commit(20, 0.2))),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((result) => result.status === "rejected");
      expect(rejected).toMatchObject({
        reason: {
          _tag: "InfrastructureError",
          operation: "commit local cost usage scan",
          causeValue: { name: "CostUsageScanCheckpointConflictError" },
        },
      });
      const rows = await Effect.runPromise(first.costs.list("codex", 0));
      expect(rows).toHaveLength(1);
      const checkpoint = await Effect.runPromise(
        first.costs.localScanCheckpoint("codex", sourceKey),
      );
      expect([JSON.stringify({ cursor: 10 }), JSON.stringify({ cursor: 20 })]).toContain(
        checkpoint,
      );
      expect(checkpoint).toBe(JSON.stringify({ cursor: rows[0]!.recordedAt }));
    } finally {
      await Effect.runPromise(first.close);
      await Effect.runPromise(second.close);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("commits a fork family as one CAS-protected replacement and rolls it back on failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexbar-local-cost-family-"));
    const databasePath = join(directory, "usage.sqlite");
    const persistence = await Effect.runPromise(makeNodeSqlitePersistence({ databasePath }));
    const familyKey = "family-v1:codex:fixture";
    const parentKey = "jsonl-v1:codex:parent";
    const childKey = "jsonl-v1:codex:child";
    const manifest = (
      entries: readonly { readonly sourceKey: string; readonly checkpointJson: string }[],
    ) =>
      JSON.stringify({
        version: 1,
        scanner: "codex-fork-family",
        sourceKeys: entries.map(({ sourceKey }) => sourceKey),
        checkpointHashes: Object.fromEntries(
          entries.map(({ sourceKey, checkpointJson }) => [
            sourceKey,
            createHash("sha256").update(checkpointJson).digest("hex"),
          ]),
        ),
      });
    const record = (sourceKey: string, recordedAt: number, costUsd: number) => ({
      providerId: "codex" as ProviderId,
      recordedAt,
      inputTokens: recordedAt,
      outputTokens: 1,
      costUsd,
      sourceKey,
    });
    try {
      const parentCheckpoint = JSON.stringify({ cursor: 10 });
      const childCheckpoint = JSON.stringify({ cursor: 20 });
      await Effect.runPromise(
        persistence.costs.commitLocalScanFamily({
          providerId: "codex",
          familyKey,
          manifestJson: manifest([
            { sourceKey: parentKey, checkpointJson: parentCheckpoint },
            { sourceKey: childKey, checkpointJson: childCheckpoint },
          ]),
          members: [
            {
              providerId: "codex",
              sourceKey: parentKey,
              checkpointJson: parentCheckpoint,
              records: [record(parentKey, 10, 0.01)],
              reset: true,
            },
            {
              providerId: "codex",
              sourceKey: childKey,
              checkpointJson: childCheckpoint,
              records: [record(childKey, 20, 0.02)],
              reset: true,
            },
          ],
          removals: [],
        }),
      );
      const firstManifest = manifest([
        { sourceKey: parentKey, checkpointJson: parentCheckpoint },
        { sourceKey: childKey, checkpointJson: childCheckpoint },
      ]);
      const inspection = new DatabaseSync(databasePath);
      try {
        inspection.exec(`
          CREATE TRIGGER fixture_abort_local_cost_family
          BEFORE INSERT ON cost_usage_records
          WHEN NEW.provider_id = 'codex' AND NEW.cost_usd = 0.03
          BEGIN SELECT RAISE(ABORT, 'fixture local family failure'); END;
        `);
      } finally {
        inspection.close();
      }
      await expect(
        Effect.runPromise(
          persistence.costs.commitLocalScanFamily({
            providerId: "codex",
            familyKey,
            expectedManifestJson: firstManifest,
            manifestJson: manifest([
              { sourceKey: parentKey, checkpointJson: JSON.stringify({ cursor: 30 }) },
            ]),
            members: [
              {
                providerId: "codex",
                sourceKey: parentKey,
                expectedCheckpointJson: JSON.stringify({ cursor: 10 }),
                checkpointJson: JSON.stringify({ cursor: 30 }),
                records: [record(parentKey, 30, 0.03)],
                reset: true,
              },
            ],
            removals: [{ sourceKey: childKey, expectedCheckpointJson: childCheckpoint }],
          }),
        ),
      ).rejects.toMatchObject({
        _tag: "InfrastructureError",
        operation: "commit local cost usage scan family",
      });
      // The rejected transaction restores both former members and the
      // manifest; no partial removal/checkpoint publication is observable.
      await expect(Effect.runPromise(persistence.costs.list("codex", 0))).resolves.toHaveLength(2);
      await expect(
        Effect.runPromise(persistence.costs.localScanCheckpoint("codex", familyKey)),
      ).resolves.toBe(firstManifest);

      await expect(
        Effect.runPromise(
          persistence.costs.commitLocalScanFamily({
            providerId: "codex",
            familyKey,
            expectedManifestJson: firstManifest,
            manifestJson: manifest([
              { sourceKey: parentKey, checkpointJson: JSON.stringify({ cursor: 31 }) },
            ]),
            members: [
              {
                providerId: "codex",
                sourceKey: parentKey,
                expectedCheckpointJson: JSON.stringify({ cursor: 10 }),
                checkpointJson: JSON.stringify({ cursor: 31 }),
                records: [record(parentKey, 31, 0.031)],
                reset: true,
              },
            ],
            removals: [{ sourceKey: "jsonl-v1:codex:not-owned" }],
          }),
        ),
      ).rejects.toMatchObject({
        _tag: "InfrastructureError",
        operation: "commit local cost usage scan family",
      });

      // A stale inventory must not erase an archived member that a legacy
      // single-source refresh advanced after this family pass began.
      const advancedChildCheckpoint = JSON.stringify({ cursor: 21 });
      await Effect.runPromise(
        persistence.costs.commitLocalScan({
          providerId: "codex",
          sourceKey: childKey,
          expectedCheckpointJson: childCheckpoint,
          checkpointJson: advancedChildCheckpoint,
          records: [record(childKey, 21, 0.021)],
          reset: true,
        }),
      );
      await expect(
        Effect.runPromise(
          persistence.costs.commitLocalScanFamily({
            providerId: "codex",
            familyKey,
            expectedManifestJson: firstManifest,
            manifestJson: manifest([
              { sourceKey: parentKey, checkpointJson: JSON.stringify({ cursor: 32 }) },
            ]),
            members: [
              {
                providerId: "codex",
                sourceKey: parentKey,
                expectedCheckpointJson: parentCheckpoint,
                checkpointJson: JSON.stringify({ cursor: 32 }),
                records: [record(parentKey, 32, 0.032)],
                reset: true,
              },
            ],
            // The source read was refreshed after the family manifest was
            // observed. Even though this checkpoint now matches the table,
            // it is not the checkpoint bound into that manifest and cannot
            // authorize removal under the stale topology.
            removals: [{ sourceKey: childKey, expectedCheckpointJson: advancedChildCheckpoint }],
          }),
        ),
      ).rejects.toMatchObject({
        _tag: "InfrastructureError",
        operation: "commit local cost usage scan family",
        causeValue: { name: "CostUsageScanCheckpointConflictError" },
      });
      await expect(
        Effect.runPromise(persistence.costs.localScanCheckpoint("codex", childKey)),
      ).resolves.toBe(advancedChildCheckpoint);
    } finally {
      await Effect.runPromise(persistence.close);
      await rm(directory, { recursive: true, force: true });
    }
  });

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

      // The Swift store keeps the database after recoverable SQLite write
      // failures, then continues using the same durable artifact once the
      // condition is resolved. This portable trigger exercises the constraint
      // path; disk-full injection is filesystem-specific but uses the same
      // transaction/rollback boundary.
      const recovery = new DatabaseSync(databasePath);
      try {
        recovery.exec("DROP TRIGGER fixture_abort_cost_retention");
      } finally {
        recovery.close();
      }
      await expect(Effect.runPromise(persistence.retention.prune({ before: 3 }))).resolves.toEqual({
        deletedHistoryRecords: 2,
        deletedCostUsageRecords: 2,
      });
      await expect(Effect.runPromise(persistence.history.list("codex", 0))).resolves.toEqual([]);
      await expect(Effect.runPromise(persistence.costs.list("codex", 0))).resolves.toEqual([]);
    } finally {
      await Effect.runPromise(persistence.close);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves the database and live connection after a genuine SQLite full write failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexbar-sqlite-full-"));
    const databasePath = join(directory, "usage.sqlite");
    const retained = {
      providerId: "codex" as ProviderId,
      recordedAt: 1,
      snapshot: snapshot("2026-01-01T00:00:01Z"),
    };
    try {
      // Seed a valid retained artifact before capping its page count. A fresh
      // connection then runs the cap migration below, so the same writer that
      // executes the append sees SQLite's real capacity limit.
      const seedPersistence = await Effect.runPromise(makeNodeSqlitePersistence({ databasePath }));
      try {
        await Effect.runPromise(seedPersistence.history.append(retained));
      } finally {
        await Effect.runPromise(seedPersistence.close);
      }

      // `max_page_count` is enforced by SQLite itself: assigning one asks it
      // to use the current (non-shrinkable) page count. This is a deterministic
      // portable analogue of a full filesystem, unlike a trigger/constraint
      // surrogate. We intentionally do not exhaust the shared test host's
      // filesystem. The cap is persisted in the database header, and applying
      // it through the persistence migration guarantees the writer under test
      // is already open when the capacity boundary is established.
      const persistence = await Effect.runPromise(
        makeNodeSqlitePersistence({
          databasePath,
          migrations: [
            ...NODE_PERSISTENCE_MIGRATIONS,
            { version: 4, sql: "PRAGMA max_page_count = 1;" },
          ],
        }),
      );
      try {
        let failure: unknown;
        try {
          await Effect.runPromise(
            persistence.history.append({
              providerId: "codex",
              recordedAt: 2,
              snapshot: {
                ...snapshot("2026-01-01T00:00:02Z"),
                // This is deliberately opaque provider payload, matching the
                // persisted UsageSnapshot contract rather than bypassing it.
                openAIAPIUsage: { payload: "x".repeat(128 * 1024) },
              },
            }),
          );
        } catch (error) {
          failure = error;
        }
        expect(failure).toMatchObject({
          _tag: "InfrastructureError",
          operation: "append history record",
        });
        const sqliteFailure = (failure as { readonly causeValue?: unknown }).causeValue as {
          readonly errcode?: unknown;
          readonly message?: unknown;
        };
        // SQLite's primary SQLITE_FULL result code is 13. node:sqlite exposes
        // it as `errcode` while the JavaScript error code stays generic.
        expect(sqliteFailure.errcode).toBe(13);
        expect(sqliteFailure.message).toMatch(/database or disk is full/i);

        // The failed BEGIN IMMEDIATE transaction is rolled back, not rebuilt
        // or pruned. A small write fits the existing B-tree page, proving the
        // same live persistence connection recovers without reopening the DB.
        await expect(Effect.runPromise(persistence.history.list("codex", 0))).resolves.toEqual([
          retained,
        ]);
        await Effect.runPromise(
          persistence.history.append({
            providerId: "codex",
            recordedAt: 3,
            snapshot: snapshot("2026-01-01T00:00:03Z"),
          }),
        );
        await expect(Effect.runPromise(persistence.history.list("codex", 0))).resolves.toEqual([
          retained,
          {
            providerId: "codex",
            recordedAt: 3,
            snapshot: snapshot("2026-01-01T00:00:03Z"),
          },
        ]);
      } finally {
        await Effect.runPromise(persistence.close);
      }
    } finally {
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
      expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(3);
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
            version: 4,
            destructive: true,
            sql: "CREATE TABLE migration_witness (id INTEGER PRIMARY KEY)",
          },
        ],
      }),
    );
    try {
      expect(
        (await readdir(directory)).some((name) => name.startsWith("usage.sqlite.backup-v4-")),
      ).toBe(true);
      const backupName = (await readdir(directory)).find((name) =>
        name.startsWith("usage.sqlite.backup-v4-"),
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
    await Effect.runPromise(
      writable.costs.append({
        providerId: "codex" as ProviderId,
        recordedAt: 1,
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0.01,
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
      await expect(
        Effect.runPromise(readOnly.retention.prune({ before: 2 })),
      ).rejects.toMatchObject({
        _tag: "InfrastructureError",
        operation: "prune usage records",
      });
      await expect(Effect.runPromise(readOnly.history.list("codex", 0))).resolves.toHaveLength(1);
      await expect(Effect.runPromise(readOnly.costs.list("codex", 0))).resolves.toHaveLength(1);
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
