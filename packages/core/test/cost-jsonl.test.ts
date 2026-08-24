import { describe, expect, it } from "vite-plus/test";

import {
  assertLocalCostUsageScanCheckpointJson,
  LOCAL_COST_USAGE_SCAN_CHECKPOINT_MAX_BYTES,
  applyCodexTotalsAccumulatorEvent,
  parseClaudeCostJsonl,
  parseCodexCostJsonl,
  replayCodexTotalSnapshotsAtOrBefore,
  scanCostJsonlChunks,
  type CodexJsonlTotals,
  type CodexTotalsAccumulatorState,
  type CostJsonlTokens,
} from "../src/index.ts";

const encoder = new TextEncoder();

async function* chunks(...parts: string[]): AsyncIterable<Uint8Array> {
  for (const part of parts) yield encoder.encode(part);
}

describe("cost JSONL scanner (Swift parity)", () => {
  it("bounds portable scanner checkpoints by UTF-8 bytes", () => {
    const valid = JSON.stringify({
      state: "x".repeat(LOCAL_COST_USAGE_SCAN_CHECKPOINT_MAX_BYTES - 20),
    });
    expect(() => assertLocalCostUsageScanCheckpointJson(valid)).not.toThrow();
    expect(() =>
      assertLocalCostUsageScanCheckpointJson(`{"state":"${"é".repeat(600_000)}"}`),
    ).toThrow("local cost usage scan checkpoint is invalid");
  });

  it("commits only complete lines and replays an appended tail without losing it", async () => {
    const lines: string[] = [];
    const first = await scanCostJsonlChunks(chunks('{"one":1}\n{"two":'), {
      onLine: (line) => {
        lines.push(new TextDecoder().decode(line));
      },
    });
    expect(lines).toEqual(['{"one":1}']);
    expect(first.cursor.committedOffset).toBe(10);

    const second = await scanCostJsonlChunks(chunks('{"two":2}\n'), {
      startOffset: first.cursor.committedOffset,
      onLine: (line) => {
        lines.push(new TextDecoder().decode(line));
      },
    });
    expect(lines).toEqual(['{"one":1}', '{"two":2}']);
    expect(second.cursor.committedOffset).toBe(20);
  });

  it("honors byte bounds and skips oversized records without retaining their body", async () => {
    const lines: string[] = [];
    const result = await scanCostJsonlChunks(chunks("1234567890\n", '{"safe":true}\n'), {
      maxBytes: 11,
      maxLineBytes: 4,
      onLine: (line) => {
        lines.push(new TextDecoder().decode(line));
      },
    });
    expect(result.metrics).toMatchObject({
      readBytes: 11,
      skippedOversizeLines: 1,
      hitByteLimit: true,
    });
    expect(lines).toEqual([]);
    expect(result.cursor.committedOffset).toBe(11);
  });

  it("advances an unterminated oversized record across bounded refreshes", async () => {
    const first = await scanCostJsonlChunks(chunks("abcdef"), {
      maxBytes: 3,
      maxLineBytes: 2,
      onLine: () => undefined,
    });
    expect(first.cursor).toEqual({ committedOffset: 0, discardOffset: 3 });
    const second = await scanCostJsonlChunks(chunks("def\n{}\n"), {
      cursor: first.cursor,
      maxBytes: 3,
      maxLineBytes: 2,
      onLine: () => undefined,
    });
    expect(second.cursor).toEqual({ committedOffset: 0, discardOffset: 6 });
    const lines: string[] = [];
    const third = await scanCostJsonlChunks(chunks("\n{}\n"), {
      cursor: second.cursor,
      onLine: (line) => {
        lines.push(new TextDecoder().decode(line));
      },
    });
    expect(lines).toEqual(["{}"]);
    expect(third.cursor).toEqual({ committedOffset: 10 });
  });

  it("checks cancellation while processing a large chunk", async () => {
    let checks = 0;
    await expect(
      scanCostJsonlChunks(chunks(`${"x".repeat(80_000)}\n`), {
        checkCancelled: () => {
          checks += 1;
          if (checks >= 3) throw new Error("cancelled");
        },
        onLine: () => undefined,
      }),
    ).rejects.toThrow("cancelled");
    expect(checks).toBeGreaterThanOrEqual(3);
  });
});

describe("Codex totals accumulator (Swift d927 parity)", () => {
  it("A uses last on an initial total+last snapshot and records raw/watermark baselines", () => {
    const applied = applyCodexTotalsAccumulatorEvent(undefined, {
      total: codexTotal(10, 3),
      last: codexTotal(5, 1),
    });
    expect(applied.delta).toEqual(tokens(5, 0, 0, 1));
    expect(applied.state.countedTotals).toEqual(codexTotal(5, 1));
    expect(applied.state.rawTotalsBaseline).toEqual(codexTotal(10, 3));
    expect(applied.state.rawTotalsWatermark).toEqual(codexTotal(10, 3));
  });

  it("B prefers total delta when it is contained by last", () => {
    let state = applyCodexTotalsAccumulatorEvent(undefined, { total: codexTotal(10, 3) }).state;
    const applied = applyCodexTotalsAccumulatorEvent(state, {
      total: codexTotal(15, 5),
      last: codexTotal(5, 2),
    });
    expect(applied.delta).toEqual(tokens(5, 0, 0, 2));
    expect(applied.state.countedTotals).toEqual(codexTotal(15, 5));
  });

  it("B2 includes cache creation tokens in deltas, watermarks, and duplicate identity", () => {
    const firstTotal: CodexJsonlTotals = {
      ...codexTotal(10, 3),
      cacheCreationInput: 4,
    };
    const nextTotal: CodexJsonlTotals = {
      ...codexTotal(12, 4),
      cacheCreationInput: 7,
    };
    const first = applyCodexTotalsAccumulatorEvent(undefined, { total: firstTotal });
    const next = applyCodexTotalsAccumulatorEvent(first.state, { total: nextTotal });

    expect(next.delta).toEqual(tokens(2, 0, 3, 1));
    expect(next.state.countedTotals).toEqual(nextTotal);
    expect(next.state.rawTotalsWatermark).toEqual(nextTotal);

    const duplicate = applyCodexTotalsAccumulatorEvent(next.state, { total: nextTotal });
    expect(duplicate.skipped).toBe("duplicate");
    expect(duplicate.state).toEqual(next.state);
  });

  it("C keeps last when total delta exceeds last and latches divergence", () => {
    let state = applyCodexTotalsAccumulatorEvent(undefined, { total: codexTotal(10, 3) }).state;
    const applied = applyCodexTotalsAccumulatorEvent(state, {
      total: codexTotal(17, 7),
      last: codexTotal(3, 1),
    });
    expect(applied.delta).toEqual(tokens(3, 0, 0, 1));
    expect(applied.state.countedTotals).toEqual(codexTotal(13, 4));
    expect(applied.state.rawTotalsBaseline).toEqual(codexTotal(17, 7));
    expect(applied.state.sawDivergentTotals).toBe(true);
  });

  it("D skips stale total regressions without mutating accumulator state", () => {
    const state = applyCodexTotalsAccumulatorEvent(undefined, { total: codexTotal(10, 3) }).state;
    const applied = applyCodexTotalsAccumulatorEvent(state, {
      total: codexTotal(8, 2),
      last: codexTotal(5, 1),
    });
    expect(applied.delta).toEqual(tokens(0, 0, 0, 0));
    expect(applied.skipped).toBe("stale");
    expect(applied.state).toEqual(state);
  });

  it("E treats reasoning-only raw duplicates as seen and bounds seen totals at sixty four", () => {
    let state: CodexTotalsAccumulatorState | undefined;
    for (let index = 1; index <= 70; index += 1) {
      state = applyCodexTotalsAccumulatorEvent(state, { total: codexTotal(index, 10) }).state;
    }
    expect(state?.seenRawTotals).toHaveLength(64);
    const applied = applyCodexTotalsAccumulatorEvent(state, {
      total: codexTotal(70, 10, 5),
    });
    expect(applied.skipped).toBe("duplicate");
    expect(applied.delta).toEqual(tokens(0, 0, 0, 0));
    expect(applied.state).toEqual(state);
  });

  it("F contains interleaved totals-only lineages and resumes above the watermark", () => {
    let state: CodexTotalsAccumulatorState | undefined;
    const rows: CostJsonlTokens[] = [];
    for (const total of [
      codexTotal(10, 3),
      codexTotal(4, 1),
      codexTotal(7, 2),
      codexTotal(12, 4),
    ]) {
      const applied = applyCodexTotalsAccumulatorEvent(state, { total });
      rows.push(applied.delta);
      state = applied.state;
    }
    expect(rows).toEqual([
      tokens(10, 0, 0, 3),
      tokens(0, 0, 0, 0),
      tokens(0, 0, 0, 0),
      tokens(2, 0, 0, 1),
    ]);
    expect(state?.countedTotals).toEqual(codexTotal(12, 4));
    expect(state?.rawTotalsWatermark).toEqual(codexTotal(12, 4));
    expect(state?.sawInterleavedTotals).toBe(true);
  });

  it("G caps post-latch total+last rows by contained delta", () => {
    const state: CodexTotalsAccumulatorState = {
      countedTotals: codexTotal(10, 3),
      rawTotalsBaseline: codexTotal(4, 1),
      rawTotalsWatermark: codexTotal(10, 3),
      seenRawTotals: [codexTotal(10, 3), codexTotal(4, 1)],
      sawInterleavedTotals: true,
      sawDivergentTotals: true,
    };
    const applied = applyCodexTotalsAccumulatorEvent(state, {
      total: codexTotal(12, 4),
      last: codexTotal(5, 2),
    });
    expect(applied.delta).toEqual(tokens(2, 0, 0, 1));
  });

  it("H treats omitted reasoning after explicit reasoning as unknown, not a regression", () => {
    const first = applyCodexTotalsAccumulatorEvent(undefined, {
      total: codexTotal(10, 5, 2),
    });
    const second = applyCodexTotalsAccumulatorEvent(first.state, {
      total: codexTotal(12, 6),
    });
    expect(second.delta).toEqual(tokens(2, 0, 0, 1));
    expect(second.state.countedTotals?.reasoningOutput).toBeUndefined();
  });

  it("I replays snapshots in file order and lets future nonmonotonic rows affect state", () => {
    const cutoff = Date.parse("2030-01-01T12:00:02Z");
    const replayed = replayCodexTotalSnapshotsAtOrBefore(
      [
        { timestamp: Date.parse("2030-01-01T12:00:01Z"), totals: codexTotal(10, 3) },
        { timestamp: Date.parse("2030-01-01T12:00:03Z"), totals: codexTotal(15, 5) },
        {
          timestamp: cutoff,
          totals: codexTotal(8, 2),
          last: codexTotal(5, 1),
        },
      ],
      cutoff,
    );
    expect(replayed).toEqual(codexTotal(15, 5));

    const nonmonotonic = replayCodexTotalSnapshotsAtOrBefore(
      [
        { timestamp: Date.parse("2030-01-01T12:00:03Z"), totals: codexTotal(10, 3) },
        { timestamp: Date.parse("2030-01-01T12:00:01Z"), totals: codexTotal(15, 5) },
      ],
      cutoff,
    );
    expect(nonmonotonic).toEqual(codexTotal(15, 5));
  });

  it("I2 replays last-only parent snapshots into the fork baseline", () => {
    const cutoff = Date.parse("2030-01-01T12:00:02Z");
    const replayed = replayCodexTotalSnapshotsAtOrBefore(
      [
        { timestamp: Date.parse("2030-01-01T12:00:01Z"), last: codexTotal(60, 3) },
        { timestamp: cutoff, last: codexTotal(50, 2) },
      ],
      cutoff,
    );

    expect(replayed).toEqual(codexTotal(110, 5));
  });
});

describe("Codex cost JSONL parser (Swift parity)", () => {
  it("uses total snapshots incrementally, preserves context model, and attributes list-price estimates", async () => {
    const first = await parseCodexCostJsonl(
      chunks(
        '{"type":"turn_context","timestamp":"2026-08-20T10:00:00Z","payload":{"model":"openai/gpt-5.6-terra"}}\n',
        '{"type":"event_msg","timestamp":"2026-08-20T10:00:01Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":10,"output_tokens":5}}}}\n',
      ),
      { scan: {} },
    );
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0]).toMatchObject({
      provider: "codex",
      model: "gpt-5.6-terra",
      tokens: { input: 100, cachedInput: 10, output: 5 },
      provenance: "list-price-estimate",
    });

    const second = await parseCodexCostJsonl(
      chunks(
        '{"type":"event_msg","timestamp":"2026-08-20T10:00:02Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":130,"cached_input_tokens":12,"output_tokens":9}}}}\n',
      ),
      { state: first.state, scan: { startOffset: first.cursor.committedOffset } },
    );
    expect(second.rows).toHaveLength(1);
    expect(second.rows[0]?.tokens).toMatchObject({ input: 30, cachedInput: 2, output: 4 });
  });

  it("uses the maximum normalized Codex cache-read field from event_msg token counts", async () => {
    const cases = [
      {
        usage: { input_tokens: 100, cached_input_tokens: 9, output_tokens: 5 },
        cachedInput: 9,
      },
      {
        usage: { input_tokens: 100, cache_read_input_tokens: 11, output_tokens: 5 },
        cachedInput: 11,
      },
      {
        usage: {
          input_tokens: 100,
          cached_input_tokens: 0,
          cache_read_input_tokens: 13,
          output_tokens: 5,
        },
        cachedInput: 13,
        costUsd: 0.0002366,
      },
      {
        usage: {
          input_tokens: 100,
          cached_input_tokens: 17,
          cache_read_input_tokens: 5,
          output_tokens: 5,
        },
        cachedInput: 17,
      },
      {
        usage: {
          input_tokens: 100,
          cached_input_tokens: -1,
          cache_read_input_tokens: "bad",
          output_tokens: 5,
        },
        cachedInput: 0,
      },
    ] as const;

    for (const testCase of cases) {
      const result = await parseCodexCostJsonl(
        chunks(
          `${JSON.stringify({
            type: "event_msg",
            timestamp: "2026-08-20T10:00:01Z",
            payload: {
              type: "token_count",
              info: { model: "gpt-5.6-terra", total_token_usage: testCase.usage },
            },
          })}\n`,
        ),
        { scan: {} },
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.tokens).toMatchObject({
        input: 100,
        cachedInput: testCase.cachedInput,
        output: 5,
      });
      if ("costUsd" in testCase) expect(result.rows[0]?.costUsd).toBeCloseTo(testCase.costUsd, 12);
    }
  });

  it("deduplicates last usage fallbacks and fails closed for unknown prices", async () => {
    const line =
      '{"type":"event_msg","timestamp":"2026-08-20T10:00:01Z","payload":{"type":"token_count","info":{"model":"unlisted","last_token_usage":{"input_tokens":7,"output_tokens":2}}}}\n';
    const result = await parseCodexCostJsonl(chunks(line, line), { scan: {} });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ model: "unlisted", provenance: "unknown" });
    expect(result.rows[0]?.costUsd).toBeUndefined();
  });

  it("preserves Swift task_started priority metadata across an incremental cursor", async () => {
    const first = await parseCodexCostJsonl(
      chunks(
        '{"type":"event_msg","timestamp":"2026-08-20T10:00:00Z","payload":{"type":"task_started","turn_id":"priority-turn"}}\n',
        '{"type":"event_msg","timestamp":"2026-08-20T10:00:01Z","payload":{"type":"token_count","info":{"model":"gpt-5.6-terra","total_token_usage":{"input_tokens":10,"output_tokens":2}}}}\n',
      ),
      { priorityTurns: { "priority-turn": { model: "gpt-5.6-terra" } }, scan: {} },
    );
    expect(first.state.currentTurnId).toBe("priority-turn");
    expect(first.rows[0]).toMatchObject({
      turnId: "priority-turn",
      pricingMode: "priority",
      model: "gpt-5.6-terra",
    });
    // API Fast is a 2x rate for Terra at this request size. This locks the
    // Swift `max(priority, standard)` overlay rather than just a label.
    expect(first.rows[0]?.costUsd).toBeCloseTo(0.000088, 12);

    const second = await parseCodexCostJsonl(
      chunks(
        '{"type":"event_msg","timestamp":"2026-08-20T10:00:02Z","payload":{"type":"token_count","info":{"model":"gpt-5.6-terra","total_token_usage":{"input_tokens":15,"output_tokens":3}}}}\n',
      ),
      {
        state: first.state,
        priorityTurns: { "priority-turn": { model: "gpt-5.6-terra" } },
        scan: { cursor: first.cursor },
      },
    );
    expect(second.rows[0]).toMatchObject({
      turnId: "priority-turn",
      pricingMode: "priority",
      tokens: { input: 5, output: 1 },
    });
  });

  it("uses a trace completion alias only when it has a supported Swift Fast price", async () => {
    const supported = await parseCodexCostJsonl(
      chunks(
        '{"type":"event_msg","timestamp":"2026-08-20T10:00:00Z","payload":{"type":"task_started","turn_id":"turn"}}\n',
        '{"type":"event_msg","timestamp":"2026-08-20T10:00:01Z","payload":{"type":"token_count","info":{"model":"gpt-5.4-mini","total_token_usage":{"input_tokens":10,"output_tokens":2}}}}\n',
      ),
      { priorityTurns: { turn: { model: "gpt-5.6-terra" } }, scan: {} },
    );
    expect(supported.rows[0]).toMatchObject({
      model: "gpt-5.4-mini",
      pricingModel: "gpt-5.6-terra",
      pricingMode: "priority",
    });

    const unsupported = await parseCodexCostJsonl(
      chunks(
        '{"type":"event_msg","timestamp":"2026-08-20T10:00:00Z","payload":{"type":"task_started","turn_id":"turn"}}\n',
        '{"type":"event_msg","timestamp":"2026-08-20T10:00:01Z","payload":{"type":"token_count","info":{"model":"gpt-5.4-mini","total_token_usage":{"input_tokens":10,"output_tokens":2}}}}\n',
      ),
      { priorityTurns: { turn: { model: "unpriced-trace-alias" } }, scan: {} },
    );
    expect(unsupported.rows[0]).toMatchObject({
      model: "gpt-5.4-mini",
      pricingMode: "priority",
    });
    expect(unsupported.rows[0]?.pricingModel).toBeUndefined();
  });

  it("clears a stale priority turn when Swift's task_started record has no turn id", async () => {
    const result = await parseCodexCostJsonl(
      chunks(
        '{"type":"event_msg","timestamp":"2026-08-20T10:00:00Z","payload":{"type":"task_started","turn_id":"priority-turn"}}\n',
        '{"type":"event_msg","timestamp":"2026-08-20T10:00:01Z","payload":{"type":"event_msg"}}\n',
        '{"type":"event_msg","timestamp":"2026-08-20T10:00:02Z","payload":{"type":"task_started"}}\n',
        '{"type":"event_msg","timestamp":"2026-08-20T10:00:03Z","payload":{"type":"token_count","info":{"model":"gpt-5.6-terra","total_token_usage":{"input_tokens":10,"output_tokens":2}}}}\n',
      ),
      { priorityTurns: { "priority-turn": { model: "gpt-5.6-terra" } }, scan: {} },
    );
    expect(result.rows[0]).toMatchObject({ model: "gpt-5.6-terra" });
    expect(result.rows[0]?.pricingMode).toBeUndefined();
    expect(result.state.currentTurnId).toBeUndefined();
  });

  it("contains a cumulative counter drop instead of marking fresh scans unsafe", async () => {
    const initial = await parseCodexCostJsonl(
      chunks(
        '{"type":"event_msg","timestamp":"2026-08-20T10:00:00Z","payload":{"type":"token_count","info":{"model":"gpt-5.6-terra","total_token_usage":{"input_tokens":100,"output_tokens":10}}}}\n',
      ),
      { scan: {} },
    );
    const unsafe = await parseCodexCostJsonl(
      chunks(
        '{"type":"event_msg","timestamp":"2026-08-20T10:00:01Z","payload":{"type":"token_count","info":{"model":"gpt-5.6-terra","total_token_usage":{"input_tokens":4,"output_tokens":1},"last_token_usage":{"input_tokens":4,"output_tokens":1}}}}\n',
      ),
      { state: initial.state, scan: { cursor: initial.cursor } },
    );
    expect(unsafe.rows).toEqual([]);
    expect(unsafe.state.cumulativeCounterUnsafe).toBeUndefined();
    expect(unsafe.state.sawInterleavedTotals).toBe(true);
    expect(unsafe.state.rawTotalsWatermark).toMatchObject({ input: 100, output: 10 });
    expect(unsafe.state.totals).toMatchObject({ input: 100, output: 10 });
  });

  it("J preserves containment state across incremental parser boundaries", async () => {
    const first = await parseCodexCostJsonl(
      chunks(
        codexTokenCountLine("2030-01-01T12:00:01Z", {
          total: codexTotal(100_000, 0),
          last: codexTotal(100_000, 0),
        }),
        codexTokenCountLine("2030-01-01T12:00:02Z", {
          total: codexTotal(5000, 0),
          last: codexTotal(5000, 0),
        }),
      ),
      { scan: {} },
    );
    expect(first.rows.map((row) => row.tokens.input)).toEqual([100_000]);
    expect(first.state).toMatchObject({
      totals: { input: 100_000, output: 0 },
      rawTotalsBaseline: { input: 5000, output: 0 },
      rawTotalsWatermark: { input: 100_000, output: 0 },
      sawInterleavedTotals: true,
      sawDivergentTotals: true,
    });
    expect(first.state.seenRawTotals).toHaveLength(2);

    const second = await parseCodexCostJsonl(
      chunks(
        codexTokenCountLine("2030-01-01T12:00:03Z", {
          total: codexTotal(100_000, 0),
          last: codexTotal(100_000, 0),
        }),
        codexTokenCountLine("2030-01-01T12:00:04Z", {
          total: codexTotal(5000, 0),
          last: codexTotal(5000, 0),
        }),
        codexTokenCountLine("2030-01-01T12:00:05Z", {
          total: codexTotal(101_000, 0),
          last: codexTotal(1000, 0),
        }),
      ),
      { state: first.state, scan: { cursor: first.cursor } },
    );
    expect(second.rows.map((row) => row.tokens.input)).toEqual([1000]);
    expect(second.state).toMatchObject({
      totals: { input: 101_000, output: 0 },
      rawTotalsBaseline: { input: 101_000, output: 0 },
      rawTotalsWatermark: { input: 101_000, output: 0 },
      sawInterleavedTotals: true,
      sawDivergentTotals: true,
    });
    expect(second.state.seenRawTotals).toHaveLength(3);
  });

  it("uses a resolved parent baseline only for its declared Issue #2037 fork", async () => {
    const parent = await parseCodexCostJsonl(
      chunks(
        '{"type":"session_meta","timestamp":"2030-01-01T12:00:00Z","payload":{"id":"parent-session"}}\n',
        '{"type":"event_msg","timestamp":"2030-01-01T12:00:01Z","payload":{"type":"token_count","info":{"model":"fixture-model","total_token_usage":{"input_tokens":100,"cached_input_tokens":10,"output_tokens":5}}}}\n',
      ),
      { scan: {} },
    );
    const parentId = parent.state.session?.id;
    const parentTotals = parent.state.totals;
    expect(parentId).toBe("parent-session");
    expect(parentTotals).toBeDefined();

    const child = await parseCodexCostJsonl(
      chunks(
        '{"type":"session_meta","timestamp":"2030-01-01T15:00:00Z","payload":{"id":"child-session","forked_from_id":"parent-session","timestamp":"2030-01-01T15:00:00Z"}}\n',
        '{"type":"event_msg","timestamp":"2030-01-01T15:00:00Z","payload":{"type":"token_count","info":{"model":"fixture-model","total_token_usage":{"input_tokens":10,"cached_input_tokens":1,"output_tokens":1}}}}\n',
        '{"type":"event_msg","timestamp":"2030-01-01T15:00:01Z","payload":{"type":"token_count","info":{"model":"fixture-model","total_token_usage":{"input_tokens":100,"cached_input_tokens":10,"output_tokens":5}}}}\n',
        '{"type":"event_msg","timestamp":"2030-01-01T15:00:02Z","payload":{"type":"token_count","info":{"model":"fixture-model","total_token_usage":{"input_tokens":120,"cached_input_tokens":12,"output_tokens":9},"last_token_usage":{"input_tokens":5,"cached_input_tokens":1,"output_tokens":1}}}}\n',
      ),
      {
        forkBaseline: { parentSessionId: parentId!, totals: parentTotals! },
        scan: {},
      },
    );
    expect(child.state.session).toMatchObject({
      id: "child-session",
      forkedFromId: "parent-session",
      forkTimestamp: Date.parse("2030-01-01T15:00:00Z"),
    });
    expect(child.rows).toHaveLength(1);
    expect(child.rows[0]?.tokens).toMatchObject({ input: 20, cachedInput: 2, output: 4 });

    const mismatchedParent = await parseCodexCostJsonl(
      chunks(
        '{"type":"session_meta","timestamp":"2030-01-01T15:00:00Z","payload":{"id":"child-session","forked_from_id":"another-parent"}}\n',
        '{"type":"event_msg","timestamp":"2030-01-01T15:00:01Z","payload":{"type":"token_count","info":{"model":"fixture-model","total_token_usage":{"input_tokens":100,"cached_input_tokens":10,"output_tokens":5}}}}\n',
      ),
      { forkBaseline: { parentSessionId: parentId!, totals: parentTotals! }, scan: {} },
    );
    expect(mismatchedParent.rows[0]?.tokens).toMatchObject({
      input: 100,
      cachedInput: 10,
      output: 5,
    });
  });

  it("resumes an identified fork by waiting for a newly supplied parent baseline", async () => {
    const result = await parseCodexCostJsonl(
      chunks(
        codexTokenCountLine("2030-01-01T15:00:00Z", { total: codexTotal(10, 1) }),
        codexTokenCountLine("2030-01-01T15:00:01Z", { total: codexTotal(100, 5) }),
        codexTokenCountLine("2030-01-01T15:00:02Z", { total: codexTotal(120, 9) }),
      ),
      {
        state: {
          session: {
            id: "child-session",
            forkedFromId: "parent-session",
          },
        },
        forkBaseline: {
          parentSessionId: "parent-session",
          totals: codexTotal(100, 5),
        },
        scan: {},
      },
    );

    expect(result.rows.map((row) => row.tokens)).toEqual([tokens(20, 0, 0, 4)]);
    expect(result.state.awaitingForkBaseline).toBeUndefined();
  });

  it("counts only last-only fork usage that exceeds the remaining inherited prefix", async () => {
    const forkBaseline = {
      parentSessionId: "parent-session",
      totals: codexTotal(100, 5),
    };
    const first = await parseCodexCostJsonl(
      chunks(codexTokenCountLine("2030-01-01T15:00:00Z", { last: codexTotal(60, 3) })),
      {
        state: {
          session: {
            id: "child-session",
            forkedFromId: "parent-session",
          },
        },
        forkBaseline,
        scan: {},
      },
    );
    expect(first.rows).toEqual([]);
    expect(first.state.remainingInheritedTotals).toEqual(codexTotal(40, 2));

    const second = await parseCodexCostJsonl(
      chunks(codexTokenCountLine("2030-01-01T15:00:01Z", { last: codexTotal(50, 3) })),
      { state: first.state, forkBaseline, scan: {} },
    );
    expect(second.rows.map((row) => row.tokens)).toEqual([tokens(10, 0, 0, 1)]);
    expect(second.state.remainingInheritedTotals).toBeUndefined();
  });

  it("collects bounded raw cumulative snapshots only when a host resolves a fork family", async () => {
    const result = await parseCodexCostJsonl(
      chunks(
        '{"type":"event_msg","timestamp":"2030-01-01T12:00:00Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":10,"output_tokens":1}}}}\n',
        '{"type":"event_msg","timestamp":"2030-01-01T12:00:02Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":15,"output_tokens":3}}}}\n',
        '{"type":"event_msg","timestamp":"2030-01-01T12:00:03Z","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":2,"output_tokens":1}}}}\n',
      ),
      { collectTotalsForForkBaseline: true, scan: {} },
    );
    expect(result.totalSnapshotsComplete).toBe(true);
    expect(result.totalSnapshots).toEqual([
      {
        timestamp: Date.parse("2030-01-01T12:00:00Z"),
        totals: { input: 10, cachedInput: 0, cacheCreationInput: 0, output: 1 },
      },
      {
        timestamp: Date.parse("2030-01-01T12:00:02Z"),
        totals: { input: 15, cachedInput: 0, cacheCreationInput: 0, output: 3 },
      },
      {
        timestamp: Date.parse("2030-01-01T12:00:03Z"),
        last: { input: 2, cachedInput: 0, cacheCreationInput: 0, output: 1 },
      },
    ]);

    const ordinary = await parseCodexCostJsonl(
      chunks(
        '{"type":"event_msg","timestamp":"2030-01-01T12:00:00Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":10}}}}\n',
      ),
      { scan: {} },
    );
    expect(ordinary.totalSnapshots).toBeUndefined();
  });
});

describe("Codex bare usage envelopes (Swift d927 parity)", () => {
  const timestamp = "2026-08-21T12:00:00Z";

  it("parses canonical envelopes, aliases, cached subtraction, and container precedence", async () => {
    const result = await parseCodexCostJsonl(
      chunks(
        `${JSON.stringify({
          timestamp,
          model: "openai/gpt-5.2-codex",
          usage: { prompt_tokens: 120, completion_tokens: 30, cached_tokens: 20 },
          data: { usage: { input_tokens: 999, output_tokens: 999 } },
        })}\n`,
        `${JSON.stringify({ timestamp, data: { usage: { input: 10, output: 4 } } })}\n`,
        `${JSON.stringify({ timestamp, result: { usage: { input_tokens: 7, output_tokens: 3 } } })}\n`,
        `${JSON.stringify({ timestamp, response: { usage: { input_tokens: 5, output_tokens: 1 } } })}\n`,
      ),
      { scan: {} },
    );

    expect(result.rows.map((row) => row.tokens)).toEqual([
      tokens(100, 20, 0, 30),
      tokens(10, 0, 0, 4),
      tokens(7, 0, 0, 3),
      tokens(5, 0, 0, 1),
    ]);
    expect(result.rows.map((row) => row.model)).toEqual([
      "gpt-5.2-codex",
      "unknown",
      "unknown",
      "unknown",
    ]);
    // Swift stores billed input and cached input separately for bare rows,
    // then feeds those same fields into its ordinary Codex pricing path.
    expect(result.rows[0]?.costUsd).toBeCloseTo(0.0005635, 12);
  });

  it("uses the first numeric alias and clamps bare counters with Swift-compatible normalization", async () => {
    const result = await parseCodexCostJsonl(
      chunks(
        `${JSON.stringify({
          timestamp,
          usage: {
            input_tokens: "ignored",
            prompt_tokens: 10.9,
            input: 999,
            output_tokens: Number.NaN,
            completion_tokens: 3.7,
            cached_input_tokens: -4,
            cache_read_input_tokens: 8,
          },
        })}\n`,
        `${JSON.stringify({
          timestamp,
          usage: {
            input_tokens: Number.MAX_SAFE_INTEGER + 1,
            output_tokens: 2,
            cached_input_tokens: 1,
          },
        })}\n`,
      ),
      { scan: {} },
    );

    expect(result.rows.map((row) => row.tokens)).toEqual([tokens(10, 0, 0, 3), tokens(0, 1, 0, 2)]);
  });

  it("persists only the last accepted bare timestamp for incremental fallback", async () => {
    const first = await parseCodexCostJsonl(
      chunks(`${JSON.stringify({ timestamp, usage: { input_tokens: 7, output_tokens: 3 } })}\n`),
      { scan: {} },
    );
    const second = await parseCodexCostJsonl(
      chunks(`${JSON.stringify({ result: { usage: { input_tokens: 5, output_tokens: 1 } } })}\n`),
      { state: first.state, scan: { cursor: first.cursor } },
    );
    const withoutPriorBare = await parseCodexCostJsonl(
      chunks(
        '{"type":"turn_context","timestamp":"2026-08-22T12:00:00Z","payload":{"model":"gpt-5.2-codex"}}\n',
        `${JSON.stringify({ result: { usage: { input_tokens: 5, output_tokens: 1 } } })}\n`,
      ),
      { scan: {} },
    );

    expect(first.state.lastBareUsageTimestamp).toBe(Date.parse(timestamp));
    expect(second.rows[0]?.timestamp).toBe(Date.parse(timestamp));
    expect(second.state.lastBareUsageTimestamp).toBe(Date.parse(timestamp));
    expect(withoutPriorBare.rows).toEqual([]);
    expect(withoutPriorBare.state.lastBareUsageTimestamp).toBeUndefined();
  });

  it("rejects typed and invalid envelopes without mutating cumulative accounting", async () => {
    const initial = await parseCodexCostJsonl(
      chunks(
        `${JSON.stringify({
          type: "event_msg",
          timestamp,
          payload: {
            type: "token_count",
            info: { total_token_usage: { input_tokens: 100, output_tokens: 10 } },
          },
        })}\n`,
      ),
      { scan: {} },
    );
    const result = await parseCodexCostJsonl(
      chunks(
        `${JSON.stringify({ type: "response", timestamp, usage: { input_tokens: 9, output_tokens: 2 } })}\n`,
        `${JSON.stringify({ timestamp, usage: { input_tokens: 9 } })}\n`,
        `${JSON.stringify({ timestamp, usage: { input_tokens: "9", output_tokens: 2 } })}\n`,
        `${JSON.stringify({ timestamp, usage: { input_tokens: 0, output_tokens: 0 } })}\n`,
        `${JSON.stringify({ timestamp, prompt: { usage: { input_tokens: 999, output_tokens: 999 } } })}\n`,
        `${JSON.stringify({ timestamp, usage: { input_tokens: 7, output_tokens: 2 } })}\n`,
      ),
      { state: initial.state, scan: { cursor: initial.cursor } },
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.tokens).toEqual(tokens(7, 0, 0, 2));
    expect(result.state.totals).toEqual(initial.state.totals);
  });

  it("preserves current model, turn, and priority pricing on bare rows", async () => {
    const result = await parseCodexCostJsonl(
      chunks(
        '{"type":"turn_context","timestamp":"2026-08-21T11:59:58Z","payload":{"model":"openai/gpt-5.4-mini"}}\n',
        '{"type":"event_msg","timestamp":"2026-08-21T11:59:59Z","payload":{"type":"task_started","turn_id":"priority-turn"}}\n',
        `${JSON.stringify({ timestamp, usage: { input_tokens: 10, output_tokens: 2 } })}\n`,
        `${JSON.stringify({
          timestamp,
          model_name: "openai/gpt-5.6-luna",
          data: { model: "gpt-5.6-terra" },
          usage: { input_tokens: 10, output_tokens: 2 },
        })}\n`,
      ),
      {
        priorityTurns: { "priority-turn": { model: "gpt-5.6-terra" } },
        scan: {},
      },
    );

    expect(result.rows[0]).toMatchObject({
      model: "gpt-5.4-mini",
      turnId: "priority-turn",
      pricingModel: "gpt-5.6-terra",
      pricingMode: "priority",
    });
    expect(result.rows[1]).toMatchObject({
      model: "gpt-5.6-luna",
      turnId: "priority-turn",
      pricingModel: "gpt-5.6-terra",
      pricingMode: "priority",
    });
  });
});

describe("Claude cost JSONL parser (Swift parity)", () => {
  it("deduplicates cumulative streaming message chunks across refreshes", async () => {
    const first = await parseClaudeCostJsonl(
      chunks(
        '{"type":"assistant","timestamp":"2026-08-20T10:00:00Z","requestId":"request-1","message":{"id":"message-1","model":"claude-opus-4-8","usage":{"input_tokens":10,"cache_read_input_tokens":2,"output_tokens":3}}}\n',
      ),
      { scan: {} },
    );
    expect(first.rows[0]?.tokens).toMatchObject({ input: 10, cachedInput: 2, output: 3 });
    const second = await parseClaudeCostJsonl(
      chunks(
        '{"type":"assistant","timestamp":"2026-08-20T10:00:01Z","requestId":"request-1","message":{"id":"message-1","model":"claude-opus-4-8","usage":{"input_tokens":14,"cache_read_input_tokens":2,"output_tokens":5}}}\n',
      ),
      { state: first.state, scan: { startOffset: first.cursor.committedOffset } },
    );
    expect(second.rows).toHaveLength(1);
    expect(second.rows[0]?.tokens).toEqual(tokens(4, 0, 0, 2));
    expect(second.rows[0]?.provenance).toBe("list-price-estimate");
  });

  it("fails closed after a cumulative message counter regresses", async () => {
    const initial = await parseClaudeCostJsonl(
      chunks(
        '{"type":"assistant","timestamp":"2026-08-20T10:00:00Z","requestId":"request-1","message":{"id":"message-1","model":"claude-opus-4-8","usage":{"input_tokens":10,"output_tokens":8}}}\n',
      ),
      { scan: {} },
    );
    const regressed = await parseClaudeCostJsonl(
      chunks(
        '{"type":"assistant","timestamp":"2026-08-20T10:00:01Z","requestId":"request-1","message":{"id":"message-1","model":"claude-opus-4-8","usage":{"input_tokens":2,"output_tokens":1}}}\n',
        '{"type":"assistant","timestamp":"2026-08-20T10:00:02Z","requestId":"request-1","message":{"id":"message-1","model":"claude-opus-4-8","usage":{"input_tokens":4,"output_tokens":3}}}\n',
      ),
      { state: initial.state, scan: { cursor: initial.cursor } },
    );
    expect(regressed.rows).toEqual([]);
    expect(regressed.state.unsafeMessageKeys).toEqual(["message-1:request-1"]);
  });

  it("rejects token counters outside the JavaScript safe-integer range", async () => {
    const result = await parseClaudeCostJsonl(
      chunks(
        '{"type":"assistant","timestamp":"2026-08-20T10:00:00Z","requestId":"request-1","message":{"id":"message-1","model":"claude-opus-4-8","usage":{"input_tokens":9007199254740992,"output_tokens":1}}}\n',
      ),
      { scan: {} },
    );
    expect(result.rows[0]?.tokens.input).toBe(0);
    expect(result.rows[0]?.tokens.output).toBe(1);
  });
});

describe("Codex stale regression and optional reasoning (d927 slice)", () => {
  it("skips a light stale regression and resumes deltas from the last accepted baseline", async () => {
    const first = await parseCodexCostJsonl(
      chunks(
        '{"type":"event_msg","timestamp":"2026-08-20T10:00:00Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":10,"output_tokens":3}}}}\n',
      ),
      { collectTotalsForForkBaseline: true, scan: {} },
    );
    expect(first.rows).toHaveLength(1);
    expect(first.state.totals).toMatchObject({ input: 10, output: 3 });
    const second = await parseCodexCostJsonl(
      chunks(
        '{"type":"event_msg","timestamp":"2026-08-20T10:00:01Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":8,"output_tokens":2},"last_token_usage":{"input_tokens":5,"output_tokens":1}}}}\n',
      ),
      { state: first.state, collectTotalsForForkBaseline: true, scan: { cursor: first.cursor } },
    );
    expect(second.rows).toHaveLength(0);
    expect(second.state.cumulativeCounterUnsafe).toBeUndefined();
    expect(second.state.totals).toMatchObject({ input: 10, output: 3 });
    expect(second.totalSnapshots).toHaveLength(1);
    expect(second.totalSnapshots?.[0]?.totals).toMatchObject({ input: 8, output: 2 });
    const third = await parseCodexCostJsonl(
      chunks(
        '{"type":"event_msg","timestamp":"2026-08-20T10:00:02Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":15,"output_tokens":5}}}}\n',
      ),
      { state: second.state, scan: { cursor: second.cursor } },
    );
    expect(third.rows).toHaveLength(1);
    expect(third.rows[0]?.tokens).toMatchObject({ input: 5, output: 2, reasoningOutput: 0 });
    expect(third.state.cumulativeCounterUnsafe).toBeUndefined();
  });

  it("accepts omitted reasoning after explicit reasoning without treating it as regression", async () => {
    const first = await parseCodexCostJsonl(
      chunks(
        '{"type":"event_msg","timestamp":"2026-08-20T10:00:00Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":10,"output_tokens":5,"reasoning_output_tokens":1}}}}\n',
      ),
      { scan: {} },
    );
    expect(first.state.totals?.reasoningOutput).toBe(1);
    const second = await parseCodexCostJsonl(
      chunks(
        '{"type":"event_msg","timestamp":"2026-08-20T10:00:01Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":12,"output_tokens":6}}}}\n',
      ),
      { state: first.state, scan: { cursor: first.cursor } },
    );
    expect(second.rows).toHaveLength(1);
    expect(second.rows[0]?.tokens).toMatchObject({ input: 2, output: 1, reasoningOutput: 0 });
    expect(second.state.cumulativeCounterUnsafe).toBeUndefined();
    expect(second.state.totals?.reasoningOutput).toBeUndefined();
  });

  it("treats explicit reasoning decreases as regressions for stale detection", async () => {
    const first = await parseCodexCostJsonl(
      chunks(
        '{"type":"event_msg","timestamp":"2026-08-20T10:00:00Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":10,"output_tokens":5,"reasoning_output_tokens":30}}}}\n',
      ),
      { collectTotalsForForkBaseline: true, scan: {} },
    );
    expect(first.state.totals?.reasoningOutput).toBe(5);
    const second = await parseCodexCostJsonl(
      chunks(
        '{"type":"event_msg","timestamp":"2026-08-20T10:00:01Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":10,"output_tokens":5,"reasoning_output_tokens":2},"last_token_usage":{"input_tokens":5,"output_tokens":1,"reasoning_output_tokens":1}}}}\n',
      ),
      { state: first.state, collectTotalsForForkBaseline: true, scan: { cursor: first.cursor } },
    );
    expect(second.rows).toHaveLength(0);
    expect(second.state.cumulativeCounterUnsafe).toBeUndefined();
    expect(second.totalSnapshots).toHaveLength(1);
  });

  it("contains a major regression with missing or zero last", async () => {
    const first = await parseCodexCostJsonl(
      chunks(
        '{"type":"event_msg","timestamp":"2026-08-20T10:00:00Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"output_tokens":10}}}}\n',
      ),
      { scan: {} },
    );
    const missingLast = await parseCodexCostJsonl(
      chunks(
        '{"type":"event_msg","timestamp":"2026-08-20T10:00:01Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":4,"output_tokens":1}}}}\n',
      ),
      { state: first.state, scan: { cursor: first.cursor } },
    );
    expect(missingLast.rows).toHaveLength(0);
    expect(missingLast.state.cumulativeCounterUnsafe).toBeUndefined();
    expect(missingLast.state.sawInterleavedTotals).toBe(true);
    expect(missingLast.state.totals).toMatchObject({ input: 100, output: 10 });

    const first2 = await parseCodexCostJsonl(
      chunks(
        '{"type":"event_msg","timestamp":"2026-08-20T10:00:00Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"output_tokens":10}}}}\n',
      ),
      { scan: {} },
    );
    const zeroLast = await parseCodexCostJsonl(
      chunks(
        '{"type":"event_msg","timestamp":"2026-08-20T10:00:01Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":4,"output_tokens":1},"last_token_usage":{"input_tokens":0,"output_tokens":0}}}}\n',
      ),
      { state: first2.state, scan: { cursor: first2.cursor } },
    );
    expect(zeroLast.rows).toHaveLength(0);
    expect(zeroLast.state.cumulativeCounterUnsafe).toBeUndefined();
    expect(zeroLast.state.sawInterleavedTotals).toBe(true);
    expect(zeroLast.state.totals).toMatchObject({ input: 100, output: 10 });
  });

  it("preserves optional reasoning unknownness across incremental state", async () => {
    const explicit = await parseCodexCostJsonl(
      chunks(
        '{"type":"event_msg","timestamp":"2026-08-20T10:00:00Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":10,"output_tokens":4,"reasoning_output_tokens":2}}}}\n',
      ),
      { scan: {} },
    );
    expect(explicit.state.totals?.reasoningOutput).toBe(2);
    const omitted = await parseCodexCostJsonl(
      chunks(
        '{"type":"event_msg","timestamp":"2026-08-20T10:00:01Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":12,"output_tokens":5}}}}\n',
      ),
      { state: explicit.state, scan: { cursor: explicit.cursor } },
    );
    expect(omitted.state.totals?.reasoningOutput).toBeUndefined();
    expect(omitted.rows[0]?.tokens.reasoningOutput).toBe(0);
    const explicitZero = await parseCodexCostJsonl(
      chunks(
        '{"type":"event_msg","timestamp":"2026-08-20T10:00:02Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":14,"output_tokens":6,"reasoning_output_tokens":0}}}}\n',
      ),
      { state: omitted.state, scan: { cursor: omitted.cursor } },
    );
    expect(explicitZero.state.totals?.reasoningOutput).toBeUndefined();
    expect(explicitZero.rows[0]?.tokens).toMatchObject({ input: 2, output: 1, reasoningOutput: 0 });
  });
});

function tokens(
  input: number,
  cachedInput: number,
  cacheCreationInput: number,
  output: number,
): CostJsonlTokens {
  return { input, cachedInput, cacheCreationInput, output, reasoningOutput: 0 };
}

function codexTotal(input: number, output: number, reasoningOutput?: number): CodexJsonlTotals {
  return {
    input,
    cachedInput: 0,
    cacheCreationInput: 0,
    output,
    ...(reasoningOutput === undefined ? {} : { reasoningOutput }),
  };
}

function codexTokenCountLine(
  timestamp: string,
  usage: { readonly total?: CodexJsonlTotals; readonly last?: CodexJsonlTotals },
): string {
  const encode = (totals: CodexJsonlTotals): Record<string, number> => ({
    input_tokens: totals.input,
    cached_input_tokens: totals.cachedInput,
    cache_creation_input_tokens: totals.cacheCreationInput,
    output_tokens: totals.output,
    ...(totals.reasoningOutput === undefined
      ? {}
      : { reasoning_output_tokens: totals.reasoningOutput }),
  });
  return `${JSON.stringify({
    type: "event_msg",
    timestamp,
    payload: {
      type: "token_count",
      info: {
        model: "gpt-5.6-terra",
        ...(usage.total === undefined ? {} : { total_token_usage: encode(usage.total) }),
        ...(usage.last === undefined ? {} : { last_token_usage: encode(usage.last) }),
      },
    },
  })}\n`;
}
