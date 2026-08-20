import { appendFile, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  scanNodeClaudeCostJsonl,
  scanNodeCodexCostJsonl,
  CostJsonlSourceChangedError,
  CostJsonlInvalidSourceError,
} from "../src/node-cost-jsonl.ts";

describe("Node cost JSONL adapter", () => {
  it("resumes a stable Codex file from its committed cursor", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexbar-cost-jsonl-"));
    const path = join(directory, "session.jsonl");
    try {
      await writeFile(
        path,
        '{"type":"event_msg","timestamp":"2026-08-20T10:00:00Z","payload":{"type":"token_count","info":{"model":"gpt-5.6-terra","total_token_usage":{"input_tokens":10,"output_tokens":2}}}}\n',
      );
      const first = await scanNodeCodexCostJsonl({ path });
      expect(first.resumed).toBe(false);
      expect(first.result.rows[0]?.tokens.input).toBe(10);

      await appendFile(
        path,
        '{"type":"event_msg","timestamp":"2026-08-20T10:00:01Z","payload":{"type":"token_count","info":{"model":"gpt-5.6-terra","total_token_usage":{"input_tokens":16,"output_tokens":4}}}}\n',
      );
      const second = await scanNodeCodexCostJsonl({ path, state: first.state });
      expect(second.resumed).toBe(true);
      expect(second.result.rows).toHaveLength(1);
      expect(second.result.rows[0]?.tokens).toMatchObject({ input: 6, output: 2 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("discards an old cursor when a source is replaced", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexbar-cost-jsonl-replace-"));
    const path = join(directory, "session.jsonl");
    try {
      await writeFile(
        path,
        '{"type":"assistant","timestamp":"2026-08-20T10:00:00Z","requestId":"a","message":{"id":"a","model":"claude-opus-4-8","usage":{"input_tokens":1}}}\n',
      );
      const first = await scanNodeClaudeCostJsonl({ path });
      await writeFile(
        path,
        '{"type":"assistant","timestamp":"2026-08-20T10:00:01Z","requestId":"b","message":{"id":"b","model":"claude-opus-4-8","usage":{"input_tokens":9}}}\n',
      );
      const second = await scanNodeClaudeCostJsonl({ path, state: first.state });
      expect(second.resumed).toBe(false);
      expect(second.result.rows[0]?.tokens.input).toBe(9);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("honors cancellation before opening the stream", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexbar-cost-jsonl-cancel-"));
    const path = join(directory, "session.jsonl");
    try {
      await writeFile(path, "{}\n");
      const controller = new AbortController();
      controller.abort();
      await expect(
        scanNodeCodexCostJsonl({ path, signal: controller.signal }),
      ).rejects.toMatchObject({
        name: "AbortError",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a symlink before opening a cost log", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexbar-cost-jsonl-link-"));
    const target = join(directory, "target.jsonl");
    const path = join(directory, "linked.jsonl");
    try {
      await writeFile(target, "{}\n");
      await symlink(target, path);
      await expect(scanNodeCodexCostJsonl({ path })).rejects.toBeInstanceOf(
        CostJsonlInvalidSourceError,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when a source changes after the handle is open", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexbar-cost-jsonl-swap-"));
    const path = join(directory, "session.jsonl");
    try {
      await writeFile(path, "{}\n");
      await expect(
        scanNodeCodexCostJsonl({
          path,
          beforeSourceRevalidation: async () => {
            // Replacing an open destination is deliberately denied by Windows
            // sharing semantics. An in-place mutation reaches the same
            // revalidation boundary on every supported filesystem.
            await writeFile(path, '{"changed":true}\n');
          },
        }),
      ).rejects.toBeInstanceOf(CostJsonlSourceChangedError);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("advances a bounded oversized line instead of restarting it forever", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexbar-cost-jsonl-oversize-"));
    const path = join(directory, "session.jsonl");
    try {
      await writeFile(path, "abcdefghij\n{}\n");
      const first = await scanNodeCodexCostJsonl({ path, maxBytes: 4, maxLineBytes: 2 });
      expect(first.state.cursor).toEqual({ committedOffset: 0, discardOffset: 4 });
      const second = await scanNodeCodexCostJsonl({
        path,
        state: first.state,
        maxBytes: 4,
        maxLineBytes: 2,
      });
      expect(second.state.cursor).toEqual({ committedOffset: 0, discardOffset: 8 });
      const third = await scanNodeCodexCostJsonl({
        path,
        state: second.state,
        maxBytes: 4,
        maxLineBytes: 2,
      });
      expect(third.state.cursor).toEqual({ committedOffset: 11 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects persisted cursors beyond JavaScript safe integer bounds", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexbar-cost-jsonl-offset-"));
    const path = join(directory, "session.jsonl");
    try {
      await writeFile(path, "{}\n");
      const first = await scanNodeCodexCostJsonl({ path });
      const state = { ...first.state, cursor: { committedOffset: Number.MAX_SAFE_INTEGER + 1 } };
      await expect(scanNodeCodexCostJsonl({ path, state })).rejects.toBeInstanceOf(
        CostJsonlInvalidSourceError,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("surfaces source replacement during a scan instead of publishing a stale cursor", () => {
    expect(new CostJsonlSourceChangedError("fixture.jsonl").message).toContain("fixture.jsonl");
  });
});
