/**
 * Node composition for the bounded local JSONL cost scanners.
 *
 * This deliberately remains at the platform boundary: core receives parsed
 * rows and opaque checkpoint JSON, never a path, environment variable, or
 * operating-system branch.
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, posix, resolve, win32 } from "node:path";
import { Effect } from "effect";
import {
  InfrastructureError,
  type CodexJsonlPriorityTurn,
  type CostUsageRecord,
  type CostUsageRepositoryService,
} from "@codexbar/core";
import type { ProviderId } from "@codexbar/contracts";
import {
  CostJsonlSourceChangedError,
  inventoryNodeCostJsonlFiles,
  scanNodeClaudeCostJsonl,
  scanNodeCodexCostJsonl,
  scanNodeCodexForkFamily,
  type NodeClaudeCostJsonlState,
  type NodeCodexCostJsonlState,
} from "./node-cost-jsonl.ts";
import { resolveNodeCodexHome } from "./node-codex-home.ts";
import { makeNodeCodexPriorityTurnResolver } from "./node-codex-priority.ts";

const scannerCheckpointVersion = 1 as const;
const maximumScanAttempts = 2;
const maximumSourceBytes = 16 * 1024 * 1024;
const maximumLineBytes = 512 * 1024;
const maximumRowsPerSource = 50_000;
const maximumRowsPerCodexFamily = 50_000;
// Each family member is deliberately read twice (evidence + reconciled pass).
// Keep the aggregate bounded before opening any selected source.
const maximumCodexFamilyScanBytes = 64 * 1024 * 1024;
// `family-v1:` is reserved by the persistence contract for manifests and is
// deliberately disjoint from every physical local JSONL source key.
const codexFamilyKey = "family-v1:codex:local-jsonl";

export class LocalCostRefreshUnavailableError extends Error {
  constructor(providerId: ProviderId) {
    super(
      providerId === "cursor"
        ? "Cursor cost refresh requires its browser-session source, which is not available in this local scanner yet"
        : `Local cost refresh is unavailable for ${providerId}`,
    );
    this.name = "LocalCostRefreshUnavailableError";
  }
}

export class LocalCostRefreshCancelledError extends Error {
  constructor() {
    super("Cost refresh was cancelled");
    this.name = "LocalCostRefreshCancelledError";
  }
}

export interface NodeLocalCostRefreshResult {
  readonly providerId: "codex" | "claude";
  /** Deliberately aggregate-only: cost command output never reveals local paths. */
  readonly scannedSources: number;
  readonly committedSources: number;
  readonly retries: number;
  /** True only when directory traversal reached an inventory bound. */
  readonly inventoryTruncated: boolean;
  /** Inventory, source byte, oversized-line, or incomplete-tail bounds left coverage partial. */
  readonly incomplete: boolean;
}

export interface NodeLocalCostUsageScanner {
  readonly refresh: (
    providerId: ProviderId,
    signal?: AbortSignal,
  ) => Promise<NodeLocalCostRefreshResult>;
}

export interface NodeLocalCostUsageScannerOptions {
  readonly costs: CostUsageRepositoryService;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory?: string;
  readonly platform?: NodeJS.Platform;
  /** Test-only explicit roots; production uses the provider-owned locations below. */
  readonly roots?: Partial<Readonly<Record<"codex" | "claude", readonly string[]>>>;
  readonly maxSourceBytes?: number;
  /** Optional stricter aggregate read budget for one Codex fork family. */
  readonly maxCodexFamilyScanBytes?: number;
  /** Host-owned Codex trace database; absent defaults to `<CODEX_HOME>/logs_2.sqlite`. */
  readonly codexPriorityDatabasePath?: string;
}

interface CheckpointEnvelope<State> {
  readonly version: 1;
  readonly scanner: "codex" | "claude";
  readonly state: State;
}

interface CodexFamilyManifest {
  readonly version: 1;
  readonly scanner: "codex-fork-family";
  /** Source keys only: paths never enter persistence or CLI output. */
  readonly sourceKeys: readonly string[];
  /** Binds topology to the exact member checkpoints selected in this pass. */
  readonly checkpointHashes: Readonly<Record<string, string>>;
}

/**
 * Produces the local, no-network cost refresh capability used by desktop and
 * CLI composition roots. Cursor remains intentionally unavailable until its
 * separate cookie-authenticated native report is ported; it must never fall
 * back to an unrelated local source.
 */
export const makeNodeLocalCostUsageScanner = (
  options: NodeLocalCostUsageScannerOptions,
): NodeLocalCostUsageScanner => {
  const environment = options.environment ?? process.env;
  const home = options.homeDirectory ?? homedir();
  const platform = options.platform ?? process.platform;
  const defaultRoots = resolveNodeLocalCostRoots(environment, home, platform);
  const codexHome = resolveNodeCodexHome(environment, home, platform);
  const roots = {
    codex: options.roots?.codex ?? defaultRoots.codex,
    claude: options.roots?.claude ?? defaultRoots.claude,
  };
  const maxSourceBytes = boundedPositiveIntegerAtMost(
    options.maxSourceBytes ?? maximumSourceBytes,
    "maxSourceBytes",
    maximumSourceBytes,
  );
  const maxCodexFamilyBytes = boundedPositiveIntegerAtMost(
    options.maxCodexFamilyScanBytes ?? maximumCodexFamilyScanBytes,
    "maxCodexFamilyScanBytes",
    maximumCodexFamilyScanBytes,
  );
  // Explicit test roots are a closed corpus. Never reach into the ambient
  // Codex home beside them unless the host also explicitly supplied its trace
  // database; this keeps fixtures hermetic and avoids an accidental live
  // credential/trace probe during local tests.
  const resolvePriorityTurns =
    options.codexPriorityDatabasePath !== undefined || options.roots?.codex === undefined
      ? makeNodeCodexPriorityTurnResolver({
          databasePath: options.codexPriorityDatabasePath ?? join(codexHome, "logs_2.sqlite"),
        })
      : undefined;

  return {
    refresh: async (providerId, signal) => {
      if (providerId !== "codex" && providerId !== "claude") {
        throw new LocalCostRefreshUnavailableError(providerId);
      }
      throwIfCancelled(signal);
      const inventory = await inventoryNodeCostJsonlFiles({
        roots: roots[providerId],
        ...(signal === undefined ? {} : { signal }),
      });
      let committedSources = 0;
      let retries = 0;
      let incomplete = inventory.truncated;
      if (providerId === "codex") {
        const familyByteBoundExceeded =
          codexFamilyScanBytes(
            inventory.files.map((file) => file.size),
            maxSourceBytes,
          ) > maxCodexFamilyBytes;
        if (!inventory.truncated && !familyByteBoundExceeded) {
          let priorityTurns;
          try {
            priorityTurns = resolvePriorityTurns === undefined ? {} : await resolvePriorityTurns();
          } catch {
            // Treat an unreadable/corrupt priority source as incomplete and
            // leave the previous family generation authoritative. Repricing
            // the family as standard would silently erase a known surcharge.
            return {
              providerId,
              scannedSources: inventory.files.length,
              committedSources: 0,
              retries,
              inventoryTruncated: inventory.truncated,
              incomplete: true,
            };
          }
          const committed = await refreshCodexFamily({
            files: inventory.files.map((file) => file.path),
            costs: options.costs,
            maxSourceBytes,
            signal,
            priorityTurns,
          });
          committedSources = committed.committedSources;
          retries = committed.retries;
          incomplete ||= committed.incomplete;
        }
        return {
          providerId,
          scannedSources: inventory.files.length,
          committedSources,
          retries,
          inventoryTruncated: inventory.truncated,
          incomplete: incomplete || familyByteBoundExceeded,
        };
      }
      for (const file of inventory.files) {
        throwIfCancelled(signal);
        const sourceKey = localSourceKey(providerId, file.path);
        const result = await refreshOneSource({
          providerId,
          sourceKey,
          path: file.path,
          costs: options.costs,
          maxSourceBytes,
          signal,
        });
        committedSources += 1;
        retries += result.retries;
        incomplete ||= result.incomplete;
      }
      return {
        providerId,
        scannedSources: inventory.files.length,
        committedSources,
        retries,
        inventoryTruncated: inventory.truncated,
        incomplete,
      };
    },
  };
};

/**
 * Reconciles every discovered Codex rollout as one snapshot. This deliberately
 * does not reuse per-file incremental cursors: a child can inherit a copied
 * prefix from a parent in a different directory, so independent publication
 * would make the ledger depend on refresh order.
 */
const refreshCodexFamily = async (options: {
  readonly files: readonly string[];
  readonly costs: CostUsageRepositoryService;
  readonly maxSourceBytes: number;
  readonly signal: AbortSignal | undefined;
  readonly priorityTurns: Readonly<Record<string, CodexJsonlPriorityTurn>>;
}): Promise<{
  readonly committedSources: number;
  readonly retries: number;
  readonly incomplete: boolean;
}> => {
  let retries = 0;
  for (let attempt = 0; attempt < maximumScanAttempts; attempt += 1) {
    throwIfCancelled(options.signal);
    const expectedManifestJson = await Effect.runPromise(
      options.costs.localScanCheckpoint("codex", codexFamilyKey),
      options.signal === undefined ? {} : { signal: options.signal },
    );
    const priorManifest = decodeCodexFamilyManifest(expectedManifestJson);
    if (expectedManifestJson !== undefined && priorManifest === undefined) {
      throw new Error("Local Codex cost family manifest is invalid");
    }
    const sourceKeys = options.files.map((path) => localSourceKey("codex", path));
    try {
      const expectedCheckpoints = new Map<string, string | undefined>();
      for (const sourceKey of sourceKeys) {
        throwIfCancelled(options.signal);
        expectedCheckpoints.set(
          sourceKey,
          await Effect.runPromise(
            options.costs.localScanCheckpoint("codex", sourceKey),
            options.signal === undefined ? {} : { signal: options.signal },
          ),
        );
      }
      const family = await scanNodeCodexForkFamily({
        sources: options.files.map((path) => ({ path })),
        maxBytes: options.maxSourceBytes,
        maxLineBytes: maximumLineBytes,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        priorityTurns: options.priorityTurns,
      });
      // An unresolved member means the graph is incomplete or ambiguous. No
      // member checkpoint is advanced; keeping the old family is safer than
      // publishing an order-dependent partial total.
      if (family.hasUnresolvedLineage) {
        return { committedSources: 0, retries, incomplete: true };
      }
      const members = family.members.map((member) => {
        if (member.status !== "resolved" || member.scan === undefined) {
          throw new Error("Resolved Codex family member is missing its scan");
        }
        const sourceKey = localSourceKey("codex", member.path);
        if (member.scan.result.rows.length > maximumRowsPerSource) {
          throw new Error("Local Codex cost family source produced too many records");
        }
        return {
          providerId: "codex" as const,
          sourceKey,
          ...(expectedCheckpoints.get(sourceKey) === undefined
            ? {}
            : { expectedCheckpointJson: expectedCheckpoints.get(sourceKey)! }),
          checkpointJson: encodeCheckpoint("codex", member.scan.state),
          records: member.scan.result.rows.flatMap((row) => {
            const record = costRecordFromJsonlRow("codex", row);
            return record === undefined ? [] : [record];
          }),
          reset: true as const,
        };
      });
      const totalRecords = members.reduce((total, member) => total + member.records.length, 0);
      if (totalRecords > maximumRowsPerCodexFamily) {
        throw new Error("Local Codex cost family produced too many records");
      }
      const memberKeys = new Set(members.map((member) => member.sourceKey));
      const removals = [] as Array<{
        readonly sourceKey: string;
        readonly expectedCheckpointJson?: string;
      }>;
      for (const sourceKey of priorManifest?.sourceKeys ?? []) {
        if (memberKeys.has(sourceKey)) continue;
        throwIfCancelled(options.signal);
        const expectedCheckpointJson = await Effect.runPromise(
          options.costs.localScanCheckpoint("codex", sourceKey),
          options.signal === undefined ? {} : { signal: options.signal },
        );
        removals.push({
          sourceKey,
          ...(expectedCheckpointJson === undefined ? {} : { expectedCheckpointJson }),
        });
      }
      throwIfCancelled(options.signal);
      await Effect.runPromise(
        options.costs.commitLocalScanFamily({
          providerId: "codex",
          familyKey: codexFamilyKey,
          ...(expectedManifestJson === undefined ? {} : { expectedManifestJson }),
          manifestJson: encodeCodexFamilyManifest(members),
          members,
          removals,
        }),
        options.signal === undefined ? {} : { signal: options.signal },
      );
      return { committedSources: members.length, retries, incomplete: false };
    } catch (error) {
      if (isCancellation(error, options.signal)) throw new LocalCostRefreshCancelledError();
      if (
        attempt + 1 < maximumScanAttempts &&
        (isCheckpointConflict(error) || error instanceof CostJsonlSourceChangedError)
      ) {
        retries += 1;
        continue;
      }
      throw error;
    }
  }
  throw new Error("Local Codex cost family refresh retry limit exceeded");
};

/** Matches the Swift provider roots without exposing them through CLI output. */
export const resolveNodeLocalCostRoots = (
  environment: Readonly<Record<string, string | undefined>>,
  homeDirectory: string,
  platform: NodeJS.Platform,
): Readonly<Record<"codex" | "claude", readonly string[]>> => {
  const paths = platform === "win32" ? win32 : posix;
  const expand = (value: string | undefined, fallback: string): string => {
    const trimmed = value?.trim();
    if (trimmed === undefined || trimmed.length === 0) return fallback;
    if (trimmed === "~") return homeDirectory;
    if (trimmed.startsWith("~/") || trimmed.startsWith("~\\"))
      return paths.join(homeDirectory, trimmed.slice(2));
    return paths.resolve(trimmed);
  };
  const codexHome = resolveNodeCodexHome(environment, homeDirectory, platform);
  const codexSessions = paths.join(codexHome, "sessions");
  const codexArchived = paths.join(codexHome, "archived_sessions");
  const claudeConfig = environment.CLAUDE_CONFIG_DIR?.trim();
  // Claude treats a configured profile as one literal root. Without it, its
  // CLI and older desktop layouts use ~/.claude and ~/.config/claude.
  const claudeRoots =
    claudeConfig === undefined || claudeConfig.length === 0
      ? [
          paths.join(homeDirectory, ".config", "claude", "projects"),
          paths.join(homeDirectory, ".claude", "projects"),
        ]
      : [paths.join(expand(claudeConfig, homeDirectory), "projects")];
  return { codex: [codexSessions, codexArchived], claude: claudeRoots };
};

const refreshOneSource = async (options: {
  readonly providerId: "codex" | "claude";
  readonly sourceKey: string;
  readonly path: string;
  readonly costs: CostUsageRepositoryService;
  readonly maxSourceBytes: number;
  readonly signal: AbortSignal | undefined;
}): Promise<{ readonly retries: number; readonly incomplete: boolean }> => {
  let retries = 0;
  for (let attempt = 0; attempt < maximumScanAttempts; attempt += 1) {
    throwIfCancelled(options.signal);
    const expectedCheckpointJson = await Effect.runPromise(
      options.costs.localScanCheckpoint(options.providerId, options.sourceKey),
      options.signal === undefined ? {} : { signal: options.signal },
    );
    const checkpoint = decodeCheckpoint(expectedCheckpointJson, options.providerId);
    try {
      const scanned =
        options.providerId === "codex"
          ? await scanNodeCodexCostJsonl({
              path: options.path,
              ...(checkpoint === undefined ? {} : { state: checkpoint as NodeCodexCostJsonlState }),
              maxBytes: options.maxSourceBytes,
              maxLineBytes: maximumLineBytes,
              ...(options.signal === undefined ? {} : { signal: options.signal }),
            })
          : await scanNodeClaudeCostJsonl({
              path: options.path,
              ...(checkpoint === undefined
                ? {}
                : { state: checkpoint as NodeClaudeCostJsonlState }),
              maxBytes: options.maxSourceBytes,
              maxLineBytes: maximumLineBytes,
              ...(options.signal === undefined ? {} : { signal: options.signal }),
            });
      if (scanned.result.rows.length > maximumRowsPerSource) {
        throw new Error("Local cost scan produced too many records");
      }
      throwIfCancelled(options.signal);
      await Effect.runPromise(
        options.costs.commitLocalScan({
          providerId: options.providerId,
          sourceKey: options.sourceKey,
          ...(expectedCheckpointJson === undefined ? {} : { expectedCheckpointJson }),
          checkpointJson: encodeCheckpoint(options.providerId, scanned.state),
          records: scanned.result.rows.flatMap((row) => {
            const record = costRecordFromJsonlRow(options.providerId, row);
            return record === undefined ? [] : [record];
          }),
          // A replaced/truncated/corrupt source must remove exactly this
          // source's older rows in the same transaction as its fresh cursor.
          ...(checkpoint === undefined && expectedCheckpointJson !== undefined
            ? { reset: true }
            : scanned.resumed
              ? {}
              : { reset: true }),
        }),
        options.signal === undefined ? {} : { signal: options.signal },
      );
      return {
        retries,
        // A partial final line and an oversized line intentionally retain a
        // cursor before the source end. Treat both as incomplete rather than
        // claiming the bounded refresh covered every billable record.
        incomplete:
          scanned.result.metrics.hitByteLimit ||
          scanned.state.cursor.discardOffset !== undefined ||
          scanned.state.cursor.committedOffset < scanned.state.fingerprint.size,
      };
    } catch (error) {
      if (isCancellation(error, options.signal)) throw new LocalCostRefreshCancelledError();
      if (
        attempt + 1 < maximumScanAttempts &&
        (isCheckpointConflict(error) || error instanceof CostJsonlSourceChangedError)
      ) {
        retries += 1;
        continue;
      }
      throw error;
    }
  }
  throw new Error("Local cost refresh retry limit exceeded");
};

const costRecordFromJsonlRow = (
  providerId: "codex" | "claude",
  row: {
    readonly timestamp: number;
    readonly tokens: { readonly input: number; readonly output: number };
    readonly costUsd?: number;
  },
): CostUsageRecord | undefined =>
  // The current durable history schema has one numeric cost field. Recording
  // an unpriced model as $0 would turn unknown billing into a false zero, so
  // retain neither a guessed charge nor an apparently complete row here.
  row.costUsd === undefined
    ? undefined
    : {
        providerId,
        recordedAt: row.timestamp,
        inputTokens: row.tokens.input,
        outputTokens: row.tokens.output,
        costUsd: row.costUsd,
      };

const encodeCheckpoint = (
  scanner: "codex" | "claude",
  state: NodeCodexCostJsonlState | NodeClaudeCostJsonlState,
): string => JSON.stringify({ version: scannerCheckpointVersion, scanner, state });

const encodeCodexFamilyManifest = (
  members: readonly { readonly sourceKey: string; readonly checkpointJson: string }[],
): string =>
  JSON.stringify({
    version: 1,
    scanner: "codex-fork-family",
    sourceKeys: members
      .map((member) => member.sourceKey)
      .sort((left, right) => left.localeCompare(right)),
    checkpointHashes: Object.fromEntries(
      members.map((member) => [
        member.sourceKey,
        createHash("sha256").update(member.checkpointJson).digest("hex"),
      ]),
    ),
  } satisfies CodexFamilyManifest);

const decodeCodexFamilyManifest = (value: string | undefined): CodexFamilyManifest | undefined => {
  if (value === undefined) return undefined;
  try {
    const decoded: unknown = JSON.parse(value);
    if (!isRecord(decoded) || decoded.version !== 1 || decoded.scanner !== "codex-fork-family") {
      return undefined;
    }
    if (!Array.isArray(decoded.sourceKeys) || decoded.sourceKeys.length > 4_096) return undefined;
    if (!isRecord(decoded.checkpointHashes)) return undefined;
    const sourceKeys = decoded.sourceKeys;
    const checkpointHashes = decoded.checkpointHashes;
    if (
      sourceKeys.some(
        (sourceKey) =>
          typeof sourceKey !== "string" ||
          !sourceKey.startsWith("jsonl-v1:codex:") ||
          sourceKey.length > 120,
      ) ||
      new Set(sourceKeys).size !== sourceKeys.length ||
      Object.keys(checkpointHashes).length !== sourceKeys.length ||
      sourceKeys.some((sourceKey) => {
        const hash = checkpointHashes[sourceKey];
        return typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash);
      })
    ) {
      return undefined;
    }
    return {
      version: 1,
      scanner: "codex-fork-family",
      sourceKeys,
      checkpointHashes: checkpointHashes as Record<string, string>,
    };
  } catch {
    return undefined;
  }
};

const decodeCheckpoint = <State extends NodeCodexCostJsonlState | NodeClaudeCostJsonlState>(
  value: string | undefined,
  scanner: "codex" | "claude",
): State | undefined => {
  if (value === undefined) return undefined;
  try {
    const decoded: unknown = JSON.parse(value);
    if (!isCheckpointEnvelope(decoded, scanner)) return undefined;
    return decoded.state as State;
  } catch {
    return undefined;
  }
};

const isCheckpointEnvelope = (
  value: unknown,
  scanner: "codex" | "claude",
): value is CheckpointEnvelope<NodeCodexCostJsonlState | NodeClaudeCostJsonlState> => {
  if (!isRecord(value) || value.version !== scannerCheckpointVersion || value.scanner !== scanner)
    return false;
  const state = value.state;
  if (!isRecord(state) || state.version !== scannerCheckpointVersion) return false;
  const fingerprint = state.fingerprint;
  const cursor = state.cursor;
  return (
    isRecord(fingerprint) &&
    typeof fingerprint.device === "string" &&
    typeof fingerprint.inode === "string" &&
    validNatural(fingerprint.size) &&
    typeof fingerprint.mtimeMs === "number" &&
    validNatural(fingerprint.prefixBytes) &&
    typeof fingerprint.prefixSha256 === "string" &&
    isRecord(cursor) &&
    validNatural(cursor.committedOffset) &&
    (cursor.discardOffset === undefined || validNatural(cursor.discardOffset)) &&
    isRecord(state.parser)
  );
};

const localSourceKey = (providerId: "codex" | "claude", path: string): string => {
  // A path remains stable across an atomic replacement, allowing a fresh
  // fingerprint to reset only that source's prior rows. It is hashed before
  // persistence so DB inspection and all CLI output remain path-free.
  const normalized = resolve(path);
  const digest = createHash("sha256").update(`${providerId}\u0000${normalized}`).digest("hex");
  return `jsonl-v1:${providerId}:${digest}`;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const validNatural = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const boundedPositiveIntegerAtMost = (value: number, name: string, maximum: number): number => {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum)
    throw new Error(`${name} must be a positive integer no greater than ${maximum}`);
  return value;
};

const codexFamilyScanBytes = (sizes: readonly number[], maxSourceBytes: number): number => {
  let total = 0;
  for (const size of sizes) {
    // The inventory already proves size is a safe natural. Saturate anyway so
    // this guard itself cannot overflow if an adapter is replaced in tests.
    total = Math.min(Number.MAX_SAFE_INTEGER, total + Math.min(size, maxSourceBytes) * 2);
  }
  return total;
};

const throwIfCancelled = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted === true) throw new LocalCostRefreshCancelledError();
};

const isCancellation = (error: unknown, signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true || (error instanceof Error && error.name === "AbortError");

const isCheckpointConflict = (error: unknown): boolean => {
  if (error instanceof Error && error.name === "CostUsageScanCheckpointConflictError") return true;
  // Effect's platform repository maps the concrete SQLite error to its
  // InfrastructureError cause. Inspect the chain only for this stable tag;
  // never surface the underlying database/path text to the CLI.
  return error instanceof InfrastructureError && isCheckpointConflict(error.causeValue);
};
