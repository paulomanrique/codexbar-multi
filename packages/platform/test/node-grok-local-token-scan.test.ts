import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import type { DailyCostUsageReplacement } from "@codexbar/core";

import {
  NodeGrokLocalTokenScanCancelledError,
  makeNodeGrokLocalTokenScanner,
} from "../src/node-grok-local-token-scan.ts";

describe("Node Grok local token publisher", () => {
  it("publishes local tokens independently of Grok web billing with no dollar conversion", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexbar-grok-token-ledger-"));
    const root = join(directory, "sessions");
    const signalPath = join(root, "cwd", "session", "signals.json");
    const now = new Date("2026-08-20T12:00:00.000Z");
    const replacements: DailyCostUsageReplacement[] = [];
    try {
      await mkdir(join(root, "cwd", "session"), { recursive: true });
      await writeFile(signalPath, '{"totalTokensBeforeCompaction":100,"contextTokensUsed":25}');
      await utimes(signalPath, now, now);
      const scanner = makeNodeGrokLocalTokenScanner({
        costs: {
          replaceDaily: (replacement: DailyCostUsageReplacement) =>
            Effect.sync(() => {
              replacements.push(replacement);
            }),
        } as never,
        scan: { root },
        now: () => now,
      });

      await expect(scanner.refresh()).resolves.toEqual({
        availability: "available",
        coverage: "exact",
        scannedSessions: 1,
        publishedDays: 1,
      });
      expect(replacements).toEqual([
        expect.objectContaining({
          providerId: "grok",
          sourceKey: "local-session-tokens",
          availability: "available",
          records: [expect.objectContaining({ inputTokens: 125, outputTokens: 0, costUsd: 0 })],
        }),
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("marks unreadable or empty scans unavailable without overwriting retained rows", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexbar-grok-token-unavailable-"));
    const root = join(directory, "sessions");
    const replacements: DailyCostUsageReplacement[] = [];
    try {
      await mkdir(join(root, "cwd", "session"), { recursive: true });
      await writeFile(join(root, "cwd", "session", "signals.json"), "{}");
      const scanner = makeNodeGrokLocalTokenScanner({
        costs: {
          replaceDaily: (replacement: DailyCostUsageReplacement) =>
            Effect.sync(() => {
              replacements.push(replacement);
            }),
        } as never,
        scan: {
          root,
          beforeRead: () => {
            throw new Error("fixture unreadable");
          },
        },
        now: () => new Date("2026-08-20T12:00:00.000Z"),
      });

      await expect(scanner.refresh()).resolves.toMatchObject({ availability: "unavailable" });
      expect(replacements).toEqual([
        expect.objectContaining({ availability: "unavailable", records: [] }),
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("never writes an unavailable replacement after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const replacements: DailyCostUsageReplacement[] = [];
    const scanner = makeNodeGrokLocalTokenScanner({
      costs: {
        replaceDaily: (replacement: DailyCostUsageReplacement) =>
          Effect.sync(() => {
            replacements.push(replacement);
          }),
      } as never,
      scan: { root: "/not-read" },
      now: () => new Date("2026-08-20T12:00:00.000Z"),
    });
    await expect(scanner.refresh(controller.signal)).rejects.toBeInstanceOf(
      NodeGrokLocalTokenScanCancelledError,
    );
    expect(replacements).toEqual([]);
  });

  it("propagates a persistence failure without a second unavailable replacement", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexbar-grok-token-persistence-"));
    const root = join(directory, "sessions");
    const signalPath = join(root, "cwd", "session", "signals.json");
    let calls = 0;
    try {
      await mkdir(join(root, "cwd", "session"), { recursive: true });
      await writeFile(signalPath, '{"contextTokensUsed":1}');
      const scanner = makeNodeGrokLocalTokenScanner({
        costs: {
          replaceDaily: () =>
            Effect.sync(() => {
              calls += 1;
              throw new Error("fixture SQLite write failed");
            }),
        } as never,
        scan: { root },
        now: () => new Date("2026-08-20T12:00:00.000Z"),
      });
      await expect(scanner.refresh()).rejects.toThrow("fixture SQLite write failed");
      expect(calls).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
