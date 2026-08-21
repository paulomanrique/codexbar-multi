import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { backup, DatabaseSync } from "node:sqlite";
import { link, lstat, mkdir, open, readdir, readFile, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { Effect, Schema } from "effect";
import {
  decodeCodexBarConfig,
  encodeCodexBarConfig,
  type LegacyImportCandidate,
  type LegacyImportKind,
  type LegacyImportInspection,
  planLegacyImport,
  stripLegacyCredentials,
  type CostUsageRecord,
  type HistoryRecord,
  InfrastructureError,
} from "@codexbar/core";
import { decodeUsageSnapshot, ProviderId } from "@codexbar/contracts";
import { makeNodeSqlitePersistence } from "./node-persistence.ts";
import { makeNodePrivateFileStore } from "./node.ts";

const MAX_LEGACY_JSONL_BYTES = 25 * 1024 * 1024;
const MAX_LEGACY_PLUGIN_SOURCE_BYTES = 1 * 1024 * 1024;
const manifestVersion = 3;
const excludedFeatures = ["icloud", "widgetkit", "sparkle", "approvals"] as const;

export interface NodeLegacyImportOptions {
  /** An explicit user-selected directory containing the old, copied data. */
  readonly legacyRoot: string;
  /** CodexBar Multi's data root.  This adapter never guesses an OS path. */
  readonly destinationRoot: string;
  readonly databasePath: string;
  /** Stable retry key; omit it to make a fresh, opt-in import. */
  readonly importId?: string;
  readonly configFile?: string;
  readonly historyFile?: string;
  readonly costsFile?: string;
  readonly pluginsDirectory?: string;
  readonly targetConfigPath?: string;
  readonly targetPluginsPath?: string;
  readonly signal?: AbortSignal;
}

export interface NodeLegacyImportResult {
  readonly importId: string;
  readonly status: "completed" | "already-completed";
  readonly inspection: LegacyImportInspection;
  readonly imported: Readonly<Record<"config" | "history" | "cost" | "plugins", number>>;
  readonly skipped: readonly string[];
}

export interface NodeLegacyRollbackResult {
  readonly importId: string;
  readonly removed: Readonly<Record<"config" | "history" | "cost" | "plugins", number>>;
  readonly skipped: readonly string[];
}

interface LoadedLegacySources {
  readonly inspection: LegacyImportInspection;
  readonly config: ReturnType<typeof decodeCodexBarConfig> | undefined;
  readonly history: readonly HistoryRecord[];
  readonly costs: readonly CostUsageRecord[];
  readonly plugins: readonly string[];
}

interface LegacyImportManifest {
  readonly version: number;
  readonly importId: string;
  readonly state: "in-progress" | "completed";
  readonly config?: { readonly path: string; readonly sha256: string };
  readonly database?: { readonly path: string; readonly backupPath: string };
  readonly plugins: readonly LegacyImportedPlugin[];
}

/** A rollback may remove only the exact, unchanged file that this import created. */
interface LegacyImportedPlugin {
  readonly path: string;
  /** Private sibling hard-linked to path; it is the ownership proof for rollback. */
  readonly proofPath: string;
  readonly sha256: string;
}

/** Journal format from the initial pre-release directory-plugin importer. */
interface LegacyImportManifestV1 {
  readonly version: 1;
  readonly importId: string;
  readonly state: "in-progress" | "completed";
  readonly config?: { readonly path: string; readonly sha256: string };
  readonly database?: { readonly path: string; readonly backupPath: string };
  readonly plugins: readonly string[];
}

type ReadLegacyImportManifest = LegacyImportManifest | LegacyImportManifestV1;

/** Inspecting is read-only and reports only source names/counts, never JSON or secret values. */
export const inspectNodeLegacyImport = (
  options: NodeLegacyImportOptions,
): Effect.Effect<LegacyImportInspection, InfrastructureError> =>
  Effect.tryPromise({
    try: async () => (await loadLegacySources(options)).inspection,
    catch: (error) => toInfrastructureError("inspect legacy import", error),
  });

/**
 * Copies only safe configuration and rescanned JSON/JSONL history.  It does
 * not read legacy keychains, browser sessions, iCloud, WidgetKit or Sparkle.
 */
export const executeNodeLegacyImport = (
  options: NodeLegacyImportOptions,
): Effect.Effect<NodeLegacyImportResult, InfrastructureError> =>
  Effect.tryPromise({
    try: async () => {
      assertNotAborted(options.signal);
      const importId = options.importId ?? `legacy-${randomUUID()}`;
      const sources = await loadLegacySources(options);
      planLegacyImport(importId, sources.inspection);
      const layout = resolveLayout(options, importId);
      await ensureRealDestinationDirectory(layout.root, layout.root);
      const existing = await readManifest(layout.manifestPath);
      if (existing?.state === "completed") {
        return {
          importId,
          status: "already-completed" as const,
          inspection: sources.inspection,
          imported: { config: 0, history: 0, cost: 0, plugins: 0 },
          skipped: [],
        };
      }
      if (existing !== undefined) await rollbackManifest(existing, layout);

      let manifest: LegacyImportManifest = {
        version: manifestVersion,
        importId,
        state: "in-progress",
        plugins: [],
      };
      await writeManifest(layout.manifestPath, manifest, layout.root);
      const skipped: string[] = [];
      const imported = { config: 0, history: 0, cost: 0, plugins: 0 };
      try {
        if (sources.config !== undefined) {
          assertNotAborted(options.signal);
          const safeConfig = stripLegacyCredentials(sources.config);
          const content = new TextEncoder().encode(
            `${JSON.stringify(encodeCodexBarConfig(safeConfig))}\n`,
          );
          const created = await makeNodePrivateFileStore()
            .writeAtomicIfAbsent(layout.targetConfigPath, content)
            .pipe(Effect.runPromise);
          if (!created) {
            skipped.push("config: target already exists");
          } else {
            manifest = {
              ...manifest,
              config: { path: layout.targetConfigPath, sha256: sha256(content) },
            };
            await writeManifest(layout.manifestPath, manifest, layout.root);
            imported.config = 1;
          }
        }

        if (sources.history.length > 0 || sources.costs.length > 0) {
          assertNotAborted(options.signal);
          const database = await openImportDatabase(layout.databasePath);
          try {
            const backupPath = `${layout.databasePath}.legacy-import-${importId}.backup`;
            manifest = { ...manifest, database: { path: layout.databasePath, backupPath } };
            await writeManifest(layout.manifestPath, manifest, layout.root);
            await backup(database, backupPath);
            database.exec("BEGIN IMMEDIATE");
            try {
              database.prepare("INSERT INTO legacy_imports (import_id) VALUES (?)").run(importId);
              for (const record of sources.history) {
                assertNotAborted(options.signal);
                database
                  .prepare("INSERT OR IGNORE INTO providers (provider_id) VALUES (?)")
                  .run(record.providerId);
                database
                  .prepare(
                    "INSERT INTO history_records (provider_id, recorded_at, snapshot_json) VALUES (?, ?, ?)",
                  )
                  .run(record.providerId, record.recordedAt, JSON.stringify(record.snapshot));
                const id = readLastInsertId(database);
                database
                  .prepare(
                    "INSERT INTO legacy_import_history (import_id, history_id) VALUES (?, ?)",
                  )
                  .run(importId, id);
                imported.history += 1;
              }
              for (const record of sources.costs) {
                assertNotAborted(options.signal);
                database
                  .prepare("INSERT OR IGNORE INTO providers (provider_id) VALUES (?)")
                  .run(record.providerId);
                database
                  .prepare(
                    "INSERT INTO cost_usage_records (provider_id, recorded_at, input_tokens, output_tokens, cost_usd) VALUES (?, ?, ?, ?, ?)",
                  )
                  .run(
                    record.providerId,
                    record.recordedAt,
                    record.inputTokens,
                    record.outputTokens,
                    record.costUsd,
                  );
                const id = readLastInsertId(database);
                database
                  .prepare("INSERT INTO legacy_import_costs (import_id, cost_id) VALUES (?, ?)")
                  .run(importId, id);
                imported.cost += 1;
              }
              database.exec("COMMIT");
            } catch (error) {
              if (database.isTransaction) database.exec("ROLLBACK");
              throw error;
            }
          } finally {
            database.close();
          }
        }

        for (const plugin of sources.plugins) {
          assertNotAborted(options.signal);
          const destination = join(layout.targetPluginsPath, basename(plugin));
          const source = await readPluginSource(plugin);
          await ensureRealDestinationDirectory(layout.root, layout.targetPluginsPath);
          await assertRealDestinationDirectory(layout.root, layout.targetPluginsPath);
          const proofPath = join(
            layout.targetPluginsPath,
            `.codexbar-multi-legacy-proof-${randomUUID()}`,
          );
          await writePluginProof(layout.root, layout.targetPluginsPath, proofPath, source);
          const importedPlugin = { path: destination, proofPath, sha256: sha256(source) };
          manifest = { ...manifest, plugins: [...manifest.plugins, importedPlugin] };
          await writeManifest(layout.manifestPath, manifest, layout.root);
          const created = await publishPluginProof(
            layout.root,
            layout.targetPluginsPath,
            destination,
            proofPath,
          );
          if (!created) {
            const existing = await lstat(destination);
            if (existing.isSymbolicLink() || !existing.isFile()) {
              throw new Error("Legacy plugin destination is not a regular file");
            }
            await rm(proofPath, { force: true });
            manifest = {
              ...manifest,
              plugins: manifest.plugins.filter((entry) => entry !== importedPlugin),
            };
            await writeManifest(layout.manifestPath, manifest, layout.root);
            skipped.push("plugin target already exists");
            continue;
          }
          imported.plugins += 1;
        }
        manifest = { ...manifest, state: "completed" };
        await writeManifest(layout.manifestPath, manifest, layout.root);
        return {
          importId,
          status: "completed" as const,
          inspection: sources.inspection,
          imported,
          skipped,
        };
      } catch (error) {
        await rollbackManifest(manifest, layout);
        throw error;
      }
    },
    catch: (error) => toInfrastructureError("execute legacy import", error),
  });

/** Rollback is manifest-driven: it never scans or removes legacy source data. */
export const rollbackNodeLegacyImport = (
  options: NodeLegacyImportOptions & { readonly importId: string },
): Effect.Effect<NodeLegacyRollbackResult, InfrastructureError> =>
  Effect.tryPromise({
    try: async () => {
      const layout = resolveLayout(options, options.importId);
      const manifest = await readManifest(layout.manifestPath);
      if (manifest === undefined) {
        return {
          importId: options.importId,
          removed: { config: 0, history: 0, cost: 0, plugins: 0 },
          skipped: ["no import journal"],
        };
      }
      const result = await rollbackManifest(manifest, layout);
      await rm(layout.manifestPath, { force: true });
      return result;
    },
    catch: (error) => toInfrastructureError("rollback legacy import", error),
  });

const resolveLayout = (options: NodeLegacyImportOptions, importId: string) => {
  const root = resolve(options.destinationRoot);
  const targetConfigPath = resolve(options.targetConfigPath ?? join(root, "config.json"));
  const targetPluginsPath = resolve(options.targetPluginsPath ?? join(root, "plugins"));
  const databasePath = resolve(options.databasePath);
  if (
    !inside(root, targetConfigPath) ||
    !inside(root, targetPluginsPath) ||
    !inside(root, databasePath)
  ) {
    throw new Error("Legacy import targets must stay inside the destination root");
  }
  return {
    root,
    manifestPath: join(root, "legacy-imports", `${importId}.json`),
    targetConfigPath,
    targetPluginsPath,
    databasePath,
  };
};

const loadLegacySources = async (
  options: NodeLegacyImportOptions,
): Promise<LoadedLegacySources> => {
  const configPath = legacyEntry(options.legacyRoot, options.configFile ?? "config.json");
  const historyPath = legacyEntry(options.legacyRoot, options.historyFile ?? "history.jsonl");
  const costsPath = legacyEntry(options.legacyRoot, options.costsFile ?? "costs.jsonl");
  const pluginsPath = legacyEntry(options.legacyRoot, options.pluginsDirectory ?? "providers");
  const candidates: LegacyImportCandidate[] = [];
  let config: ReturnType<typeof decodeCodexBarConfig> | undefined;
  let history: readonly HistoryRecord[] = [];
  let costs: readonly CostUsageRecord[] = [];
  let plugins: readonly string[] = [];

  const loadedConfig = await loadJson(configPath, "config", (value) => decodeCodexBarConfig(value));
  candidates.push(loadedConfig.candidate);
  config = loadedConfig.value;
  const loadedHistory = await loadRecordFile(historyPath, "history", decodeLegacyHistoryRecord);
  candidates.push(loadedHistory.candidate);
  history = loadedHistory.value;
  const loadedCosts = await loadRecordFile(costsPath, "cost", decodeLegacyCostRecord);
  candidates.push(loadedCosts.candidate);
  costs = loadedCosts.value;
  const loadedPlugins = await loadPlugins(pluginsPath);
  candidates.push(loadedPlugins.candidate);
  plugins = loadedPlugins.value;
  return {
    inspection: { candidates, excludedFeatures, sqliteCompatibility: "not-attempted" },
    config,
    history,
    costs,
    plugins,
  };
};

const loadJson = async <Value>(
  path: string,
  kind: "config",
  decode: (value: unknown) => Value,
): Promise<{ readonly candidate: LegacyImportCandidate; readonly value: Value | undefined }> => {
  if (!(await exists(path))) return { candidate: missingCandidate(kind), value: undefined };
  const content = await readBounded(path);
  try {
    return {
      candidate: {
        kind,
        source: sourceIdentifier(kind),
        state: "ready",
        itemCount: 1,
        byteCount: content.length,
      },
      value: decode(JSON.parse(new TextDecoder().decode(content))),
    };
  } catch (error) {
    return { candidate: invalidCandidate(kind, content.length, error), value: undefined };
  }
};

/** JSONL is the default; a bounded JSON array is also supported for old fixture exports. */
const loadRecordFile = async <Value>(
  path: string,
  kind: "history" | "cost",
  decode: (value: unknown) => Value,
): Promise<{ readonly candidate: LegacyImportCandidate; readonly value: readonly Value[] }> => {
  if (!(await exists(path))) return { candidate: missingCandidate(kind), value: [] };
  const content = await readBounded(path);
  try {
    const text = new TextDecoder().decode(content);
    const records = path.toLowerCase().endsWith(".json")
      ? decodeJsonArray(text, decode)
      : text
          .split(/\r?\n/u)
          .filter((line) => line.trim().length > 0)
          .map((line, index) => {
            try {
              return decode(JSON.parse(line));
            } catch (error) {
              throw new Error(`line ${index + 1}: ${errorMessage(error)}`);
            }
          });
    return {
      candidate: {
        kind,
        source: sourceIdentifier(kind),
        state: "ready",
        itemCount: records.length,
        byteCount: content.length,
      },
      value: records,
    };
  } catch (error) {
    return { candidate: invalidCandidate(kind, content.length, error), value: [] };
  }
};

const decodeJsonArray = <Value>(
  text: string,
  decode: (value: unknown) => Value,
): readonly Value[] => {
  const input = JSON.parse(text);
  if (!Array.isArray(input)) throw new TypeError("legacy JSON record export must be an array");
  return input.map((entry, index) => {
    try {
      return decode(entry);
    } catch (error) {
      throw new Error(`entry ${index + 1}: ${errorMessage(error)}`);
    }
  });
};

const loadPlugins = async (
  path: string,
): Promise<{ readonly candidate: LegacyImportCandidate; readonly value: readonly string[] }> => {
  if (!(await exists(path))) return { candidate: missingCandidate("plugins"), value: [] };
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("Legacy plugin source must be a real directory");
  }
  const entries = await readdir(path, { withFileTypes: true });
  const plugins: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isSymbolicLink()) throw new Error("Legacy plugin source contains a symlink");
    if (!entry.isFile() || !isPluginSourceName(entry.name)) continue;
    const source = join(path, entry.name);
    await readPluginSource(source);
    plugins.push(source);
  }
  return {
    candidate: {
      kind: "plugins",
      source: sourceIdentifier("plugins"),
      state: "ready",
      itemCount: plugins.length,
      byteCount: 0,
    },
    value: plugins,
  };
};

const decodeLegacyHistoryRecord = (input: unknown): HistoryRecord => {
  const value = object(input, "history record");
  const providerId = Schema.decodeUnknownSync(ProviderId)(value.providerId ?? value.provider_id);
  const recordedAt = epoch(value.recordedAt ?? value.recorded_at, "history.recordedAt");
  const rawSnapshot = value.snapshot ?? value.usageSnapshot ?? value.usage_snapshot;
  const snapshot = decodeUsageSnapshot(
    typeof rawSnapshot === "string" ? JSON.parse(rawSnapshot) : rawSnapshot,
  );
  return { providerId, recordedAt, snapshot };
};

const decodeLegacyCostRecord = (input: unknown): CostUsageRecord => {
  const value = object(input, "cost record");
  const providerId = Schema.decodeUnknownSync(ProviderId)(value.providerId ?? value.provider_id);
  const recordedAt = epoch(value.recordedAt ?? value.recorded_at, "cost.recordedAt");
  const inputTokens = finiteNatural(value.inputTokens ?? value.input_tokens, "cost.inputTokens");
  const outputTokens = finiteNatural(
    value.outputTokens ?? value.output_tokens,
    "cost.outputTokens",
  );
  const costUsd = value.costUsd ?? value.cost_usd;
  if (typeof costUsd !== "number" || !Number.isFinite(costUsd) || costUsd < 0) {
    throw new TypeError("cost.costUsd must be a non-negative finite number");
  }
  return { providerId, recordedAt, inputTokens, outputTokens, costUsd };
};

const openImportDatabase = async (databasePath: string): Promise<DatabaseSync> => {
  const persistence = await Effect.runPromise(makeNodeSqlitePersistence({ databasePath }));
  await Effect.runPromise(persistence.close);
  const database = new DatabaseSync(databasePath, {
    allowExtension: false,
    enableForeignKeyConstraints: true,
    timeout: 5_000,
  });
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA synchronous = FULL");
  database.exec(`
    CREATE TABLE IF NOT EXISTS legacy_imports (
      import_id TEXT PRIMARY KEY NOT NULL
    );
    CREATE TABLE IF NOT EXISTS legacy_import_history (
      import_id TEXT NOT NULL REFERENCES legacy_imports(import_id),
      history_id INTEGER PRIMARY KEY NOT NULL REFERENCES history_records(id)
    );
    CREATE TABLE IF NOT EXISTS legacy_import_costs (
      import_id TEXT NOT NULL REFERENCES legacy_imports(import_id),
      cost_id INTEGER PRIMARY KEY NOT NULL REFERENCES cost_usage_records(id)
    );
  `);
  return database;
};

const rollbackManifest = async (
  manifest: ReadLegacyImportManifest,
  layout: ReturnType<typeof resolveLayout>,
): Promise<NodeLegacyRollbackResult> => {
  const removed = { config: 0, history: 0, cost: 0, plugins: 0 };
  const skipped: string[] = [];
  if (manifest.config !== undefined && !inside(layout.root, manifest.config.path)) {
    skipped.push("config path outside destination");
  } else if (manifest.config !== undefined && (await exists(manifest.config.path))) {
    const content = new Uint8Array(await readFile(manifest.config.path));
    if (sha256(content) === manifest.config.sha256) {
      await rm(manifest.config.path, { force: true });
      removed.config = 1;
    } else {
      skipped.push("config changed since import");
    }
  }
  for (const plugin of manifest.plugins) {
    if (typeof plugin === "string") {
      await rollbackV1Plugin(plugin, manifest.importId, layout, removed, skipped);
      continue;
    }
    if (!isDirectChild(layout.targetPluginsPath, plugin.path)) {
      skipped.push("plugin path outside target");
      continue;
    }
    try {
      await assertRealDestinationDirectory(layout.root, layout.targetPluginsPath);
    } catch {
      skipped.push("plugin destination is not a real directory");
      continue;
    }
    if (!isProofPath(layout.targetPluginsPath, plugin.proofPath)) {
      skipped.push("plugin ownership proof outside target");
      continue;
    }
    try {
      const [destination, proof] = await Promise.all([
        lstat(plugin.path, { bigint: true }),
        lstat(plugin.proofPath, { bigint: true }),
      ]);
      if (
        destination.isSymbolicLink() ||
        !destination.isFile() ||
        proof.isSymbolicLink() ||
        !proof.isFile() ||
        !sameFile(destination, proof)
      ) {
        skipped.push("plugin ownership proof no longer matches import");
        continue;
      }
      const content = await readPluginSource(plugin.path);
      if (sha256(content) !== plugin.sha256) {
        skipped.push("plugin changed since import");
        continue;
      }
      await rm(plugin.path, { force: true });
      await rm(plugin.proofPath, { force: true });
      removed.plugins += 1;
    } catch {
      skipped.push("plugin destination is not an unchanged regular file");
    }
  }
  if (manifest.database !== undefined) {
    const database = await openImportDatabaseFromExisting(
      manifest.database,
      layout,
      manifest.importId,
    );
    if (database !== undefined) {
      try {
        database.exec("BEGIN IMMEDIATE");
        try {
          const historyRows = database
            .prepare("SELECT history_id FROM legacy_import_history WHERE import_id = ?")
            .all(manifest.importId) as Array<Record<string, unknown>>;
          const costRows = database
            .prepare("SELECT cost_id FROM legacy_import_costs WHERE import_id = ?")
            .all(manifest.importId) as Array<Record<string, unknown>>;
          database
            .prepare("DELETE FROM legacy_import_history WHERE import_id = ?")
            .run(manifest.importId);
          database
            .prepare("DELETE FROM legacy_import_costs WHERE import_id = ?")
            .run(manifest.importId);
          for (const row of historyRows) {
            database
              .prepare("DELETE FROM history_records WHERE id = ?")
              .run(readRecordId(row, "history_id"));
          }
          for (const row of costRows) {
            database
              .prepare("DELETE FROM cost_usage_records WHERE id = ?")
              .run(readRecordId(row, "cost_id"));
          }
          database.prepare("DELETE FROM legacy_imports WHERE import_id = ?").run(manifest.importId);
          database.exec("COMMIT");
          removed.history = historyRows.length;
          removed.cost = costRows.length;
        } catch (error) {
          if (database.isTransaction) database.exec("ROLLBACK");
          throw error;
        }
      } finally {
        database.close();
      }
      await rm(manifest.database.backupPath, { force: true });
    }
  }
  return { importId: manifest.importId, removed, skipped };
};

/**
 * Version 1 was never a product release, but its journal is kept rollbackable
 * so an interrupted local pre-release import cannot strand its own directory
 * copies. The old marker is the ownership proof for that format.
 */
const rollbackV1Plugin = async (
  plugin: string,
  importId: string,
  layout: ReturnType<typeof resolveLayout>,
  removed: { config: number; history: number; cost: number; plugins: number },
  skipped: string[],
): Promise<void> => {
  if (!inside(layout.targetPluginsPath, plugin)) {
    skipped.push("plugin path outside target");
    return;
  }
  try {
    await assertRealDestinationDirectory(layout.root, layout.targetPluginsPath);
    await assertRealDestinationDirectory(layout.root, plugin);
    const marker = join(plugin, ".codexbar-multi-legacy-import.json");
    const markerValue = JSON.parse(await readFile(marker, "utf8")) as { importId?: unknown };
    if (markerValue.importId !== importId) {
      skipped.push("plugin marker mismatch");
      return;
    }
    await rm(plugin, { recursive: true, force: true });
    removed.plugins += 1;
  } catch {
    skipped.push("plugin marker unreadable");
  }
};

/** Database path is recorded only in the backup sibling; resolve it without any OS-specific lookup. */
const openImportDatabaseFromExisting = async (
  recorded: NonNullable<LegacyImportManifest["database"]>,
  layout: ReturnType<typeof resolveLayout>,
  importId: string,
): Promise<DatabaseSync | undefined> => {
  const suffix = `.legacy-import-${importId}.backup`;
  if (
    resolve(recorded.path) !== layout.databasePath ||
    recorded.backupPath !== `${layout.databasePath}${suffix}` ||
    !(await exists(layout.databasePath))
  ) {
    return undefined;
  }
  const database = new DatabaseSync(layout.databasePath, {
    allowExtension: false,
    enableForeignKeyConstraints: true,
    timeout: 5_000,
  });
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  return database;
};

/**
 * Swift's provider directory holds bounded .js/.ts files directly. Read the
 * opened inode rather than following a path while copying an untrusted legacy
 * directory; approvals are stored elsewhere and are never read here.
 */
const readPluginSource = async (path: string): Promise<Uint8Array> => {
  const source = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await source.stat();
    if (!info.isFile() || info.size > MAX_LEGACY_PLUGIN_SOURCE_BYTES) {
      throw new Error("Legacy plugin source must be a bounded regular file");
    }
    return new Uint8Array(await source.readFile());
  } finally {
    await source.close();
  }
};

/** Materializes an import-owned inode before it is published at the plugin path. */
const writePluginProof = async (
  destinationRoot: string,
  pluginsRoot: string,
  proofPath: string,
  source: Uint8Array,
): Promise<void> => {
  if (!isProofPath(pluginsRoot, proofPath)) {
    throw new Error("Legacy plugin ownership proof is invalid");
  }
  await assertRealDestinationDirectory(destinationRoot, pluginsRoot);
  const created = await makeNodePrivateFileStore()
    .writeAtomicIfAbsent(proofPath, source)
    .pipe(Effect.runPromise);
  if (!created) throw new Error("Legacy plugin ownership proof already exists");
  const info = await lstat(proofPath);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error("Legacy plugin ownership proof changed during copy");
  }
};

/** Hard-link the proof inode to the visible plugin path without replacing any entry. */
const publishPluginProof = async (
  destinationRoot: string,
  pluginsRoot: string,
  destination: string,
  proofPath: string,
): Promise<boolean> => {
  if (!isDirectChild(pluginsRoot, destination) || !isPluginSourceName(basename(destination))) {
    throw new Error("Legacy plugin destination is invalid");
  }
  await assertRealDestinationDirectory(destinationRoot, pluginsRoot);
  try {
    await link(proofPath, destination);
  } catch (error) {
    if (isAlreadyExists(error)) return false;
    throw error;
  }
  const [created, proof] = await Promise.all([
    lstat(destination, { bigint: true }),
    lstat(proofPath, { bigint: true }),
  ]);
  if (
    created.isSymbolicLink() ||
    !created.isFile() ||
    proof.isSymbolicLink() ||
    !proof.isFile() ||
    !sameFile(created, proof)
  ) {
    throw new Error("Legacy plugin destination changed during copy");
  }
  return true;
};

/**
 * Makes each destination component one at a time and immediately rejects a
 * symlink or non-directory. Node has no portable openat/no-follow directory
 * API, so every mutating operation also rechecks its directory chain.
 */
const ensureRealDestinationDirectory = async (root: string, path: string): Promise<void> => {
  const components = destinationComponents(root, path);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await assertRealDirectory(root);
  let current = root;
  for (const component of components) {
    await assertRealDirectory(current);
    current = join(current, component);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
    await assertRealDirectory(current);
  }
};

/** Checks the complete destination chain immediately before or after I/O. */
const assertRealDestinationDirectory = async (root: string, path: string): Promise<void> => {
  const components = destinationComponents(root, path);
  await assertRealDirectory(root);
  let current = root;
  for (const component of components) {
    current = join(current, component);
    await assertRealDirectory(current);
  }
};

const destinationComponents = (root: string, path: string): readonly string[] => {
  if (!inside(root, path))
    throw new Error("Legacy plugin destination escaped the destination root");
  const child = relative(resolve(root), resolve(path));
  return child === "" ? [] : child.split(/[\\/]/u);
};

const assertRealDirectory = async (path: string): Promise<void> => {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("Legacy plugin destination must be a real directory");
  }
};

const readManifest = async (path: string): Promise<ReadLegacyImportManifest | undefined> => {
  if (!(await exists(path))) return undefined;
  const value = JSON.parse(await readFile(path, "utf8")) as Partial<LegacyImportManifest>;
  if (
    typeof value.importId !== "string" ||
    (value.state !== "in-progress" && value.state !== "completed") ||
    !Array.isArray(value.plugins)
  ) {
    throw new Error("Legacy import journal is invalid");
  }
  if (value.version === 1 && value.plugins.every((entry) => typeof entry === "string")) {
    return value as unknown as LegacyImportManifestV1;
  }
  if (
    value.version === manifestVersion &&
    value.plugins.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        !Array.isArray(entry) &&
        typeof (entry as Partial<LegacyImportedPlugin>).path === "string" &&
        typeof (entry as Partial<LegacyImportedPlugin>).proofPath === "string" &&
        typeof (entry as Partial<LegacyImportedPlugin>).sha256 === "string",
    )
  ) {
    return value as LegacyImportManifest;
  }
  throw new Error("Legacy import journal is invalid");
};

const writeManifest = async (
  path: string,
  manifest: LegacyImportManifest,
  destinationRoot: string,
): Promise<void> => {
  await ensureRealDestinationDirectory(destinationRoot, dirname(path));
  await makeNodePrivateFileStore()
    .writeAtomic(path, new TextEncoder().encode(`${JSON.stringify(manifest)}\n`))
    .pipe(Effect.runPromise);
};

const legacyEntry = (root: string, entry: string): string => {
  if (
    entry.length === 0 ||
    entry === "." ||
    entry === ".." ||
    basename(entry) !== entry ||
    entry.includes("\\")
  ) {
    throw new Error("Legacy import source names must be direct child names");
  }
  return join(resolve(root), entry);
};

const readBounded = async (path: string): Promise<Uint8Array> => {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error("Legacy JSON source must be a real regular file");
  }
  if (info.size > MAX_LEGACY_JSONL_BYTES)
    throw new Error(`${basename(path)} exceeds the import size limit`);
  return new Uint8Array(await readFile(path));
};

const sourceIdentifier = (kind: LegacyImportKind): string => `legacy-${kind}`;

const missingCandidate = (kind: LegacyImportKind): LegacyImportCandidate => ({
  kind,
  source: sourceIdentifier(kind),
  state: "missing",
  itemCount: 0,
  byteCount: 0,
});

const invalidCandidate = (
  kind: LegacyImportKind,
  byteCount: number,
  _error: unknown,
): LegacyImportCandidate => ({
  kind,
  source: sourceIdentifier(kind),
  state: "invalid",
  itemCount: 0,
  byteCount,
  // Never serialize decoder text: third-party parsers can include source values.
  reason: "source could not be decoded",
});

const object = (value: unknown, description: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${description} must be an object`);
  }
  return value as Record<string, unknown>;
};

const epoch = (value: unknown, name: string): number => {
  if (typeof value === "string") value = Date.parse(value);
  return finiteNatural(value, name);
};

const finiteNatural = (value: unknown, name: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value as number;
};

const readLastInsertId = (database: DatabaseSync): number => {
  const row = database.prepare("SELECT last_insert_rowid() AS id").get() as
    | { id?: unknown }
    | undefined;
  if (typeof row?.id !== "number" || !Number.isSafeInteger(row.id)) {
    throw new Error("SQLite did not return a safe insert ID");
  }
  return row.id;
};

const readRecordId = (row: Record<string, unknown>, column: string): number => {
  const value = row[column];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`SQLite legacy-import column ${column} is invalid`);
  }
  return value;
};

const exists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
};

const isAlreadyExists = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";

const isPluginSourceName = (name: string): boolean =>
  !name.includes("/") &&
  !name.includes("\\") &&
  ![...name].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  }) &&
  /\.(?:js|ts)$/iu.test(name);
const isDirectChild = (parent: string, path: string): boolean =>
  dirname(resolve(path)) === resolve(parent) && basename(path) === basename(resolve(path));
const isProofPath = (parent: string, path: string): boolean =>
  isDirectChild(parent, path) &&
  /^\.codexbar-multi-legacy-proof-[0-9a-f-]{36}$/u.test(basename(path));
const sameFile = (
  left: { readonly dev: bigint; readonly ino: bigint },
  right: { readonly dev: bigint; readonly ino: bigint },
): boolean => left.ino > 0n && right.ino > 0n && left.dev === right.dev && left.ino === right.ino;
const inside = (root: string, path: string): boolean => {
  const result = relative(resolve(root), resolve(path));
  return result === "" || (!result.startsWith("..") && !result.includes(".." + "\\"));
};
const sha256 = (content: Uint8Array): string => createHash("sha256").update(content).digest("hex");
const assertNotAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted)
    throw signal.reason instanceof Error ? signal.reason : new Error("Legacy import cancelled");
};
const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
const toInfrastructureError = (operation: string, error: unknown): InfrastructureError =>
  error instanceof InfrastructureError
    ? error
    : new InfrastructureError(operation, `Unable to ${operation}.`, error);
