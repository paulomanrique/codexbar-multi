/**
 * Streaming local cost-log parsing, ported from the bounded JSONL reader and
 * Codex/Claude parsers in `Sources/CodexBarCore/Vendored/CostUsage`.
 *
 * This module deliberately knows nothing about paths, Node streams, or SQLite.
 * Hosts supply bytes and persist the returned serializable cursor only after
 * their source identity validation succeeds.
 */
import {
  claudeCostUSD,
  codexAPIFastCostUSD,
  codexAPIFastMultiplier,
  codexCostUSD,
  codexUnattributedModel,
  normalizeClaudeModel,
  normalizeCodexModel,
  type PricingCatalog,
} from "./cost-pricing.ts";

export type CostProvenance = "list-price-estimate" | "vendor-metered" | "mixed" | "unknown";

export interface CostJsonlTokens {
  readonly input: number;
  readonly cachedInput: number;
  readonly cacheCreationInput: number;
  readonly output: number;
  readonly reasoningOutput: number;
}

export interface CostJsonlUsageRow {
  readonly provider: "codex" | "claude";
  readonly timestamp: number;
  readonly model: string;
  readonly tokens: CostJsonlTokens;
  /** Undefined means a local price table has no safe price for this model. */
  readonly costUsd?: number;
  readonly provenance: CostProvenance;
  /** Stable within a source file when the source exposes message/request IDs. */
  readonly dedupeKey?: string;
  /** Codex's task/turn owner, retained for trace-priority attribution. */
  readonly turnId?: string;
  /** The model selected by a priority trace, when it is safe to price with it. */
  readonly pricingModel?: string;
  /** Swift's priority overlay marks a turn even when no Fast price exists. */
  readonly pricingMode?: "standard" | "priority";
}

export interface CostJsonlCursor {
  /** First byte not yet safely committed. Re-read this offset after a tail. */
  readonly committedOffset: number;
  /**
   * A known oversized record is being discarded. Resume here rather than at
   * `committedOffset`, then clear this field once its newline is consumed.
   * This is essential for bounded scans of an unterminated multi-budget line.
   */
  readonly discardOffset?: number;
}

export interface CostJsonlScanMetrics {
  readonly readBytes: number;
  readonly parsedLines: number;
  readonly skippedOversizeLines: number;
  readonly hitByteLimit: boolean;
}

export interface CostJsonlScanResult {
  readonly cursor: CostJsonlCursor;
  readonly metrics: CostJsonlScanMetrics;
}

export interface CostJsonlChunkScanOptions {
  /** Preferred serializable resume state. `startOffset` is retained for simple callers. */
  readonly cursor?: CostJsonlCursor;
  readonly startOffset?: number;
  readonly maxBytes?: number;
  readonly maxLineBytes?: number;
  readonly checkCancelled?: () => void;
  readonly onLine: (
    line: Uint8Array,
    startOffset: number,
    endOffset: number,
  ) => void | Promise<void>;
}

const defaultMaxLineBytes = 512 * 1024;

/**
 * Reads complete JSONL records from arbitrary chunks. A partial final record
 * is deliberately not committed unless it is structurally complete, so a
 * writer appending to a log cannot create a permanently lost tail.
 */
export async function scanCostJsonlChunks(
  chunks: AsyncIterable<Uint8Array>,
  options: CostJsonlChunkScanOptions,
): Promise<CostJsonlScanResult> {
  const suppliedCursor = options.cursor;
  const committedOffset = nonNegativeInteger(
    suppliedCursor?.committedOffset ?? options.startOffset ?? 0,
    "committedOffset",
  );
  const discardOffset =
    suppliedCursor?.discardOffset === undefined
      ? undefined
      : nonNegativeInteger(suppliedCursor.discardOffset, "discardOffset");
  if (discardOffset !== undefined && discardOffset < committedOffset) {
    throw new Error("discardOffset must not precede committedOffset");
  }
  const startOffset = discardOffset ?? committedOffset;
  const maxBytes =
    options.maxBytes === undefined
      ? Number.POSITIVE_INFINITY
      : nonNegativeInteger(options.maxBytes, "maxBytes");
  const maxLineBytes = nonNegativeInteger(
    options.maxLineBytes ?? defaultMaxLineBytes,
    "maxLineBytes",
  );
  let readBytes = 0;
  let parsedLines = 0;
  let skippedOversizeLines = 0;
  let lineStartOffset = startOffset;
  let lineLength = 0;
  let discardingOversize = discardOffset !== undefined;
  let truncated = discardingOversize;
  let retained: number[] = [];
  let hitByteLimit = false;

  const emit = async (endOffset: number): Promise<void> => {
    if (truncated) {
      skippedOversizeLines += 1;
    } else if (lineLength > 0) {
      await options.onLine(Uint8Array.from(retained), lineStartOffset, endOffset);
      parsedLines += 1;
    }
    retained = [];
    lineLength = 0;
    discardingOversize = false;
    truncated = false;
    lineStartOffset = endOffset;
  };

  for await (const sourceChunk of chunks) {
    options.checkCancelled?.();
    if (readBytes >= maxBytes) {
      hitByteLimit = true;
      break;
    }
    const available = Math.min(sourceChunk.byteLength, maxBytes - readBytes);
    if (available < sourceChunk.byteLength) hitByteLimit = true;
    for (let index = 0; index < available; index += 1) {
      if ((index & 0x3fff) === 0) options.checkCancelled?.();
      const byte = sourceChunk[index]!;
      readBytes += 1;
      const endOffset = startOffset + readBytes;
      if (byte === 0x0a) {
        await emit(endOffset);
        continue;
      }
      if (discardingOversize) continue;
      lineLength += 1;
      if (lineLength > maxLineBytes) {
        discardingOversize = true;
        truncated = true;
        retained = [];
      } else {
        retained.push(byte);
      }
    }
    if (available < sourceChunk.byteLength) break;
  }

  options.checkCancelled?.();
  // A JSONL writer may omit the last newline. Commit only a complete JSON
  // value; otherwise the next scan restarts at the record's first byte.
  if (
    !discardingOversize &&
    lineLength > 0 &&
    isStructurallyCompleteJson(Uint8Array.from(retained))
  ) {
    await emit(startOffset + readBytes);
  }

  return {
    cursor: discardingOversize
      ? { committedOffset, discardOffset: startOffset + readBytes }
      : { committedOffset: lineStartOffset },
    metrics: { readBytes, parsedLines, skippedOversizeLines, hitByteLimit },
  };
}

export interface CodexJsonlState {
  readonly currentModel?: string;
  /** The last `task_started` turn applies to subsequent token observations. */
  readonly currentTurnId?: string;
  readonly totals?: CostJsonlTokens;
  /** Session metadata read from the leaf `session_meta` record, when present. */
  readonly session?: CodexJsonlSessionMetadata;
  /** Parent totals whose copied child prefix has not reached the fork boundary yet. */
  readonly awaitingForkBaseline?: CostJsonlTokens;
  /**
   * A cumulative counter regressed/interleaved. This compact port suppresses
   * later cumulative rows rather than guessing; fork lineage #2037 remains a
   * separate parity item.
   */
  readonly cumulativeCounterUnsafe?: boolean;
  /** A bounded exact-event cache for `last_token_usage` fallback records. */
  readonly lastEventKeys: readonly string[];
  /** Last accepted bare-usage timestamp, reused only by timestamp-less bare rows. */
  readonly lastBareUsageTimestamp?: number;
}

/**
 * Identifies a Codex rollout and, for a fork, the parent rollout that owns
 * the copied cumulative prefix. Hosts resolve parent files; core only checks
 * the declared parent before using a supplied baseline.
 */
export interface CodexJsonlSessionMetadata {
  readonly id?: string;
  readonly forkedFromId?: string;
  readonly forkTimestamp?: number;
}

/** A parent cumulative snapshot resolved by the host for a child rollout. */
export interface CodexJsonlForkBaseline {
  readonly parentSessionId: string;
  readonly totals: CostJsonlTokens;
}

/**
 * Sanitized metadata supplied by the host-owned Codex trace-log adapter.
 * It intentionally contains no trace/request body and lets the portable
 * parser preserve Swift's standard-vs-priority cost decision.
 */
export interface CodexJsonlPriorityTurn {
  readonly model?: string;
}

/** One raw cumulative observation used only by the platform fork resolver. */
export interface CodexJsonlTotalSnapshot {
  readonly timestamp: number;
  readonly totals: CostJsonlTokens;
}

const maximumCodexForkBaselineSnapshots = 50_000;

export interface CodexJsonlParseOptions {
  readonly state?: Partial<CodexJsonlState>;
  /**
   * Parent-owned cumulative totals at this rollout's fork boundary. The
   * baseline applies only after this file declares the same parent session.
   */
  readonly forkBaseline?: CodexJsonlForkBaseline;
  /** Priority turns resolved by a host adapter from Codex's trace database. */
  readonly priorityTurns?: Readonly<Record<string, CodexJsonlPriorityTurn>>;
  readonly catalog?: PricingCatalog;
  readonly pricingDate?: (timestamp: number) => Date;
  /**
   * Collect bounded raw cumulative snapshots for a host-owned parent-at-fork
   * resolver. They are never stored in the incremental parser state.
   */
  readonly collectTotalsForForkBaseline?: boolean;
  readonly scan: Omit<CostJsonlChunkScanOptions, "onLine">;
}

export interface CodexJsonlParseResult extends CostJsonlScanResult {
  readonly rows: readonly CostJsonlUsageRow[];
  readonly state: CodexJsonlState;
  /** Present only when the caller explicitly asks for parent-fork evidence. */
  readonly totalSnapshots?: readonly CodexJsonlTotalSnapshot[];
  /** False means a host must not infer a parent baseline from this parse. */
  readonly totalSnapshotsComplete?: boolean;
}

export async function parseCodexCostJsonl(
  chunks: AsyncIterable<Uint8Array>,
  options: CodexJsonlParseOptions,
): Promise<CodexJsonlParseResult> {
  let currentModel = optionalText(options.state?.currentModel);
  let currentTurnId = optionalText(options.state?.currentTurnId);
  let totals =
    options.state?.totals === undefined ? undefined : normalizedTokens(options.state.totals);
  let session = normalizedCodexSession(options.state?.session);
  let awaitingForkBaseline =
    options.state?.awaitingForkBaseline === undefined
      ? undefined
      : normalizedTokens(options.state.awaitingForkBaseline);
  let cumulativeCounterUnsafe = options.state?.cumulativeCounterUnsafe === true;
  const lastEventKeys = boundedSet(options.state?.lastEventKeys, 1024);
  let lastBareUsageTimestamp = (() => {
    const value = options.state?.lastBareUsageTimestamp;
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? value
      : undefined;
  })();
  const rows: CostJsonlUsageRow[] = [];
  const totalSnapshots: CodexJsonlTotalSnapshot[] = [];
  let totalSnapshotsComplete = true;
  const emitCodexRow = (
    timestamp: number,
    model: string,
    turnId: string | undefined,
    tokens: CostJsonlTokens,
  ): void => {
    const normalizedModel = normalizeCodexModel(model);
    const priority = turnId === undefined ? undefined : options.priorityTurns?.[turnId];
    // Swift only promotes the trace model when it is one of the API Fast
    // routes. An arbitrary trace alias must not cross-charge a token row.
    const priorityModel = optionalText(priority?.model);
    const pricingModel =
      priorityModel !== undefined && codexAPIFastMultiplier(priorityModel) !== undefined
        ? normalizeCodexModel(priorityModel)
        : normalizedModel;
    const pricingInput = {
      model: pricingModel,
      inputTokens: tokens.input,
      cachedInputTokens: tokens.cachedInput,
      cacheWriteInputTokens: tokens.cacheCreationInput,
      outputTokens: tokens.output,
      options: {
        ...(options.catalog === undefined ? {} : { catalog: options.catalog }),
        pricingDate: (options.pricingDate ?? dateFromMilliseconds)(timestamp),
      },
    };
    const standardCostUsd = codexCostUSD(pricingInput);
    const priorityCostUsd = priority === undefined ? undefined : codexAPIFastCostUSD(pricingInput);
    // The upstream overlay never makes a priority turn cheaper than its
    // standard calculation and declines Fast pricing for long context.
    const costUsd =
      priorityCostUsd === undefined
        ? standardCostUsd
        : Math.max(priorityCostUsd, standardCostUsd ?? priorityCostUsd);
    rows.push({
      provider: "codex",
      timestamp,
      model: normalizedModel,
      tokens,
      ...(costUsd === undefined ? {} : { costUsd }),
      provenance: costUsd === undefined ? "unknown" : "list-price-estimate",
      ...(turnId === undefined ? {} : { turnId }),
      ...(pricingModel === normalizedModel ? {} : { pricingModel }),
      ...(priority === undefined ? {} : { pricingMode: "priority" as const }),
    });
  };
  const scan = await scanCostJsonlChunks(chunks, {
    ...options.scan,
    onLine: (line) => {
      const value = parseObject(line);
      if (value === undefined) return;
      if (value.type === undefined) {
        const bare = codexBareUsageFrom(value);
        if (bare === undefined) return;
        const timestamp = parseTimestamp(value.timestamp) ?? lastBareUsageTimestamp;
        if (timestamp === undefined) return;
        const data = asObject(value.data);
        const model =
          optionalText(value.model) ??
          optionalText(value.model_name) ??
          optionalText(data?.model) ??
          optionalText(data?.model_name) ??
          currentModel ??
          codexUnattributedModel;
        emitCodexRow(timestamp, model, currentTurnId, bare);
        lastBareUsageTimestamp = timestamp;
        return;
      }
      if (value.type === "session_meta") {
        const metadata = codexSessionMetadata(value);
        session = mergeCodexSession(session, metadata);
        if (
          totals === undefined &&
          awaitingForkBaseline === undefined &&
          options.forkBaseline !== undefined &&
          session?.forkedFromId === options.forkBaseline.parentSessionId
        ) {
          awaitingForkBaseline = normalizedTokens(options.forkBaseline.totals);
        }
        return;
      }
      if (value.type === "turn_context") {
        const payload = asObject(value.payload);
        const info = asObject(payload?.info);
        currentModel =
          optionalText(payload?.model) ??
          optionalText(payload?.model_name) ??
          optionalText(info?.model) ??
          optionalText(info?.model_name) ??
          currentModel;
        return;
      }
      if (value.type !== "event_msg") return;
      const payload = asObject(value.payload);
      if (payload?.type === "task_started") {
        // Match Swift exactly: an unidentifiable new task clears the prior
        // turn instead of carrying its priority overlay into another turn.
        currentTurnId = codexTurnId(payload);
        return;
      }
      if (payload?.type !== "token_count") return;
      const timestamp = parseTimestamp(value.timestamp);
      if (timestamp === undefined) return;
      const info = asObject(payload.info);
      const model =
        optionalText(info?.model) ??
        optionalText(info?.model_name) ??
        optionalText(payload.model) ??
        optionalText(value.model) ??
        currentModel ??
        codexUnattributedModel;
      const turnId = codexTurnId(info) ?? codexTurnId(payload) ?? currentTurnId;
      // A host-provided fork baseline is only trustworthy after the leaf has
      // identified its parent. Avoid charging a prefix if malformed input
      // places token records before its `session_meta` record.
      if (options.forkBaseline !== undefined && totals === undefined && session === undefined)
        return;
      const total = totalsFrom(info?.total_token_usage);
      const last = totalsFrom(info?.last_token_usage);
      if (options.collectTotalsForForkBaseline === true && total !== undefined) {
        if (totalSnapshots.length >= maximumCodexForkBaselineSnapshots) {
          totalSnapshotsComplete = false;
        } else {
          totalSnapshots.push({ timestamp, totals: total });
        }
      }
      let delta: CostJsonlTokens | undefined;
      if (total !== undefined) {
        if (awaitingForkBaseline !== undefined) {
          // Child rollouts replay the parent's cumulative prefix from a lower
          // counter. Do not compare that prefix to the parent's final value;
          // wait until the copied stream reaches the resolved boundary.
          if (!hasReachedTotals(total, awaitingForkBaseline)) return;
          delta = positiveDifference(total, awaitingForkBaseline);
          totals = total;
          awaitingForkBaseline = undefined;
        } else {
          if (totals !== undefined && hasCounterRegression(total, totals)) {
            cumulativeCounterUnsafe = true;
          }
          delta = totals === undefined ? total : positiveDifference(total, totals);
          totals = total;
          // Do not substitute `last` after a detected total regression. It may
          // be a copied fork prefix; omitting a row is safer than billing it.
          if (cumulativeCounterUnsafe) return;
        }
      } else if (last !== undefined) {
        // A `last_token_usage` record cannot prove where a replayed prefix
        // ends, so it is not billable until a cumulative total reaches the
        // resolved parent boundary.
        if (awaitingForkBaseline !== undefined) return;
        const key = `${timestamp}:${model}:${last.input}:${last.cachedInput}:${last.cacheCreationInput}:${last.output}:${last.reasoningOutput}`;
        if (lastEventKeys.has(key)) return;
        lastEventKeys.add(key);
        trimSet(lastEventKeys, 1024);
        delta = last;
        totals = addTokens(totals, last);
      }
      if (delta === undefined || tokenCount(delta) === 0) return;
      emitCodexRow(timestamp, model, turnId, delta);
    },
  });
  return {
    ...scan,
    rows,
    state: {
      ...(currentModel === undefined ? {} : { currentModel }),
      ...(currentTurnId === undefined ? {} : { currentTurnId }),
      ...(totals === undefined ? {} : { totals }),
      ...(session === undefined ? {} : { session }),
      ...(awaitingForkBaseline === undefined ? {} : { awaitingForkBaseline }),
      ...(cumulativeCounterUnsafe ? { cumulativeCounterUnsafe: true } : {}),
      lastEventKeys: [...lastEventKeys],
      ...(lastBareUsageTimestamp === undefined ? {} : { lastBareUsageTimestamp }),
    },
    ...(options.collectTotalsForForkBaseline === true
      ? {
          totalSnapshots,
          totalSnapshotsComplete,
        }
      : {}),
  };
}

export interface ClaudeJsonlState {
  /** Recent cumulative chunks keyed by `message.id + requestId`; bounded to 1,024. */
  readonly messageTotals: Readonly<Record<string, CostJsonlTokens>>;
  /** Message streams whose cumulative counters regressed; never infer later deltas for them. */
  readonly unsafeMessageKeys?: readonly string[];
}

export interface ClaudeJsonlParseOptions {
  readonly state?: Partial<ClaudeJsonlState>;
  readonly catalog?: PricingCatalog;
  readonly pricingDate?: (timestamp: number) => Date;
  readonly scan: Omit<CostJsonlChunkScanOptions, "onLine">;
}

export interface ClaudeJsonlParseResult extends CostJsonlScanResult {
  readonly rows: readonly CostJsonlUsageRow[];
  readonly state: ClaudeJsonlState;
}

export async function parseClaudeCostJsonl(
  chunks: AsyncIterable<Uint8Array>,
  options: ClaudeJsonlParseOptions,
): Promise<ClaudeJsonlParseResult> {
  const messageTotals = new Map(
    Object.entries(options.state?.messageTotals ?? {}).map(([key, value]) => [
      key,
      normalizedTokens(value),
    ]),
  );
  const unsafeMessageKeys = boundedSet(options.state?.unsafeMessageKeys, 1024);
  const rows: CostJsonlUsageRow[] = [];
  const scan = await scanCostJsonlChunks(chunks, {
    ...options.scan,
    onLine: (line) => {
      const value = parseObject(line);
      if (value?.type !== "assistant") return;
      const timestamp = parseTimestamp(value.timestamp);
      const message = asObject(value.message);
      const usage = asObject(message?.usage);
      const model = optionalText(message?.model);
      if (
        timestamp === undefined ||
        message === undefined ||
        usage === undefined ||
        model === undefined
      )
        return;
      const total = normalizedTokens({
        input: integer(usage.input_tokens),
        cachedInput: integer(usage.cache_read_input_tokens),
        cacheCreationInput: integer(usage.cache_creation_input_tokens),
        output: integer(usage.output_tokens),
        reasoningOutput: 0,
      });
      if (tokenCount(total) === 0) return;
      const messageId = optionalText(message.id);
      const requestId = optionalText(value.requestId);
      const key =
        messageId === undefined || requestId === undefined
          ? undefined
          : `${messageId}:${requestId}`;
      const previous = key === undefined ? undefined : messageTotals.get(key);
      if (key !== undefined && previous !== undefined && hasCounterRegression(total, previous)) {
        unsafeMessageKeys.add(key);
        trimSet(unsafeMessageKeys, 1024);
      }
      const delta = previous === undefined ? total : positiveDifference(total, previous);
      if (key !== undefined) {
        messageTotals.delete(key);
        messageTotals.set(key, total);
        trimMap(messageTotals, 1024);
      }
      if (key !== undefined && unsafeMessageKeys.has(key)) return;
      if (tokenCount(delta) === 0) return;
      const normalizedModel = normalizeClaudeModel(model);
      const costUsd = claudeCostUSD({
        model: normalizedModel,
        inputTokens: delta.input,
        cacheReadInputTokens: delta.cachedInput,
        cacheCreationInputTokens: delta.cacheCreationInput,
        outputTokens: delta.output,
        options: {
          ...(options.catalog === undefined ? {} : { catalog: options.catalog }),
          pricingDate: (options.pricingDate ?? dateFromMilliseconds)(timestamp),
        },
      });
      rows.push({
        provider: "claude",
        timestamp,
        model: normalizedModel,
        tokens: delta,
        ...(costUsd === undefined ? {} : { costUsd }),
        provenance: costUsd === undefined ? "unknown" : "list-price-estimate",
        ...(key === undefined ? {} : { dedupeKey: key }),
      });
    },
  });
  return {
    ...scan,
    rows,
    state: {
      messageTotals: Object.fromEntries(messageTotals),
      ...(unsafeMessageKeys.size === 0 ? {} : { unsafeMessageKeys: [...unsafeMessageKeys] }),
    },
  };
}

function parseObject(line: Uint8Array): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(line));
    return asObject(parsed);
  } catch {
    return undefined;
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Swift's fast JSONL parser accepts both current and legacy turn spellings. */
function codexTurnId(value: Record<string, unknown> | undefined): string | undefined {
  return optionalText(value?.turn_id) ?? optionalText(value?.turnId) ?? optionalText(value?.id);
}

function codexSessionMetadata(
  value: Record<string, unknown>,
): CodexJsonlSessionMetadata | undefined {
  const payload = asObject(value.payload);
  if (payload === undefined) return undefined;
  const id = optionalText(payload.id) ?? optionalText(payload.session_id);
  const forkedFromId =
    optionalText(payload.forked_from_id) ??
    optionalText(payload.forkedFromId) ??
    optionalText(payload.parent_session_id) ??
    optionalText(payload.parentSessionId);
  const forkTimestamp = parseTimestamp(payload.timestamp) ?? parseTimestamp(value.timestamp);
  return id === undefined && forkedFromId === undefined && forkTimestamp === undefined
    ? undefined
    : {
        ...(id === undefined ? {} : { id }),
        ...(forkedFromId === undefined ? {} : { forkedFromId }),
        ...(forkTimestamp === undefined ? {} : { forkTimestamp }),
      };
}

function normalizedCodexSession(
  session: CodexJsonlSessionMetadata | undefined,
): CodexJsonlSessionMetadata | undefined {
  if (session === undefined) return undefined;
  const id = optionalText(session.id);
  const forkedFromId = optionalText(session.forkedFromId);
  const forkTimestamp =
    typeof session.forkTimestamp === "number" && Number.isFinite(session.forkTimestamp)
      ? session.forkTimestamp
      : undefined;
  return id === undefined && forkedFromId === undefined && forkTimestamp === undefined
    ? undefined
    : {
        ...(id === undefined ? {} : { id }),
        ...(forkedFromId === undefined ? {} : { forkedFromId }),
        ...(forkTimestamp === undefined ? {} : { forkTimestamp }),
      };
}

function mergeCodexSession(
  current: CodexJsonlSessionMetadata | undefined,
  next: CodexJsonlSessionMetadata | undefined,
): CodexJsonlSessionMetadata | undefined {
  if (current === undefined) return next;
  if (next === undefined) return current;
  // The first metadata record belongs to the leaf. Later metadata can be a
  // copied fork prefix, so it may only fill fields that the leaf omitted.
  const id = current.id ?? next.id;
  const forkedFromId = current.forkedFromId ?? next.forkedFromId;
  const forkTimestamp = current.forkTimestamp ?? next.forkTimestamp;
  return {
    ...(id === undefined ? {} : { id }),
    ...(forkedFromId === undefined ? {} : { forkedFromId }),
    ...(forkTimestamp === undefined ? {} : { forkTimestamp }),
  };
}

function codexBareUsageFrom(value: Record<string, unknown>): CostJsonlTokens | undefined {
  const usage =
    asObject(value.usage) ??
    asObject(asObject(value.data)?.usage) ??
    asObject(asObject(value.result)?.usage) ??
    asObject(asObject(value.response)?.usage);
  if (usage === undefined) return undefined;
  const input = firstBareUsageInteger(usage, ["input_tokens", "prompt_tokens", "input"]);
  const output = firstBareUsageInteger(usage, ["output_tokens", "completion_tokens", "output"]);
  if (input === undefined || output === undefined) return undefined;
  const cached =
    firstBareUsageInteger(usage, [
      "cached_input_tokens",
      "cache_read_input_tokens",
      "cached_tokens",
    ]) ?? 0;
  const billedInput = Math.max(0, input - cached);
  if (billedInput === 0 && cached === 0 && output === 0) return undefined;
  return {
    input: billedInput,
    cachedInput: cached,
    cacheCreationInput: 0,
    output,
    reasoningOutput: 0,
  };
}

function firstBareUsageInteger(
  value: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) return integer(candidate);
  }
  return undefined;
}

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  const truncated = Math.trunc(value);
  return Number.isSafeInteger(truncated) ? Math.max(0, truncated) : 0;
}

function totalsFrom(value: unknown): CostJsonlTokens | undefined {
  const usage = asObject(value);
  if (usage === undefined) return undefined;
  return normalizedTokens({
    input: integer(usage.input_tokens),
    cachedInput: Math.max(
      integer(usage.cached_input_tokens),
      integer(usage.cache_read_input_tokens),
    ),
    cacheCreationInput: integer(usage.cache_creation_input_tokens),
    output: integer(usage.output_tokens),
    reasoningOutput: integer(usage.reasoning_output_tokens),
  });
}

function normalizedTokens(tokens: CostJsonlTokens): CostJsonlTokens {
  const output = integer(tokens.output);
  return {
    input: integer(tokens.input),
    cachedInput: integer(tokens.cachedInput),
    cacheCreationInput: integer(tokens.cacheCreationInput),
    output,
    reasoningOutput: Math.min(output, integer(tokens.reasoningOutput)),
  };
}

function positiveDifference(current: CostJsonlTokens, previous: CostJsonlTokens): CostJsonlTokens {
  return {
    input: Math.max(0, current.input - previous.input),
    cachedInput: Math.max(0, current.cachedInput - previous.cachedInput),
    cacheCreationInput: Math.max(0, current.cacheCreationInput - previous.cacheCreationInput),
    output: Math.max(0, current.output - previous.output),
    reasoningOutput: Math.max(0, current.reasoningOutput - previous.reasoningOutput),
  };
}

function hasCounterRegression(current: CostJsonlTokens, previous: CostJsonlTokens): boolean {
  return (
    current.input < previous.input ||
    current.cachedInput < previous.cachedInput ||
    current.cacheCreationInput < previous.cacheCreationInput ||
    current.output < previous.output ||
    current.reasoningOutput < previous.reasoningOutput
  );
}

function hasReachedTotals(current: CostJsonlTokens, boundary: CostJsonlTokens): boolean {
  return (
    current.input >= boundary.input &&
    current.cachedInput >= boundary.cachedInput &&
    current.cacheCreationInput >= boundary.cacheCreationInput &&
    current.output >= boundary.output &&
    current.reasoningOutput >= boundary.reasoningOutput
  );
}

function addTokens(previous: CostJsonlTokens | undefined, delta: CostJsonlTokens): CostJsonlTokens {
  return previous === undefined
    ? delta
    : {
        input: previous.input + delta.input,
        cachedInput: previous.cachedInput + delta.cachedInput,
        cacheCreationInput: previous.cacheCreationInput + delta.cacheCreationInput,
        output: previous.output + delta.output,
        reasoningOutput: previous.reasoningOutput + delta.reasoningOutput,
      };
}

function tokenCount(tokens: CostJsonlTokens): number {
  return tokens.input + tokens.cachedInput + tokens.cacheCreationInput + tokens.output;
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${name} must be a non-negative safe integer`);
  return value;
}

function boundedSet(values: readonly string[] | undefined, limit: number): Set<string> {
  const result = new Set<string>();
  for (const value of values ?? []) {
    if (typeof value !== "string") continue;
    result.add(value);
    trimSet(result, limit);
  }
  return result;
}

function trimSet(values: Set<string>, limit: number): void {
  while (values.size > limit) values.delete(values.values().next().value!);
}

function trimMap<Key, Value>(values: Map<Key, Value>, limit: number): void {
  while (values.size > limit) values.delete(values.keys().next().value!);
}

function dateFromMilliseconds(milliseconds: number): Date {
  return new Date(milliseconds);
}

function isStructurallyCompleteJson(bytes: Uint8Array): boolean {
  let depth = 0;
  let sawContent = false;
  let string = false;
  let escaping = false;
  for (const byte of bytes) {
    if (!sawContent && (byte === 0x20 || byte === 0x09 || byte === 0x0d)) continue;
    sawContent = true;
    if (string) {
      if (escaping) {
        escaping = false;
      } else if (byte === 0x5c) {
        escaping = true;
      } else if (byte === 0x22) {
        string = false;
      }
      continue;
    }
    if (byte === 0x22) string = true;
    else if (byte === 0x7b || byte === 0x5b) depth += 1;
    else if (byte === 0x7d || byte === 0x5d) depth -= 1;
  }
  return sawContent && !string && depth === 0;
}
