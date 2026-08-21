/**
 * Bounded, read-only adapter for Codex's `logs_2.sqlite` priority overlay.
 *
 * This ports the behavior of `CostUsageScanner+CodexPriority.swift` without
 * retaining request or response bodies. The cache is intentionally process
 * local: the durable JSONL family checkpoint remains the only publication
 * authority, and every successful family refresh is a complete replacement.
 */
import { DatabaseSync } from "node:sqlite";
import { lstat } from "node:fs/promises";
import type { CodexJsonlPriorityTurn } from "@codexbar/core";

const defaultMaximumRows = 50_000;
const defaultBusyTimeoutMilliseconds = 250;

export interface NodeCodexPriorityTurnResolverOptions {
  /** Explicit, host-owned `logs_2.sqlite` path. A missing file means no overlay. */
  readonly databasePath: string;
  /** Bounds trace processing in one cache generation. */
  readonly maximumRows?: number;
}

export class NodeCodexPriorityMetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NodeCodexPriorityMetadataError";
  }
}

interface PriorityRequest {
  readonly rowId: number;
  readonly turnId: string;
  readonly model?: string;
}

interface PriorityCompletion {
  readonly rowId: number;
  readonly turnId: string;
  readonly model: string;
}

interface PriorityMemo {
  readonly identity: string;
  readonly rowCount: number;
  readonly lastRowId: number;
  readonly requests: ReadonlyMap<string, PriorityRequest>;
  readonly completions: ReadonlyMap<string, PriorityCompletion>;
  readonly pendingCompletions: ReadonlyMap<string, PriorityCompletion>;
}

/**
 * Resolves only the sanitized `turnId -> model?` overlay. It has the same
 * high-level cache rules as Swift: an append advances the rowid cursor;
 * database replacement or row pruning forces a full rebuild; completion rows
 * upgrade a known priority request, including the completion-before-request
 * ordering seen in real trace logs.
 */
export const makeNodeCodexPriorityTurnResolver = (
  options: NodeCodexPriorityTurnResolverOptions,
): (() => Promise<Readonly<Record<string, CodexJsonlPriorityTurn>>>) => {
  const maximumRows = boundedMaximumRows(options.maximumRows ?? defaultMaximumRows);
  let memo: PriorityMemo | undefined;

  return async () => {
    const identity = await databaseIdentity(options.databasePath);
    if (identity === undefined) {
      memo = undefined;
      return {};
    }
    const database = new DatabaseSync(options.databasePath, { readOnly: true });
    try {
      if ((await databaseIdentity(options.databasePath)) !== identity) {
        throw new NodeCodexPriorityMetadataError(
          "Codex priority trace database changed while opening",
        );
      }
      database.exec("PRAGMA query_only = ON");
      database.exec(`PRAGMA busy_timeout = ${defaultBusyTimeoutMilliseconds}`);
      const stats = database
        .prepare("SELECT COUNT(*) AS row_count, COALESCE(MAX(rowid), 0) AS max_row_id FROM logs")
        .get() as Record<string, unknown>;
      const rowCount = naturalColumn(stats, "row_count");
      const lastRowId = naturalColumn(stats, "max_row_id");
      // Deleting old trace rows keeps rowids monotonic but invalidates any
      // cached request/completion source. Rebuild instead of pricing a turn
      // whose priority marker was pruned.
      const canIncrement =
        memo !== undefined &&
        memo.identity === identity &&
        rowCount >= memo.rowCount &&
        lastRowId >= memo.lastRowId &&
        hasRetainedMemoSources(database, memo);
      const base =
        canIncrement && memo !== undefined
          ? memo
          : {
              identity,
              rowCount: 0,
              lastRowId: 0,
              requests: new Map<string, PriorityRequest>(),
              completions: new Map<string, PriorityCompletion>(),
              pendingCompletions: new Map<string, PriorityCompletion>(),
            };
      const requests = new Map(base.requests);
      const completions = new Map(base.completions);
      const pendingCompletions = new Map(base.pendingCompletions);
      const rows = database
        .prepare(
          `SELECT rowid, feedback_log_body
           FROM logs
           WHERE rowid > ?
             AND (feedback_log_body LIKE '%websocket request:%'
                  OR feedback_log_body LIKE '%response.completed%'
                  OR feedback_log_body LIKE '%service_tier: Some(Some("priority"))%')
           ORDER BY rowid
           LIMIT ?`,
        )
        .all(base.lastRowId, maximumRows + 1) as Array<Record<string, unknown>>;
      if (rows.length > maximumRows) {
        throw new NodeCodexPriorityMetadataError("Codex priority trace row limit exceeded");
      }
      for (const row of rows) {
        const rowId = naturalColumn(row, "rowid");
        const body = textColumn(row, "feedback_log_body");
        const completion = parseCodexCompletedTraceRow(body, rowId);
        if (completion !== undefined) {
          const prior = completions.get(completion.turnId);
          if (prior === undefined || completion.rowId > prior.rowId) {
            completions.set(completion.turnId, completion);
          }
          const request = requests.get(completion.turnId);
          if (request === undefined) {
            const pending = pendingCompletions.get(completion.turnId);
            if (pending === undefined || completion.rowId > pending.rowId) {
              pendingCompletions.set(completion.turnId, completion);
            }
          }
          continue;
        }
        const request = parseCodexPriorityTraceRow(body, rowId);
        if (request === undefined) continue;
        const prior = requests.get(request.turnId);
        if (prior === undefined || request.rowId > prior.rowId) {
          requests.set(request.turnId, request);
        }
      }
      // Pending completion records become authoritative only when a matching
      // priority request appears. This preserves Swift's non-priority safety.
      for (const turnId of requests.keys()) pendingCompletions.delete(turnId);
      if ((await databaseIdentity(options.databasePath)) !== identity) {
        throw new NodeCodexPriorityMetadataError(
          "Codex priority trace database changed while scanning",
        );
      }
      memo = { identity, rowCount, lastRowId, requests, completions, pendingCompletions };
      return priorityTurns(memo);
    } catch (error) {
      if (error instanceof NodeCodexPriorityMetadataError) throw error;
      throw new NodeCodexPriorityMetadataError("Codex priority trace metadata is unavailable");
    } finally {
      database.close();
    }
  };
};

const priorityTurns = (memo: PriorityMemo): Readonly<Record<string, CodexJsonlPriorityTurn>> =>
  Object.fromEntries(
    [...memo.requests.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([turnId, request]) => {
        const completion = memo.completions.get(turnId);
        const model = completion?.model ?? request.model;
        return [turnId, ...(model === undefined ? [{}] : [{ model }])] as const;
      }),
  );

/**
 * `logs` is append-mostly, but Codex can prune then append before one refresh
 * observes the database. Row count alone can then return to its old value.
 * Revalidate the currently authoritative sources before trusting the rowid
 * cursor; a missing source triggers a complete bounded rebuild.
 */
const hasRetainedMemoSources = (database: DatabaseSync, memo: PriorityMemo): boolean => {
  const rowIds = [
    ...memo.requests.values(),
    ...memo.completions.values(),
    ...memo.pendingCompletions.values(),
  ].map((source) => source.rowId);
  if (rowIds.length === 0) return true;
  const unique = [...new Set(rowIds)];
  for (let start = 0; start < unique.length; start += 500) {
    const chunk = unique.slice(start, start + 500);
    const placeholders = chunk.map(() => "?").join(",");
    const row = database
      .prepare(`SELECT COUNT(*) AS row_count FROM logs WHERE rowid IN (${placeholders})`)
      .get(...chunk) as Record<string, unknown>;
    if (naturalColumn(row, "row_count") !== chunk.length) return false;
  }
  return true;
};

const databaseIdentity = async (path: string): Promise<string | undefined> => {
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(path, { bigint: true });
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw new NodeCodexPriorityMetadataError("Codex priority trace metadata is unavailable");
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new NodeCodexPriorityMetadataError("Codex priority trace database is not a regular file");
  }
  return `${stat.dev}:${stat.ino}`;
};

const parseCodexPriorityTraceRow = (body: string, rowId: number): PriorityRequest | undefined => {
  const marker = "websocket request:";
  const markerIndex = body.indexOf(marker);
  if (markerIndex < 0) return parseCodexPrioritySubmissionRow(body, rowId);
  const prefix = body.slice(0, markerIndex);
  const request = jsonObject(body.slice(markerIndex + marker.length));
  if (request?.type !== "response.create" || request.service_tier !== "priority") return undefined;
  const turnId =
    namedValue(prefix, "turn.id") ?? namedValue(prefix, "turn_id") ?? optionalText(request.turn_id);
  if (turnId === undefined) return undefined;
  const model = optionalText(request.model);
  return { rowId, turnId, ...(model === undefined ? {} : { model }) };
};

const parseCodexPrioritySubmissionRow = (
  body: string,
  rowId: number,
): PriorityRequest | undefined => {
  const marker = "Submission sub=Submission {";
  const markerIndex = body.indexOf(marker);
  if (!body.includes('service_tier: Some(Some("priority"))') || markerIndex < 0) return undefined;
  const submission = body.slice(markerIndex + marker.length);
  const turnId = quotedValue(submission, "id");
  return turnId === undefined ? undefined : { rowId, turnId };
};

const parseCodexCompletedTraceRow = (
  body: string,
  rowId: number,
): PriorityCompletion | undefined => {
  const marker = "websocket event:";
  const markerIndex = body.indexOf(marker);
  if (markerIndex < 0) return undefined;
  const prefix = body.slice(0, markerIndex);
  const event = jsonObject(body.slice(markerIndex + marker.length));
  if (event?.type !== "response.completed") return undefined;
  const response = asRecord(event.response);
  const model = optionalText(response?.model);
  const turnId = namedValue(prefix, "turn.id") ?? namedValue(prefix, "turn_id");
  return turnId === undefined || model === undefined ? undefined : { rowId, turnId, model };
};

const jsonObject = (text: string): Record<string, unknown> | undefined => {
  try {
    return asRecord(JSON.parse(text.trim()));
  } catch {
    return undefined;
  }
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const optionalText = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const namedValue = (text: string, name: string): string | undefined => {
  const index = text.indexOf(`${name}=`);
  if (index < 0) return undefined;
  const value = text.slice(index + name.length + 1).match(/^[^\s,\]\x29}:]+/)?.[0];
  return optionalText(value);
};

const quotedValue = (text: string, name: string): string | undefined => {
  const match = text.match(new RegExp(`${escapeRegExp(name)}: "([^"]+)"`));
  return optionalText(match?.[1]);
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const naturalColumn = (row: Record<string, unknown>, name: string): number => {
  const value = row[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new NodeCodexPriorityMetadataError("Codex priority trace metadata is invalid");
  }
  return value;
};

const textColumn = (row: Record<string, unknown>, name: string): string => {
  const value = row[name];
  if (typeof value !== "string") {
    throw new NodeCodexPriorityMetadataError("Codex priority trace metadata is invalid");
  }
  return value;
};

const boundedMaximumRows = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 1 || value > defaultMaximumRows) {
    throw new NodeCodexPriorityMetadataError("Codex priority trace row limit is invalid");
  }
  return value;
};

const isMissing = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
