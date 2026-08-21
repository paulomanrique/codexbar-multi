import { appendFile, link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  scanNodeClaudeCostJsonl,
  scanNodeCodexCostJsonl,
  scanNodeCodexForkFamily,
  inventoryNodeCostJsonlFiles,
  CodexForkFamilyLimitError,
  CostJsonlSourceChangedError,
  CostJsonlInvalidSourceError,
} from "../src/node-cost-jsonl.ts";

describe("Node cost JSONL adapter", () => {
  it("inventories nested logs deterministically without following symlinks or duplicate identities", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexbar-cost-jsonl-inventory-"));
    const root = join(directory, "sessions");
    const nested = join(root, "legacy", "rollout");
    try {
      await mkdir(nested, { recursive: true });
      const first = join(root, "a.jsonl");
      const nestedLog = join(nested, "b.JSONL");
      await writeFile(first, "{}\n");
      await writeFile(nestedLog, "{}\n");
      await writeFile(join(root, "ignore.txt"), "{}\n");
      await link(first, join(root, "duplicate.jsonl"));
      await symlink(first, join(root, "linked.jsonl"));
      await symlink(join(root, "legacy"), join(root, "linked-directory"));

      const result = await inventoryNodeCostJsonlFiles({ roots: [root] });
      expect(result.files.map((file) => file.path)).toEqual([first, nestedLog]);
      expect(result.files[0]?.identity).toMatchObject({
        device: expect.any(String),
        inode: expect.any(String),
      });
      expect(result.truncated).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("bounds recursive inventory and rejects a symlink root", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexbar-cost-jsonl-inventory-bounds-"));
    const root = join(directory, "sessions");
    const alias = join(directory, "sessions-link");
    try {
      await mkdir(root);
      await writeFile(join(root, "a.jsonl"), "{}\n");
      await writeFile(join(root, "b.jsonl"), "{}\n");
      const result = await inventoryNodeCostJsonlFiles({ roots: [root], maxFiles: 1 });
      expect(result.files).toHaveLength(1);
      expect(result.truncated).toBe(true);

      await symlink(root, alias);
      await expect(inventoryNodeCostJsonlFiles({ roots: [alias] })).rejects.toBeInstanceOf(
        CostJsonlInvalidSourceError,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

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

  it("resolves a parent-present fork at its timestamp and bills only the child suffix", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexbar-cost-jsonl-family-"));
    const parent = join(directory, "parent.jsonl");
    const child = join(directory, "child.jsonl");
    try {
      await writeFile(
        parent,
        [
          '{"type":"session_meta","timestamp":"2030-01-01T12:00:00Z","payload":{"id":"parent"}}',
          '{"type":"event_msg","timestamp":"2030-01-01T12:00:00Z","payload":{"type":"token_count","info":{"model":"gpt-5.6-terra","total_token_usage":{"input_tokens":100,"output_tokens":10}}}}',
          '{"type":"event_msg","timestamp":"2030-01-01T12:01:00Z","payload":{"type":"token_count","info":{"model":"gpt-5.6-terra","total_token_usage":{"input_tokens":120,"output_tokens":12}}}}',
        ].join("\n") + "\n",
      );
      await writeFile(
        child,
        [
          '{"type":"session_meta","timestamp":"2030-01-01T12:00:30Z","payload":{"id":"child","forked_from_id":"parent","timestamp":"2030-01-01T12:00:30Z"}}',
          '{"type":"event_msg","timestamp":"2030-01-01T12:00:31Z","payload":{"type":"token_count","info":{"model":"gpt-5.6-terra","total_token_usage":{"input_tokens":10,"output_tokens":1}}}}',
          '{"type":"event_msg","timestamp":"2030-01-01T12:00:32Z","payload":{"type":"token_count","info":{"model":"gpt-5.6-terra","total_token_usage":{"input_tokens":100,"output_tokens":10}}}}',
          '{"type":"event_msg","timestamp":"2030-01-01T12:00:33Z","payload":{"type":"token_count","info":{"model":"gpt-5.6-terra","total_token_usage":{"input_tokens":105,"output_tokens":11}}}}',
        ].join("\n") + "\n",
      );
      const family = await scanNodeCodexForkFamily({
        sources: [{ path: child }, { path: parent }],
      });
      expect(family.hasUnresolvedLineage).toBe(false);
      const byPath = new Map(family.members.map((member) => [member.path, member]));
      expect(byPath.get(parent)?.scan?.result.rows.map((row) => row.tokens.input)).toEqual([
        100, 20,
      ]);
      expect(byPath.get(child)?.scan?.result.rows.map((row) => row.tokens.input)).toEqual([5]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("matches the Swift #2037 archived parent-present fixture's copied-prefix boundary", async () => {
    const fixture = join(
      import.meta.dirname,
      "../../..",
      "Tests/CodexBarTests/Fixtures/CostUsage/Issue2037/archived-fork-33ce-3869/codex-home/archived_sessions",
    );
    const parent = join(fixture, "parent.jsonl");
    const child = join(fixture, "child.jsonl");
    const naiveParent = await scanNodeCodexCostJsonl({ path: parent });
    const naiveChild = await scanNodeCodexCostJsonl({ path: child });
    const family = await scanNodeCodexForkFamily({ sources: [{ path: child }, { path: parent }] });
    const byPath = new Map(family.members.map((member) => [member.path, member]));
    expect(family.hasUnresolvedLineage).toBe(false);
    // The sanitized Swift oracle locks an ordered, copied 135-event child
    // prefix followed by 23 child-owned events. No token-value-only matching
    // occurs here: metadata ancestry + parent snapshot is the sole authority.
    expect(byPath.get(parent)?.scan?.result.rows).toHaveLength(naiveParent.result.rows.length);
    expect(byPath.get(child)?.scan?.result.rows).toHaveLength(
      naiveChild.result.rows.length - naiveParent.result.rows.length,
    );
    const units = (
      rows: readonly { readonly tokens: { input: number; cachedInput: number; output: number } }[],
    ) =>
      rows.reduce(
        (total, row) => total + row.tokens.input + row.tokens.cachedInput + row.tokens.output,
        0,
      );
    expect(
      units(byPath.get(parent)?.scan?.result.rows ?? []) +
        units(byPath.get(child)?.scan?.result.rows ?? []),
    ).toBe(units(naiveChild.result.rows));
  });

  it("fails closed for missing parents, invalid boundaries, and cycles instead of token-vector dedupe", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexbar-cost-jsonl-family-invalid-"));
    const missing = join(directory, "missing.jsonl");
    const first = join(directory, "first.jsonl");
    const second = join(directory, "second.jsonl");
    try {
      await writeFile(
        missing,
        '{"type":"session_meta","timestamp":"2030-01-01T12:00:00Z","payload":{"id":"missing-child","forked_from_id":"absent","timestamp":"2030-01-01T12:00:00Z"}}\n{"type":"event_msg","timestamp":"2030-01-01T12:00:01Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100}}}}\n',
      );
      const missingFamily = await scanNodeCodexForkFamily({ sources: [{ path: missing }] });
      expect(missingFamily.members[0]).toMatchObject({
        status: "unresolved",
        reason: "missing-parent",
      });
      expect(missingFamily.members[0]?.scan).toBeUndefined();

      await writeFile(
        first,
        '{"type":"session_meta","timestamp":"2030-01-01T12:00:00Z","payload":{"id":"first","forked_from_id":"second","timestamp":"2030-01-01T12:00:00Z"}}\n',
      );
      await writeFile(
        second,
        '{"type":"session_meta","timestamp":"2030-01-01T12:00:00Z","payload":{"id":"second","forked_from_id":"first","timestamp":"2030-01-01T12:00:00Z"}}\n',
      );
      const cycle = await scanNodeCodexForkFamily({ sources: [{ path: first }, { path: second }] });
      expect(cycle.members).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: first, status: "unresolved", reason: "cycle" }),
          expect.objectContaining({ path: second, status: "unresolved", reason: "cycle" }),
        ]),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not infer lineage from a byte-bounded parent scan", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexbar-cost-jsonl-family-bounded-"));
    const parent = join(directory, "parent.jsonl");
    const child = join(directory, "child.jsonl");
    try {
      await writeFile(
        parent,
        '{"type":"session_meta","timestamp":"2030-01-01T12:00:00Z","payload":{"id":"parent"}}\n{"type":"event_msg","timestamp":"2030-01-01T12:00:00Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100}}}}\n',
      );
      await writeFile(
        child,
        '{"type":"session_meta","timestamp":"2030-01-01T12:00:01Z","payload":{"id":"child","forked_from_id":"parent","timestamp":"2030-01-01T12:00:01Z"}}\n{"type":"event_msg","timestamp":"2030-01-01T12:00:02Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":110}}}}\n',
      );
      const family = await scanNodeCodexForkFamily({
        sources: [{ path: parent }, { path: child }],
        maxBytes: 1,
      });
      expect(family.members).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: parent,
            status: "unresolved",
            reason: "source-incomplete",
          }),
          expect.objectContaining({
            path: child,
            status: "unresolved",
            reason: "source-incomplete",
          }),
        ]),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses its 16 MiB default byte ceiling and leaves an oversized family member unresolved", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexbar-cost-jsonl-family-default-limit-"));
    const path = join(directory, "oversized.jsonl");
    try {
      await writeFile(
        path,
        '{"type":"session_meta","timestamp":"2030-01-01T12:00:00Z","payload":{"id":"oversized"}}\n' +
          "x".repeat(16 * 1024 * 1024),
      );
      const family = await scanNodeCodexForkFamily({ sources: [{ path }] });
      expect(family.members).toEqual([
        expect.objectContaining({
          path: resolve(path),
          status: "unresolved",
          reason: "source-incomplete",
        }),
      ]);
      expect(family.hasUnresolvedLineage).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("normalizes aliases and rejects family plan bounds before opening an overflow source list", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexbar-cost-jsonl-family-plan-"));
    const path = join(directory, "session.jsonl");
    try {
      await writeFile(
        path,
        '{"type":"session_meta","timestamp":"2030-01-01T12:00:00Z","payload":{"id":"session"}}\n',
      );
      const aliases = await scanNodeCodexForkFamily({
        sources: [{ path }, { path: `${directory}/./session.jsonl` }],
      });
      expect(aliases.members).toHaveLength(1);
      expect(aliases.members[0]?.path).toBe(resolve(path));

      await expect(
        scanNodeCodexForkFamily({
          sources: [{ path }, { path: join(directory, "not-opened.jsonl") }],
          maxSources: 1,
        }),
      ).rejects.toBeInstanceOf(CodexForkFamilyLimitError);
      await expect(scanNodeCodexForkFamily({ sources: [], maxBytes: 0 })).rejects.toBeInstanceOf(
        CodexForkFamilyLimitError,
      );
      await expect(
        scanNodeCodexForkFamily({ sources: [], maxLineBytes: 512 * 1024 + 1 }),
      ).rejects.toBeInstanceOf(CodexForkFamilyLimitError);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
