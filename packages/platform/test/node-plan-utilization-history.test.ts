import { lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderInstanceId } from "@codexbar/contracts";
import {
  PlanUtilizationHistoryBuckets,
  PlanUtilizationHistoryEntry,
  PlanUtilizationSeriesHistory,
} from "@codexbar/core";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { makeNodePlanUtilizationHistoryStore } from "../src/node-plan-utilization-history.ts";

const providerId = "codex" as ProviderInstanceId;

const fixtureBuckets = (): PlanUtilizationHistoryBuckets =>
  new PlanUtilizationHistoryBuckets({
    preferredAccountKey: "work",
    accounts: {
      work: [
        new PlanUtilizationSeriesHistory({
          name: "weekly",
          windowMinutes: 10_080,
          entries: [
            new PlanUtilizationHistoryEntry({
              capturedAt: new Date("2026-08-21T12:34:56.789Z"),
              resetsAt: new Date("2026-08-28T12:00:00Z"),
              usedPercent: 42.5,
            }),
          ],
        }),
      ],
    },
    sessionEquivalentWindowPairIdentities: { work: "pair-v1" },
  });

describe("Node plan-utilization history store", () => {
  it("round-trips the Swift v1 document privately without rewriting identical bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexbar-plan-history-"));
    const path = join(directory, "codex.json");
    try {
      const store = makeNodePlanUtilizationHistoryStore({
        directoryPath: directory,
        knownProviderIds: [providerId],
      });
      await Effect.runPromise(store.save({ [providerId]: fixtureBuckets() }));
      const first = await stat(path, { bigint: true });
      const raw = await readFile(path, "utf8");
      expect(raw).toContain('"version":1');
      expect(raw).toContain('"capturedAt":"2026-08-21T12:34:56Z"');
      if (process.platform !== "win32") expect(Number(first.mode & 0o777n)).toBe(0o600);

      await Effect.runPromise(store.save({ [providerId]: fixtureBuckets() }));
      const second = await stat(path, { bigint: true });
      expect(second.ino).toBe(first.ino);
      expect(second.mtimeNs).toBe(first.mtimeNs);

      const loaded = await Effect.runPromise(store.load);
      expect(loaded[providerId]?.preferredAccountKey).toBe("work");
      expect(loaded[providerId]?.accounts.work?.[0]?.entries[0]?.usedPercent).toBe(42.5);
      expect(loaded[providerId]?.accounts.work?.[0]?.entries[0]?.capturedAt.toISOString()).toBe(
        "2026-08-21T12:34:56.000Z",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("removes empty known-provider history and preserves unrelated files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexbar-plan-history-empty-"));
    const path = join(directory, "codex.json");
    const unrelated = join(directory, "notes.txt");
    try {
      const store = makeNodePlanUtilizationHistoryStore({
        directoryPath: directory,
        knownProviderIds: [providerId],
      });
      await Effect.runPromise(store.save({ [providerId]: fixtureBuckets() }));
      await writeFile(unrelated, "keep\n");
      await Effect.runPromise(store.save({}));
      await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(unrelated, "utf8")).resolves.toBe("keep\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("skips malformed, unsupported, invalid UTF-8, oversized, and invalid-ID files independently", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexbar-plan-history-invalid-"));
    try {
      const writer = makeNodePlanUtilizationHistoryStore({
        directoryPath: directory,
        knownProviderIds: [],
      });
      await Effect.runPromise(writer.save({ [providerId]: fixtureBuckets() }));
      await writeFile(join(directory, "claude.json"), "{");
      await writeFile(
        join(directory, "t3chat.json"),
        JSON.stringify({ accounts: {}, unscoped: [], version: 2 }),
      );
      await writeFile(join(directory, "openai.json"), new Uint8Array([0xff, 0xfe]));
      await writeFile(join(directory, "xai.json"), "x".repeat(1025));
      await writeFile(join(directory, "INVALID.json"), "{}");

      const reader = makeNodePlanUtilizationHistoryStore({
        directoryPath: directory,
        knownProviderIds: [],
        maximumFileBytes: 1024,
      });
      const loaded = await Effect.runPromise(reader.load);
      expect(Object.keys(loaded)).toEqual(["codex"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("never follows a provider-file symlink", async () => {
    if (process.platform === "win32") return;
    const directory = await mkdtemp(join(tmpdir(), "codexbar-plan-history-symlink-"));
    const outside = join(directory, "outside-secret");
    try {
      await writeFile(outside, JSON.stringify({ accounts: {}, unscoped: [], version: 1 }));
      await symlink(outside, join(directory, "codex.json"));
      const store = makeNodePlanUtilizationHistoryStore({
        directoryPath: directory,
        knownProviderIds: [],
      });
      await expect(Effect.runPromise(store.load)).resolves.toEqual({});
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("atomically replaces a provider symlink without changing its target", async () => {
    if (process.platform === "win32") return;
    const directory = await mkdtemp(join(tmpdir(), "codexbar-plan-history-replace-symlink-"));
    const outside = join(directory, "outside-secret");
    const path = join(directory, "codex.json");
    try {
      await writeFile(outside, "outside must remain unchanged\n");
      await symlink(outside, path);
      const store = makeNodePlanUtilizationHistoryStore({
        directoryPath: directory,
        knownProviderIds: [providerId],
      });
      await Effect.runPromise(store.save({ [providerId]: fixtureBuckets() }));
      expect((await lstat(path)).isFile()).toBe(true);
      await expect(readFile(outside, "utf8")).resolves.toBe("outside must remain unchanged\n");
      expect(await readFile(path, "utf8")).toContain('"version":1');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed and keeps the prior file when private publication is rejected", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexbar-plan-history-acl-"));
    const path = join(directory, "codex.json");
    try {
      const original = new TextEncoder().encode(
        '{"accounts":{},"sessionEquivalentWindowPairIdentities":{"keep":"v1"},"unscoped":[],"version":1}',
      );
      await writeFile(path, original);
      const store = makeNodePlanUtilizationHistoryStore({
        directoryPath: directory,
        knownProviderIds: [providerId],
        restrictDirectory: async () => undefined,
        restrictFile: async () => {
          throw new Error("ACL unavailable");
        },
      });
      await Effect.runPromise(store.save({ [providerId]: fixtureBuckets() }));
      await expect(readFile(path)).resolves.toEqual(Buffer.from(original));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects invalid or expanding read bounds before filesystem access", () => {
    for (const maximumFileBytes of [0, -1, 1.5, 16 * 1024 * 1024 + 1]) {
      expect(() =>
        makeNodePlanUtilizationHistoryStore({
          directoryPath: "/not-accessed",
          maximumFileBytes,
        }),
      ).toThrow("maximumFileBytes");
    }
  });

  it("rejects forged known-provider IDs before constructing child paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "codexbar-plan-history-provider-id-"));
    const directory = join(root, "history");
    const outside = join(root, "escape.json");
    try {
      await writeFile(outside, "keep\n");
      const store = makeNodePlanUtilizationHistoryStore({
        directoryPath: directory,
        knownProviderIds: ["../escape" as ProviderInstanceId],
      });
      await Effect.runPromise(store.save({}));
      await expect(readFile(outside, "utf8")).resolves.toBe("keep\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
