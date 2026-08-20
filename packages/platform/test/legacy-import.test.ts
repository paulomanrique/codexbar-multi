import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { makeNodeSqlitePersistence } from "../src/node-persistence.ts";
import {
  executeNodeLegacyImport,
  inspectNodeLegacyImport,
  rollbackNodeLegacyImport,
} from "../src/legacy-import.ts";

describe("Node legacy import", () => {
  it("copies only safe settings, rescans JSONL, excludes approvals, and rolls back its own work", async () => {
    const root = await mkdtemp(join(tmpdir(), "codexbar-legacy-import-"));
    const legacyRoot = join(root, "legacy");
    const destinationRoot = join(root, "multi");
    const databasePath = join(destinationRoot, "usage.sqlite");
    const options = { legacyRoot, destinationRoot, databasePath, importId: "fixture-import" };
    try {
      await mkdir(join(legacyRoot, "plugins", "fixture-plugin"), { recursive: true });
      await writeFile(
        join(legacyRoot, "config.json"),
        JSON.stringify({
          version: 1,
          providers: [
            {
              id: "openai",
              enabled: true,
              apiKey: "do-not-report-or-copy",
              extensions: { session: "do-not-copy", region: "also-provider-owned" },
            },
          ],
        }),
      );
      await writeFile(
        join(legacyRoot, "history.jsonl"),
        JSON.stringify({
          providerId: "openai",
          recordedAt: 10,
          snapshot: { details: [], updatedAt: "2026-01-01T00:00:00Z" },
        }) + "\n",
      );
      await writeFile(
        join(legacyRoot, "costs.jsonl"),
        JSON.stringify({
          providerId: "openai",
          recordedAt: 10,
          inputTokens: 2,
          outputTokens: 3,
          costUsd: 0.01,
        }) + "\n",
      );
      await writeFile(join(legacyRoot, "plugins", "fixture-plugin", "index.js"), "export {};\n");
      await writeFile(
        join(legacyRoot, "plugins", "fixture-plugin", "approvals.json"),
        '{"secret":"do-not-copy"}\n',
      );

      const inspection = await Effect.runPromise(inspectNodeLegacyImport(options));
      expect(JSON.stringify(inspection)).not.toContain("do-not-report-or-copy");
      expect(inspection.excludedFeatures).toContain("approvals");
      expect(inspection.sqliteCompatibility).toBe("not-attempted");

      const result = await Effect.runPromise(executeNodeLegacyImport(options));
      expect(result).toMatchObject({
        status: "completed",
        imported: { config: 1, history: 1, cost: 1, plugins: 1 },
      });
      const savedConfig = await readFile(join(destinationRoot, "config", "config.json"), "utf8");
      expect(savedConfig).not.toContain("do-not-report-or-copy");
      expect(savedConfig).not.toContain("session");
      expect(
        await readFile(join(destinationRoot, "plugins", "fixture-plugin", "index.js"), "utf8"),
      ).toBe("export {};\n");
      await expect(
        readFile(join(destinationRoot, "plugins", "fixture-plugin", "approvals.json"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(legacyRoot, "config.json"), "utf8")).toContain(
        "do-not-report-or-copy",
      );

      const persistence = await Effect.runPromise(makeNodeSqlitePersistence({ databasePath }));
      try {
        await expect(
          Effect.runPromise(persistence.history.list("openai", 0)),
        ).resolves.toHaveLength(1);
        await expect(Effect.runPromise(persistence.costs.list("openai", 0))).resolves.toHaveLength(
          1,
        );
      } finally {
        await Effect.runPromise(persistence.close);
      }
      await expect(Effect.runPromise(executeNodeLegacyImport(options))).resolves.toMatchObject({
        status: "already-completed",
      });

      await expect(Effect.runPromise(rollbackNodeLegacyImport(options))).resolves.toMatchObject({
        removed: { config: 1, history: 1, cost: 1, plugins: 1 },
      });
      const afterRollback = await Effect.runPromise(makeNodeSqlitePersistence({ databasePath }));
      try {
        await expect(
          Effect.runPromise(afterRollback.history.list("openai", 0)),
        ).resolves.toHaveLength(0);
        await expect(
          Effect.runPromise(afterRollback.costs.list("openai", 0)),
        ).resolves.toHaveLength(0);
      } finally {
        await Effect.runPromise(afterRollback.close);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the journal to clean up cancellation and does not overwrite an existing config", async () => {
    const root = await mkdtemp(join(tmpdir(), "codexbar-legacy-import-cancel-"));
    const legacyRoot = join(root, "legacy");
    const destinationRoot = join(root, "multi");
    const databasePath = join(destinationRoot, "usage.sqlite");
    try {
      await mkdir(join(legacyRoot, "plugins", "plugin"), { recursive: true });
      await mkdir(join(destinationRoot, "config"), { recursive: true });
      await writeFile(join(destinationRoot, "config", "config.json"), '{"owned":true}\n');
      await writeFile(join(legacyRoot, "config.json"), '{"version":1,"providers":[]}\n');
      const controller = new AbortController();
      controller.abort(new Error("test cancellation"));
      await expect(
        Effect.runPromise(
          executeNodeLegacyImport({
            legacyRoot,
            destinationRoot,
            databasePath,
            signal: controller.signal,
          }),
        ),
      ).rejects.toMatchObject({ _tag: "InfrastructureError" });
      expect(await readFile(join(destinationRoot, "config", "config.json"), "utf8")).toBe(
        '{"owned":true}\n',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("claims a legacy config atomically when imports race for the same destination", async () => {
    const root = await mkdtemp(join(tmpdir(), "codexbar-legacy-import-race-"));
    const destinationRoot = join(root, "multi");
    const databasePath = join(destinationRoot, "usage.sqlite");
    const firstLegacyRoot = join(root, "legacy-first");
    const secondLegacyRoot = join(root, "legacy-second");
    try {
      await Promise.all([
        mkdir(firstLegacyRoot, { recursive: true }),
        mkdir(secondLegacyRoot, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(
          join(firstLegacyRoot, "config.json"),
          '{"version":1,"providers":[{"id":"openai","enabled":true}]}\n',
        ),
        writeFile(
          join(secondLegacyRoot, "config.json"),
          '{"version":1,"providers":[{"id":"openai","enabled":false}]}\n',
        ),
      ]);

      const [first, second] = await Promise.all([
        Effect.runPromise(
          executeNodeLegacyImport({
            legacyRoot: firstLegacyRoot,
            destinationRoot,
            databasePath,
            importId: "first-racer",
          }),
        ),
        Effect.runPromise(
          executeNodeLegacyImport({
            legacyRoot: secondLegacyRoot,
            destinationRoot,
            databasePath,
            importId: "second-racer",
          }),
        ),
      ]);

      expect([first.imported.config, second.imported.config].filter(Boolean)).toHaveLength(1);
      expect([first.skipped, second.skipped].filter((skipped) => skipped.length > 0)).toHaveLength(
        1,
      );
      const saved = JSON.parse(
        await readFile(join(destinationRoot, "config", "config.json"), "utf8"),
      ) as { providers: Array<{ enabled?: boolean }> };
      const expectedEnabled = first.imported.config === 1;
      expect(saved.providers[0]?.enabled).toBe(expectedEnabled);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses logical report identifiers and never serializes invalid source content", async () => {
    const root = await mkdtemp(join(tmpdir(), "codexbar-legacy-import-redaction-"));
    try {
      const legacyRoot = join(root, "legacy");
      await mkdir(legacyRoot, { recursive: true });
      await writeFile(join(legacyRoot, "private-alice.json"), '{"password":"do-not-report"}\n');
      const inspection = await Effect.runPromise(
        inspectNodeLegacyImport({
          legacyRoot,
          destinationRoot: join(root, "multi"),
          databasePath: join(root, "multi", "usage.sqlite"),
          configFile: "private-alice.json",
        }),
      );
      const report = JSON.stringify(inspection);
      expect(report).not.toContain("do-not-report");
      expect(report).not.toContain("private-alice.json");
      expect(inspection.candidates.find((candidate) => candidate.kind === "config")).toMatchObject({
        source: "legacy-config",
        state: "invalid",
        reason: "source could not be decoded",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects symlinked legacy sources before reading them", async () => {
    const root = await mkdtemp(join(tmpdir(), "codexbar-legacy-import-symlink-"));
    try {
      const legacyRoot = join(root, "legacy");
      const outside = join(root, "outside.json");
      await mkdir(legacyRoot, { recursive: true });
      await writeFile(outside, '{"version":1,"providers":[]}\n');
      await symlink(outside, join(legacyRoot, "config.json"));
      await expect(
        Effect.runPromise(
          inspectNodeLegacyImport({
            legacyRoot,
            destinationRoot: join(root, "multi"),
            databasePath: join(root, "multi", "usage.sqlite"),
          }),
        ),
      ).rejects.toMatchObject({ _tag: "InfrastructureError", operation: "inspect legacy import" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked plugin destination without writing through it", async () => {
    const root = await mkdtemp(join(tmpdir(), "codexbar-legacy-import-destination-symlink-"));
    const legacyRoot = join(root, "legacy");
    const destinationRoot = join(root, "multi");
    const outside = join(root, "outside");
    try {
      await mkdir(join(legacyRoot, "plugins", "fixture-plugin"), { recursive: true });
      await mkdir(join(destinationRoot, "plugins"), { recursive: true });
      await mkdir(outside, { recursive: true });
      await writeFile(join(legacyRoot, "plugins", "fixture-plugin", "index.js"), "export {};\n");
      await symlink(outside, join(destinationRoot, "plugins", "fixture-plugin"));

      await expect(
        Effect.runPromise(
          executeNodeLegacyImport({
            legacyRoot,
            destinationRoot,
            databasePath: join(destinationRoot, "usage.sqlite"),
            importId: "destination-symlink",
          }),
        ),
      ).rejects.toMatchObject({ _tag: "InfrastructureError", operation: "execute legacy import" });
      await expect(readFile(join(outside, "index.js"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        readFile(join(outside, ".codexbar-multi-legacy-import.json"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
