/**
 * Node composition for the bounded local JSONL cost scanners.
 *
 * This deliberately remains at the platform boundary: core receives parsed
 * rows and opaque checkpoint JSON, never a path, environment variable, or
 * operating-system branch.
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve, win32 } from "node:path";
import { Effect } from "effect";
import {
  InfrastructureError,
  type CostUsageRecord,
  type CostUsageRepositoryService,
} from "@codexbar/core";
import type { ProviderId } from "@codexbar/contracts";
import {
  CostJsonlSourceChangedError,
  inventoryNodeCostJsonlFiles,
  scanNodeClaudeCostJsonl,
  scanNodeCodexCostJsonl,
  type NodeClaudeCostJsonlState,
  type NodeCodexCostJsonlState,
} from "./node-cost-jsonl.ts";

const scannerCheckpointVersion = 1 as const;
const maximumScanAttempts = 2;
const maximumSourceBytes = 16 * 1024 * 1024;
const maximumLineBytes = 512 * 1024;
const maximumRowsPerSource = 50_000;

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
}

interface CheckpointEnvelope<State> {
  readonly version: 1;
  readonly scanner: "codex" | "claude";
  readonly state: State;
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
  const roots = {
    codex: options.roots?.codex ?? defaultRoots.codex,
    claude: options.roots?.claude ?? defaultRoots.claude,
  };
  const maxSourceBytes = boundedPositiveInteger(
    options.maxSourceBytes ?? maximumSourceBytes,
    "maxSourceBytes",
  );

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

/** Matches the Swift provider roots without exposing them through CLI output. */
export const resolveNodeLocalCostRoots = (
  environment: Readonly<Record<string, string | undefined>>,
  homeDirectory: string,
  platform: NodeJS.Platform,
): Readonly<Record<"codex" | "claude", readonly string[]>> => {
  const paths = platform === "win32" ? win32 : { join, resolve };
  const expand = (value: string | undefined, fallback: string): string => {
    const trimmed = value?.trim();
    if (trimmed === undefined || trimmed.length === 0) return fallback;
    if (trimmed === "~") return homeDirectory;
    if (trimmed.startsWith("~/") || trimmed.startsWith("~\\"))
      return paths.join(homeDirectory, trimmed.slice(2));
    return paths.resolve(trimmed);
  };
  const codexHome = expand(environment.CODEX_HOME, paths.join(homeDirectory, ".codex"));
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

const boundedPositiveInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer`);
  return value;
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
