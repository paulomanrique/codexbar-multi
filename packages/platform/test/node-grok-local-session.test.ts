import { mkdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vite-plus/test";

import {
  NodeGrokLocalSessionScanCancelledError,
  grokLocalSessionLookbackCutoff,
  resolveNodeGrokLocalSessionRoot,
  scanNodeGrokLocalSessions,
} from "../src/node-grok-local-session.ts";

describe("Node Grok local session scanner", () => {
  it("reads only recent bounded signals below the expected two-level layout", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexbar-grok-sessions-"));
    const root = join(directory, "sessions");
    const recent = join(root, "cwd", "recent", "signals.json");
    const old = join(root, "cwd", "old", "signals.json");
    try {
      await mkdir(join(root, "cwd", "recent"), { recursive: true });
      await mkdir(join(root, "cwd", "old"), { recursive: true });
      await writeFile(recent, '{"contextTokensUsed":8}');
      await writeFile(old, '{"contextTokensUsed":99}');
      await utimes(recent, new Date("2026-08-19T00:00:00Z"), new Date("2026-08-19T00:00:00Z"));
      await utimes(old, new Date("2026-07-01T00:00:00Z"), new Date("2026-07-01T00:00:00Z"));
      const result = await scanNodeGrokLocalSessions({
        root,
        now: new Date("2026-08-20T00:00:00Z"),
      });
      expect(result).toMatchObject({
        truncated: false,
        signals: [{ json: { contextTokensUsed: 8 } }],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("skips symlinks and malformed files while reporting size/file bounds", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexbar-grok-session-bounds-"));
    const root = join(directory, "sessions");
    try {
      await mkdir(join(root, "a", "one"), { recursive: true });
      await mkdir(join(root, "b", "two"), { recursive: true });
      await writeFile(join(root, "a", "one", "signals.json"), "not json");
      await writeFile(join(root, "b", "two", "signals.json"), "{}".repeat(200));
      await mkdir(join(root, "c", "three"), { recursive: true });
      await symlink(
        join(root, "a", "one", "signals.json"),
        join(root, "c", "three", "signals.json"),
      );
      const result = await scanNodeGrokLocalSessions({ root, maxFileBytes: 16, maxFiles: 1 });
      expect(result).toEqual({ signals: [], truncated: true });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("honors cancellation before traversing and resolves GROK_HOME without reading it", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      scanNodeGrokLocalSessions({ root: "/no-probe", signal: controller.signal }),
    ).rejects.toBeInstanceOf(NodeGrokLocalSessionScanCancelledError);
    expect(
      resolveNodeGrokLocalSessionRoot({ GROK_HOME: " ~/grok-profile " }, "/home/fixture", "linux"),
    ).toBe("/home/fixture/grok-profile/sessions");
  });

  it("uses local-calendar days for the cutoff and rejects growth or a swapped source", async () => {
    const now = new Date(2026, 2, 10, 12, 0, 0);
    const expected = new Date(now.getTime());
    expected.setDate(expected.getDate() - 1);
    expect(grokLocalSessionLookbackCutoff(now, 1)).toEqual(expected);

    const directory = await mkdtemp(join(tmpdir(), "codexbar-grok-session-race-"));
    const root = join(directory, "sessions");
    const path = join(root, "cwd", "session", "signals.json");
    const replacement = join(directory, "replacement.json");
    try {
      await mkdir(join(root, "cwd", "session"), { recursive: true });
      await writeFile(path, "{}");
      const grown = await scanNodeGrokLocalSessions({
        root,
        maxFileBytes: 16,
        beforeRead: async () => writeFile(path, "x".repeat(17)),
      });
      expect(grown).toEqual({ signals: [], truncated: true });

      await writeFile(path, "{}");
      await writeFile(replacement, '{"replacement":true}');
      const swapped = await scanNodeGrokLocalSessions({
        root,
        beforeRead: async () => {
          await rm(path);
          await symlink(replacement, path);
        },
      });
      expect(swapped).toEqual({ signals: [], truncated: false });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
