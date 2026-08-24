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

/** Serializable Codex cumulative totals; omitted reasoning remains unknown. */
export interface CodexJsonlTotals {
  readonly input: number;
  readonly cachedInput: number;
  readonly cacheCreationInput: number;
  readonly output: number;
  readonly reasoningOutput?: number;
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
  /** Counted cumulative totals after the shared Codex totals accumulator policy. */
  readonly totals?: CodexJsonlTotals;
  /** Raw cumulative counter used as the next total-delta baseline. */
  readonly rawTotalsBaseline?: CodexJsonlTotals;
  /** Monotonic raw cumulative high watermark used for containment. */
  readonly rawTotalsWatermark?: CodexJsonlTotals;
  /** Bounded raw cumulative snapshots used only for exact re-emission suppression. */
  readonly seenRawTotals?: readonly CodexJsonlTotals[];
  readonly sawInterleavedTotals?: boolean;
  readonly sawDivergentTotals?: boolean;
  /** Session metadata read from the leaf `session_meta` record, when present. */
  readonly session?: CodexJsonlSessionMetadata;
  /** Parent totals whose copied child prefix has not reached the fork boundary yet. */
  readonly awaitingForkBaseline?: CodexJsonlTotals;
  /** Parent totals still being consumed from fork `last_token_usage` records. */
  readonly remainingInheritedTotals?: CodexJsonlTotals;
  /**
   * Legacy incoming fail-closed flag from the pre-containment port. Fresh scans
   * must use `sawInterleavedTotals`/watermark containment instead of setting it.
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
  readonly totals: CodexJsonlTotals;
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
  readonly totals?: CodexJsonlTotals;
  readonly last?: CodexJsonlTotals;
}

export interface CodexTotalsAccumulatorState {
  readonly countedTotals?: CodexJsonlTotals;
  readonly rawTotalsBaseline?: CodexJsonlTotals;
  readonly rawTotalsWatermark?: CodexJsonlTotals;
  readonly seenRawTotals?: readonly CodexJsonlTotals[];
  readonly sawInterleavedTotals?: boolean;
  readonly sawDivergentTotals?: boolean;
}

export interface CodexTotalsAccumulatorEvent {
  readonly last?: CodexJsonlTotals;
  readonly total?: CodexJsonlTotals;
}

export interface CodexTotalsAccumulatorApplyResult {
  /** Public billable event delta; optional reasoning is projected to zero. */
  readonly delta: CostJsonlTokens;
  readonly countedTotals: CodexJsonlTotals;
  readonly state: CodexTotalsAccumulatorState;
  readonly skipped?: "duplicate" | "stale" | "empty";
}

type CodexTotalsAccumulatorStateInput = {
  readonly countedTotals?: CodexJsonlTotals | undefined;
  readonly rawTotalsBaseline?: CodexJsonlTotals | undefined;
  readonly rawTotalsWatermark?: CodexJsonlTotals | undefined;
  readonly seenRawTotals?: readonly CodexJsonlTotals[] | undefined;
  readonly sawInterleavedTotals?: boolean | undefined;
  readonly sawDivergentTotals?: boolean | undefined;
};

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
  const legacyCountedTotals =
    options.state?.totals === undefined ? undefined : normalizedCodexTotals(options.state.totals);
  let accumulatorState = normalizedCodexAccumulatorState({
    countedTotals: legacyCountedTotals,
    rawTotalsBaseline:
      options.state?.rawTotalsBaseline === undefined
        ? legacyCountedTotals
        : normalizedCodexTotals(options.state.rawTotalsBaseline),
    rawTotalsWatermark:
      options.state?.rawTotalsWatermark === undefined
        ? options.state?.rawTotalsBaseline === undefined
          ? legacyCountedTotals
          : normalizedCodexTotals(options.state.rawTotalsBaseline)
        : normalizedCodexTotals(options.state.rawTotalsWatermark),
    seenRawTotals: options.state?.seenRawTotals,
    sawInterleavedTotals: options.state?.sawInterleavedTotals === true,
    sawDivergentTotals: options.state?.sawDivergentTotals === true,
  });
  let session = normalizedCodexSession(options.state?.session);
  let activeForkBaseline =
    session?.forkedFromId !== undefined &&
    options.forkBaseline?.parentSessionId === session.forkedFromId
      ? normalizedCodexTotals(options.forkBaseline.totals)
      : undefined;
  let awaitingForkBaseline =
    options.state?.awaitingForkBaseline === undefined
      ? undefined
      : normalizedCodexTotals(options.state.awaitingForkBaseline);
  let remainingInheritedTotals =
    options.state?.remainingInheritedTotals === undefined
      ? awaitingForkBaseline
      : normalizedCodexTotals(options.state.remainingInheritedTotals);
  if (
    awaitingForkBaseline === undefined &&
    accumulatorState.countedTotals === undefined &&
    activeForkBaseline !== undefined
  ) {
    awaitingForkBaseline = activeForkBaseline;
    remainingInheritedTotals = activeForkBaseline;
  }
  const legacyCumulativeCounterUnsafe = options.state?.cumulativeCounterUnsafe === true;
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
        activeForkBaseline =
          session?.forkedFromId !== undefined &&
          options.forkBaseline?.parentSessionId === session.forkedFromId
            ? normalizedCodexTotals(options.forkBaseline.totals)
            : undefined;
        if (
          accumulatorState.countedTotals === undefined &&
          awaitingForkBaseline === undefined &&
          activeForkBaseline !== undefined
        ) {
          awaitingForkBaseline = activeForkBaseline;
          remainingInheritedTotals = activeForkBaseline;
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
      if (
        options.forkBaseline !== undefined &&
        accumulatorState.countedTotals === undefined &&
        session === undefined
      )
        return;
      const total = totalsFrom(info?.total_token_usage);
      const last = totalsFrom(info?.last_token_usage);
      if (
        options.collectTotalsForForkBaseline === true &&
        (total !== undefined || last !== undefined)
      ) {
        if (totalSnapshots.length >= maximumCodexForkBaselineSnapshots) {
          totalSnapshotsComplete = false;
        } else {
          totalSnapshots.push({
            timestamp,
            ...(total === undefined ? {} : { totals: total }),
            ...(last === undefined ? {} : { last }),
          });
        }
      }
      let accumulatorTotal = total;
      let accumulatorLast = last;
      if (total !== undefined && activeForkBaseline !== undefined) {
        // Normalize every fork cumulative snapshot against the resolved
        // parent baseline. A total-bearing event switches to totals-owned fork
        // accounting and ends component-wise inherited `last` consumption.
        accumulatorTotal = positiveTotalsDifference(total, activeForkBaseline);
        accumulatorLast = undefined;
        awaitingForkBaseline = undefined;
        remainingInheritedTotals = undefined;
      } else if (last !== undefined && awaitingForkBaseline !== undefined) {
        // Consume the inherited parent prefix component-wise. Any overflow is
        // child-owned usage and must remain billable even in last-only streams.
        const inherited = remainingInheritedTotals ?? awaitingForkBaseline;
        accumulatorLast = positiveTotalsDifference(last, inherited);
        remainingInheritedTotals = positiveTotalsDifference(inherited, last);
        if (codexNonReasoningTokenCount(remainingInheritedTotals) === 0) {
          remainingInheritedTotals = undefined;
          awaitingForkBaseline = undefined;
        }
      }
      if (legacyCumulativeCounterUnsafe && accumulatorTotal !== undefined) return;
      if (accumulatorTotal === undefined && accumulatorLast !== undefined) {
        const key = [
          timestamp,
          model,
          accumulatorLast.input,
          accumulatorLast.cachedInput,
          accumulatorLast.cacheCreationInput,
          accumulatorLast.output,
          accumulatorLast.reasoningOutput ?? "_",
        ].join(":");
        if (lastEventKeys.has(key)) return;
        lastEventKeys.add(key);
        trimSet(lastEventKeys, 1024);
      }
      let accountingLast = accumulatorLast;
      if (activeForkBaseline !== undefined && accumulatorTotal !== undefined) {
        const staleBaseline =
          accumulatorState.rawTotalsWatermark ?? accumulatorState.rawTotalsBaseline;
        if (
          staleBaseline !== undefined &&
          isStaleRegression(
            accumulatorTotal,
            staleBaseline,
            accumulatorLast ?? zeroCodexTotals(false),
          )
        ) {
          return;
        }
        const isInterleavedForkEvent =
          accumulatorState.sawInterleavedTotals === true ||
          isBelowRawWatermark(accumulatorTotal, accumulatorState.rawTotalsWatermark);
        // Swift keeps fork accounting totals-only until an interleaved lineage
        // is observed. After the latch, `last` caps the contained totals delta.
        accountingLast = isInterleavedForkEvent ? accumulatorLast : undefined;
      }
      const applied = applyCodexTotalsAccumulatorEvent(accumulatorState, {
        ...(accumulatorTotal === undefined ? {} : { total: accumulatorTotal }),
        ...(accountingLast === undefined ? {} : { last: accountingLast }),
      });
      accumulatorState = applied.state;
      const delta = applied.delta;
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
      ...(accumulatorState.countedTotals === undefined
        ? {}
        : { totals: accumulatorState.countedTotals }),
      ...(accumulatorState.rawTotalsBaseline === undefined
        ? {}
        : { rawTotalsBaseline: accumulatorState.rawTotalsBaseline }),
      ...(accumulatorState.rawTotalsWatermark === undefined
        ? {}
        : { rawTotalsWatermark: accumulatorState.rawTotalsWatermark }),
      ...((accumulatorState.seenRawTotals?.length ?? 0) === 0
        ? {}
        : { seenRawTotals: accumulatorState.seenRawTotals }),
      ...(accumulatorState.sawInterleavedTotals === true ? { sawInterleavedTotals: true } : {}),
      ...(accumulatorState.sawDivergentTotals === true ? { sawDivergentTotals: true } : {}),
      ...(session === undefined ? {} : { session }),
      ...(awaitingForkBaseline === undefined ? {} : { awaitingForkBaseline }),
      ...(remainingInheritedTotals === undefined ? {} : { remainingInheritedTotals }),
      ...(legacyCumulativeCounterUnsafe ? { cumulativeCounterUnsafe: true } : {}),
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

function totalsFrom(value: unknown): CodexJsonlTotals | undefined {
  const usage = asObject(value);
  if (usage === undefined) return undefined;
  const input = integer(usage.input_tokens);
  const cachedInput = Math.max(
    integer(usage.cached_input_tokens),
    integer(usage.cache_read_input_tokens),
  );
  const cacheCreationInput = integer(usage.cache_creation_input_tokens);
  const output = integer(usage.output_tokens);
  const rawReasoning = usage.reasoning_output_tokens;
  let reasoning: number | undefined;
  if (typeof rawReasoning === "number" && Number.isFinite(rawReasoning)) {
    const truncated = Math.trunc(rawReasoning);
    const safe = Number.isSafeInteger(truncated) ? Math.max(0, truncated) : 0;
    reasoning = Math.min(safe, output);
  }
  return normalizedCodexTotals({
    input,
    cachedInput,
    cacheCreationInput,
    output,
    ...(reasoning === undefined ? {} : { reasoningOutput: reasoning }),
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

function normalizedCodexTotals(tokens: CodexJsonlTotals): CodexJsonlTotals {
  const output = integer(tokens.output);
  const reasoning =
    tokens.reasoningOutput === undefined
      ? undefined
      : Math.min(output, integer(tokens.reasoningOutput));
  return {
    input: integer(tokens.input),
    cachedInput: integer(tokens.cachedInput),
    cacheCreationInput: integer(tokens.cacheCreationInput),
    output,
    ...(reasoning === undefined ? {} : { reasoningOutput: reasoning }),
  };
}

const codexSeenRawTotalsLimit = 64;

/**
 * Conservative TS extension: Codex currently supplies zero cache-creation
 * tokens, but when present the component participates in raw equality,
 * watermarks, min/max, deltas, and containment just like cached input.
 */
export function applyCodexTotalsAccumulatorEvent(
  state: CodexTotalsAccumulatorState | undefined,
  event: CodexTotalsAccumulatorEvent,
): CodexTotalsAccumulatorApplyResult {
  const previous = normalizedCodexAccumulatorState(state);
  const total = event.total === undefined ? undefined : normalizedCodexTotals(event.total);
  const last = event.last === undefined ? undefined : normalizedCodexTotals(event.last);
  const hasReasoning = total?.reasoningOutput !== undefined || last?.reasoningOutput !== undefined;
  const base = previous.countedTotals ?? zeroCodexTotals(hasReasoning);

  if (total === undefined && last === undefined) {
    return {
      delta: codexTotalsToTokens(zeroCodexTotals(hasReasoning)),
      countedTotals: base,
      state: previous,
      skipped: "empty",
    };
  }

  if (total !== undefined) {
    if ((previous.seenRawTotals ?? []).some((seen) => codexTotalsEqual(seen, total))) {
      return {
        delta: codexTotalsToTokens(zeroCodexTotals(hasReasoning)),
        countedTotals: base,
        state: previous,
        skipped: "duplicate",
      };
    }
    const staleBaseline = previous.rawTotalsWatermark ?? previous.rawTotalsBaseline;
    if (
      staleBaseline !== undefined &&
      isStaleRegression(total, staleBaseline, last ?? zeroCodexTotals(false))
    ) {
      return {
        delta: codexTotalsToTokens(zeroCodexTotals(hasReasoning)),
        countedTotals: base,
        state: previous,
        skipped: "stale",
      };
    }
  }

  const watermarkBaseline = previous.rawTotalsWatermark ?? previous.rawTotalsBaseline;
  const sawInterleavedTotals =
    previous.sawInterleavedTotals === true ||
    (total !== undefined && isBelowRawWatermark(total, previous.rawTotalsWatermark));
  let sawDivergentTotals = previous.sawDivergentTotals === true;
  let countedTotals = base;
  let rawTotalsBaseline = previous.rawTotalsBaseline;
  let rawTotalsWatermark = previous.rawTotalsWatermark;
  let countedDelta = zeroCodexTotals(hasReasoning);

  if (last !== undefined) {
    countedDelta = last;
    if (total !== undefined) {
      if (sawInterleavedTotals) {
        countedDelta = codexPostLatchEventDelta({
          watermark: watermarkBaseline,
          counted: previous.countedTotals,
          current: total,
          adjustedLast: last,
        });
      } else {
        const totalDelta = codexTotalDelta(watermarkBaseline, total);
        if (
          codexShouldPreferTotalDelta({
            rawBaseline: watermarkBaseline,
            currentTotal: total,
            totalDelta,
            lastDelta: last,
            sawDivergentTotals,
          })
        ) {
          countedDelta = totalDelta;
        }
      }
      countedTotals = codexAddTotals(base, countedDelta);
      rawTotalsBaseline = total;
      if (!codexTotalsEqual(total, countedTotals)) sawDivergentTotals = true;
    } else {
      countedTotals = codexAddTotals(base, countedDelta);
      rawTotalsBaseline = countedTotals;
      rawTotalsWatermark = codexMaxTotals(rawTotalsWatermark, countedTotals);
    }
  } else if (total !== undefined) {
    countedDelta = sawInterleavedTotals
      ? codexContainedTotalDelta({
          watermark: watermarkBaseline,
          counted: previous.countedTotals,
          current: total,
        })
      : sawDivergentTotals
        ? codexDivergentTotalDelta({
            rawBaseline: watermarkBaseline,
            countedBaseline: previous.countedTotals,
            current: total,
          })
        : codexTotalDelta(watermarkBaseline, total);
    countedTotals = codexAddTotals(base, countedDelta);
    rawTotalsBaseline = total;
    if (!codexTotalsEqual(total, countedTotals)) sawDivergentTotals = true;
  }

  let seenRawTotals = previous.seenRawTotals ?? [];
  if (total !== undefined) {
    rawTotalsWatermark = codexMaxTotals(rawTotalsWatermark, total);
    if (!seenRawTotals.some((seen) => codexTotalsEqual(seen, total))) {
      seenRawTotals = [...seenRawTotals, total].slice(-codexSeenRawTotalsLimit);
    }
  }

  const nextState = compactCodexAccumulatorState({
    countedTotals,
    rawTotalsBaseline,
    rawTotalsWatermark,
    seenRawTotals,
    sawInterleavedTotals,
    sawDivergentTotals,
  });
  return {
    delta: codexTotalsToTokens(countedDelta),
    countedTotals,
    state: nextState,
  };
}

export function replayCodexTotalSnapshotsAtOrBefore(
  snapshots: readonly CodexJsonlTotalSnapshot[],
  cutoff: number,
): CodexJsonlTotals | undefined {
  if (!Number.isFinite(cutoff)) return undefined;
  let previousTimestamp = Number.NEGATIVE_INFINITY;
  let timestampsAreMonotonic = true;
  for (const snapshot of snapshots) {
    if (!Number.isFinite(snapshot.timestamp)) continue;
    if (snapshot.timestamp < previousTimestamp) timestampsAreMonotonic = false;
    previousTimestamp = snapshot.timestamp;
  }
  let state: CodexTotalsAccumulatorState | undefined;
  let counted: CodexJsonlTotals | undefined;
  for (const snapshot of snapshots) {
    if (!Number.isFinite(snapshot.timestamp)) continue;
    const isAtOrBeforeCutoff = snapshot.timestamp <= cutoff;
    if (timestampsAreMonotonic && !isAtOrBeforeCutoff) break;
    const applied = applyCodexTotalsAccumulatorEvent(state, {
      ...(snapshot.totals === undefined ? {} : { total: snapshot.totals }),
      ...(snapshot.last === undefined ? {} : { last: snapshot.last }),
    });
    state = applied.state;
    if (isAtOrBeforeCutoff) counted = applied.countedTotals;
  }
  return counted;
}

function codexTotalsToTokens(tokens: CodexJsonlTotals): CostJsonlTokens {
  return {
    input: tokens.input,
    cachedInput: tokens.cachedInput,
    cacheCreationInput: tokens.cacheCreationInput,
    output: tokens.output,
    reasoningOutput: tokens.reasoningOutput ?? 0,
  };
}

function zeroCodexTotals(withReasoning: boolean): CodexJsonlTotals {
  return {
    input: 0,
    cachedInput: 0,
    cacheCreationInput: 0,
    output: 0,
    ...(withReasoning ? { reasoningOutput: 0 } : {}),
  };
}

function normalizedCodexAccumulatorState(
  state: CodexTotalsAccumulatorStateInput | undefined,
): CodexTotalsAccumulatorState {
  const countedTotals =
    state?.countedTotals === undefined ? undefined : normalizedCodexTotals(state.countedTotals);
  const rawTotalsBaseline =
    state?.rawTotalsBaseline === undefined
      ? undefined
      : normalizedCodexTotals(state.rawTotalsBaseline);
  const rawTotalsWatermark =
    state?.rawTotalsWatermark === undefined
      ? undefined
      : normalizedCodexTotals(state.rawTotalsWatermark);
  const seenRawTotals = (state?.seenRawTotals ?? [])
    .map((totals) => normalizedCodexTotals(totals))
    .slice(-codexSeenRawTotalsLimit);
  return compactCodexAccumulatorState({
    countedTotals,
    rawTotalsBaseline,
    rawTotalsWatermark,
    seenRawTotals,
    sawInterleavedTotals: state?.sawInterleavedTotals === true,
    sawDivergentTotals: state?.sawDivergentTotals === true,
  });
}

function compactCodexAccumulatorState(
  state: CodexTotalsAccumulatorStateInput,
): CodexTotalsAccumulatorState {
  return {
    ...(state.countedTotals === undefined ? {} : { countedTotals: state.countedTotals }),
    ...(state.rawTotalsBaseline === undefined
      ? {}
      : { rawTotalsBaseline: state.rawTotalsBaseline }),
    ...(state.rawTotalsWatermark === undefined
      ? {}
      : { rawTotalsWatermark: state.rawTotalsWatermark }),
    ...(state.seenRawTotals === undefined || state.seenRawTotals.length === 0
      ? {}
      : { seenRawTotals: state.seenRawTotals }),
    ...(state.sawInterleavedTotals === true ? { sawInterleavedTotals: true } : {}),
    ...(state.sawDivergentTotals === true ? { sawDivergentTotals: true } : {}),
  };
}

function codexTotalsEqual(
  left: CodexJsonlTotals | undefined,
  right: CodexJsonlTotals | undefined,
): boolean {
  return (
    left?.input === right?.input &&
    left?.cachedInput === right?.cachedInput &&
    left?.cacheCreationInput === right?.cacheCreationInput &&
    left?.output === right?.output
  );
}

function codexTotalsAtLeast(left: CodexJsonlTotals, right: CodexJsonlTotals): boolean {
  return (
    left.input >= right.input &&
    left.cachedInput >= right.cachedInput &&
    left.cacheCreationInput >= right.cacheCreationInput &&
    left.output >= right.output
  );
}

function codexTotalsAtMost(left: CodexJsonlTotals, right: CodexJsonlTotals): boolean {
  return (
    left.input <= right.input &&
    left.cachedInput <= right.cachedInput &&
    left.cacheCreationInput <= right.cacheCreationInput &&
    left.output <= right.output
  );
}

function codexAddTotals(left: CodexJsonlTotals, right: CodexJsonlTotals): CodexJsonlTotals {
  const output = left.output + right.output;
  const reasoning =
    left.reasoningOutput === undefined || right.reasoningOutput === undefined
      ? undefined
      : Math.min(output, left.reasoningOutput + right.reasoningOutput);
  return {
    input: left.input + right.input,
    cachedInput: left.cachedInput + right.cachedInput,
    cacheCreationInput: left.cacheCreationInput + right.cacheCreationInput,
    output,
    ...(reasoning === undefined ? {} : { reasoningOutput: reasoning }),
  };
}

function codexMinTotals(left: CodexJsonlTotals, right: CodexJsonlTotals): CodexJsonlTotals {
  const reasoning =
    left.reasoningOutput === undefined || right.reasoningOutput === undefined
      ? undefined
      : Math.min(left.reasoningOutput, right.reasoningOutput);
  return {
    input: Math.min(left.input, right.input),
    cachedInput: Math.min(left.cachedInput, right.cachedInput),
    cacheCreationInput: Math.min(left.cacheCreationInput, right.cacheCreationInput),
    output: Math.min(left.output, right.output),
    ...(reasoning === undefined ? {} : { reasoningOutput: reasoning }),
  };
}

function codexMaxTotals(
  left: CodexJsonlTotals | undefined,
  right: CodexJsonlTotals,
): CodexJsonlTotals {
  if (left === undefined) return right;
  const reasoning = codexMaxOptional(left.reasoningOutput, right.reasoningOutput);
  return {
    input: Math.max(left.input, right.input),
    cachedInput: Math.max(left.cachedInput, right.cachedInput),
    cacheCreationInput: Math.max(left.cacheCreationInput, right.cacheCreationInput),
    output: Math.max(left.output, right.output),
    ...(reasoning === undefined ? {} : { reasoningOutput: reasoning }),
  };
}

function codexMaxOptional(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.max(left, right);
}

function codexOptionalDelta(
  baseline: number | undefined,
  current: number | undefined,
  hasBaseline: boolean,
): number | undefined {
  if (current === undefined) return undefined;
  if (!hasBaseline) return current;
  if (baseline === undefined) return undefined;
  return Math.max(0, current - baseline);
}

function codexTotalDelta(
  baseline: CodexJsonlTotals | undefined,
  current: CodexJsonlTotals,
): CodexJsonlTotals {
  const zero = zeroCodexTotals(false);
  const base = baseline ?? zero;
  const reasoning = codexOptionalDelta(
    baseline?.reasoningOutput,
    current.reasoningOutput,
    baseline !== undefined,
  );
  return {
    input: Math.max(0, current.input - base.input),
    cachedInput: Math.max(0, current.cachedInput - base.cachedInput),
    cacheCreationInput: Math.max(0, current.cacheCreationInput - base.cacheCreationInput),
    output: Math.max(0, current.output - base.output),
    ...(reasoning === undefined ? {} : { reasoningOutput: reasoning }),
  };
}

function codexDivergentTotalDelta(options: {
  readonly rawBaseline?: CodexJsonlTotals | undefined;
  readonly countedBaseline?: CodexJsonlTotals | undefined;
  readonly current: CodexJsonlTotals;
}): CodexJsonlTotals {
  const raw = options.rawBaseline ?? zeroCodexTotals(false);
  const counted = options.countedBaseline ?? zeroCodexTotals(false);
  const component = (rawValue: number, countedValue: number, current: number): number =>
    current >= rawValue ? Math.max(0, current - rawValue) : Math.max(0, current - countedValue);
  const reasoning = codexDivergentOptionalDelta(
    raw.reasoningOutput,
    counted.reasoningOutput,
    options.current.reasoningOutput,
  );
  return {
    input: component(raw.input, counted.input, options.current.input),
    cachedInput: component(raw.cachedInput, counted.cachedInput, options.current.cachedInput),
    cacheCreationInput: component(
      raw.cacheCreationInput,
      counted.cacheCreationInput,
      options.current.cacheCreationInput,
    ),
    output: component(raw.output, counted.output, options.current.output),
    ...(reasoning === undefined ? {} : { reasoningOutput: reasoning }),
  };
}

function codexDivergentOptionalDelta(
  raw: number | undefined,
  counted: number | undefined,
  current: number | undefined,
): number | undefined {
  if (raw === undefined || counted === undefined || current === undefined) return undefined;
  return current >= raw ? Math.max(0, current - raw) : Math.max(0, current - counted);
}

function codexContainedTotalDelta(options: {
  readonly watermark?: CodexJsonlTotals | undefined;
  readonly counted?: CodexJsonlTotals | undefined;
  readonly current: CodexJsonlTotals;
}): CodexJsonlTotals {
  const watermark = options.watermark ?? zeroCodexTotals(false);
  const counted = options.counted ?? zeroCodexTotals(false);
  const component = (water: number, countedValue: number, current: number): number =>
    current >= water
      ? Math.max(0, current - Math.max(water, countedValue))
      : Math.max(0, current - countedValue);
  const reasoning = codexContainedOptionalDelta(
    watermark.reasoningOutput,
    counted.reasoningOutput,
    options.current.reasoningOutput,
  );
  return {
    input: component(watermark.input, counted.input, options.current.input),
    cachedInput: component(watermark.cachedInput, counted.cachedInput, options.current.cachedInput),
    cacheCreationInput: component(
      watermark.cacheCreationInput,
      counted.cacheCreationInput,
      options.current.cacheCreationInput,
    ),
    output: component(watermark.output, counted.output, options.current.output),
    ...(reasoning === undefined ? {} : { reasoningOutput: reasoning }),
  };
}

function codexContainedOptionalDelta(
  water: number | undefined,
  counted: number | undefined,
  current: number | undefined,
): number | undefined {
  if (water === undefined || counted === undefined || current === undefined) return undefined;
  return current >= water
    ? Math.max(0, current - Math.max(water, counted))
    : Math.max(0, current - counted);
}

function codexPostLatchEventDelta(options: {
  readonly watermark?: CodexJsonlTotals | undefined;
  readonly counted?: CodexJsonlTotals | undefined;
  readonly current: CodexJsonlTotals;
  readonly adjustedLast?: CodexJsonlTotals | undefined;
}): CodexJsonlTotals {
  const contained = codexContainedTotalDelta({
    watermark: options.watermark,
    counted: options.counted,
    current: options.current,
  });
  return options.adjustedLast === undefined
    ? contained
    : codexMinTotals(options.adjustedLast, contained);
}

function codexShouldPreferTotalDelta(options: {
  readonly rawBaseline?: CodexJsonlTotals | undefined;
  readonly currentTotal: CodexJsonlTotals;
  readonly totalDelta: CodexJsonlTotals;
  readonly lastDelta: CodexJsonlTotals;
  readonly sawDivergentTotals: boolean;
}): boolean {
  return (
    !options.sawDivergentTotals &&
    options.rawBaseline !== undefined &&
    codexTotalsAtLeast(options.currentTotal, options.rawBaseline) &&
    codexTotalsAtMost(options.totalDelta, options.lastDelta)
  );
}

function isBelowRawWatermark(
  current: CodexJsonlTotals,
  watermark: CodexJsonlTotals | undefined,
): boolean {
  if (watermark === undefined) return false;
  return (
    current.input < watermark.input ||
    current.cachedInput < watermark.cachedInput ||
    current.cacheCreationInput < watermark.cacheCreationInput ||
    current.output < watermark.output
  );
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

function positiveTotalsDifference(
  current: CodexJsonlTotals,
  previous: CodexJsonlTotals,
): CodexJsonlTotals {
  const reasoningDelta =
    current.reasoningOutput === undefined || previous.reasoningOutput === undefined
      ? undefined
      : Math.max(0, current.reasoningOutput - previous.reasoningOutput);
  return {
    input: Math.max(0, current.input - previous.input),
    cachedInput: Math.max(0, current.cachedInput - previous.cachedInput),
    cacheCreationInput: Math.max(0, current.cacheCreationInput - previous.cacheCreationInput),
    output: Math.max(0, current.output - previous.output),
    ...(reasoningDelta === undefined ? {} : { reasoningOutput: reasoningDelta }),
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

function isStaleRegression(
  current: CodexJsonlTotals,
  previous: CodexJsonlTotals,
  last: CodexJsonlTotals,
): boolean {
  const reasoningRegressed =
    current.reasoningOutput !== undefined &&
    previous.reasoningOutput !== undefined &&
    current.reasoningOutput < previous.reasoningOutput;
  const hasRegression =
    current.input < previous.input ||
    current.cachedInput < previous.cachedInput ||
    current.cacheCreationInput < previous.cacheCreationInput ||
    current.output < previous.output ||
    reasoningRegressed;
  if (!hasRegression) return false;
  const previousTotal =
    previous.input +
    previous.cachedInput +
    previous.cacheCreationInput +
    previous.output +
    (previous.reasoningOutput ?? 0);
  const currentTotal =
    current.input +
    current.cachedInput +
    current.cacheCreationInput +
    current.output +
    (current.reasoningOutput ?? 0);
  const lastTotal =
    last.input +
    last.cachedInput +
    last.cacheCreationInput +
    last.output +
    (last.reasoningOutput ?? 0);
  if (previousTotal <= 0 || currentTotal <= 0 || lastTotal <= 0) return false;
  return currentTotal * 100 >= previousTotal * 98 || currentTotal + lastTotal * 2 >= previousTotal;
}

function tokenCount(tokens: CostJsonlTokens): number {
  return tokens.input + tokens.cachedInput + tokens.cacheCreationInput + tokens.output;
}

function codexNonReasoningTokenCount(tokens: CodexJsonlTotals): number {
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
