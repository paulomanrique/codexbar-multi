import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import type { ProviderId } from "@codexbar/contracts";
import {
  LocalCostRefreshCancelledError,
  makeNodeLocalCostUsageScanner,
  makeNodeSqlitePersistence,
} from "../src/node.ts";

const firstCodexEvent = (
  input: number,
  output: number,
  timestamp = "2026-08-20T10:00:00Z",
): string =>
  `${JSON.stringify({
    type: "event_msg",
    timestamp,
    payload: {
      type: "token_count",
      info: {
        model: "gpt-5.6-terra",
        total_token_usage: { input_tokens: input, output_tokens: output },
      },
    },
  })}\n`;

const withPersistence = async (
  name: string,
  action: (options: {
    readonly directory: string;
    readonly sessions: string;
    readonly databasePath: string;
  }) => Promise<void>,
): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), `codexbar-${name}-`));
  const sessions = join(directory, "sessions");
  try {
    await mkdir(sessions);
    await action({ directory, sessions, databasePath: join(directory, "usage.sqlite") });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

describe("Node local cost scanner", () => {
  it("commits a Codex tail incrementally without replaying its initial totals", async () => {
    await withPersistence("local-cost-tail", async ({ sessions, databasePath }) => {
      const path = join(sessions, "rollout.jsonl");
      await writeFile(path, firstCodexEvent(10, 2));
      const persistence = await Effect.runPromise(makeNodeSqlitePersistence({ databasePath }));
      try {
        const scanner = makeNodeLocalCostUsageScanner({
          costs: persistence.costs,
          roots: { codex: [sessions] },
        });
        await scanner.refresh("codex");
        await appendFile(path, firstCodexEvent(16, 4, "2026-08-20T10:00:01Z"));
        await scanner.refresh("codex");
        await expect(Effect.runPromise(persistence.costs.list("codex", 0))).resolves.toMatchObject([
          { inputTokens: 10, outputTokens: 2 },
          { inputTokens: 6, outputTokens: 2 },
        ]);
      } finally {
        await Effect.runPromise(persistence.close);
      }
    });
  });

  it("uses a stable opaque source key to replace only a swapped path's old rows", async () => {
    await withPersistence("local-cost-replace", async ({ sessions, databasePath }) => {
      const path = join(sessions, "rollout.jsonl");
      const replacement = join(sessions, "replacement.jsonl");
      await writeFile(path, firstCodexEvent(10, 2));
      const persistence = await Effect.runPromise(makeNodeSqlitePersistence({ databasePath }));
      try {
        const scanner = makeNodeLocalCostUsageScanner({
          costs: persistence.costs,
          roots: { codex: [sessions] },
        });
        await scanner.refresh("codex");
        await writeFile(replacement, firstCodexEvent(9, 1, "2026-08-20T11:00:00Z"));
        await rename(replacement, path);
        await scanner.refresh("codex");
        await expect(Effect.runPromise(persistence.costs.list("codex", 0))).resolves.toMatchObject([
          { inputTokens: 9, outputTokens: 1 },
        ]);
      } finally {
        await Effect.runPromise(persistence.close);
      }
    });
  });

  it("retries a real SQLite checkpoint race and publishes the source only once", async () => {
    await withPersistence("local-cost-cas", async ({ sessions, databasePath }) => {
      await writeFile(join(sessions, "rollout.jsonl"), firstCodexEvent(10, 2));
      const first = await Effect.runPromise(makeNodeSqlitePersistence({ databasePath }));
      const second = await Effect.runPromise(makeNodeSqlitePersistence({ databasePath }));
      try {
        const roots = { codex: [sessions] };
        let initialReads = 0;
        let releaseInitialReads!: () => void;
        const initialReadsReady = new Promise<void>((resolve) => {
          releaseInitialReads = resolve;
        });
        const withInitialCheckpointBarrier = (costs: typeof first.costs) => ({
          ...costs,
          localScanCheckpoint: (providerId: ProviderId, sourceKey: string) =>
            Effect.promise(async () => {
              const checkpoint = await Effect.runPromise(
                costs.localScanCheckpoint(providerId, sourceKey),
              );
              initialReads += 1;
              if (initialReads === 2) releaseInitialReads();
              if (initialReads <= 2) await initialReadsReady;
              return checkpoint;
            }),
        });
        const results = await Promise.all([
          makeNodeLocalCostUsageScanner({
            costs: withInitialCheckpointBarrier(first.costs),
            roots,
          }).refresh("codex"),
          makeNodeLocalCostUsageScanner({
            costs: withInitialCheckpointBarrier(second.costs),
            roots,
          }).refresh("codex"),
        ]);
        expect(results.some((result) => result.retries === 1)).toBe(true);
        await expect(Effect.runPromise(first.costs.list("codex", 0))).resolves.toHaveLength(1);
      } finally {
        await Effect.runPromise(first.close);
        await Effect.runPromise(second.close);
      }
    });
  });

  it("cancels before inventory without a checkpoint or local row", async () => {
    await withPersistence("local-cost-cancel", async ({ sessions, databasePath }) => {
      await writeFile(join(sessions, "rollout.jsonl"), firstCodexEvent(10, 2));
      const persistence = await Effect.runPromise(makeNodeSqlitePersistence({ databasePath }));
      try {
        const controller = new AbortController();
        controller.abort();
        await expect(
          makeNodeLocalCostUsageScanner({
            costs: persistence.costs,
            roots: { codex: [sessions] },
          }).refresh("codex", controller.signal),
        ).rejects.toBeInstanceOf(LocalCostRefreshCancelledError);
        await expect(Effect.runPromise(persistence.costs.list("codex", 0))).resolves.toEqual([]);
      } finally {
        await Effect.runPromise(persistence.close);
      }
    });
  });

  it("does not convert an unpriced local model into a false zero-dollar row", async () => {
    await withPersistence("local-cost-unpriced", async ({ sessions, databasePath }) => {
      await writeFile(
        join(sessions, "rollout.jsonl"),
        firstCodexEvent(10, 2).replace("gpt-5.6-terra", "unknown-local-model"),
      );
      const persistence = await Effect.runPromise(makeNodeSqlitePersistence({ databasePath }));
      try {
        await makeNodeLocalCostUsageScanner({
          costs: persistence.costs,
          roots: { codex: [sessions] },
        }).refresh("codex");
        await expect(Effect.runPromise(persistence.costs.list("codex", 0))).resolves.toEqual([]);
      } finally {
        await Effect.runPromise(persistence.close);
      }
    });
  });

  it("marks a byte-bounded source as incomplete instead of claiming a full refresh", async () => {
    await withPersistence("local-cost-bounded", async ({ sessions, databasePath }) => {
      await writeFile(join(sessions, "rollout.jsonl"), firstCodexEvent(10, 2));
      const persistence = await Effect.runPromise(makeNodeSqlitePersistence({ databasePath }));
      try {
        const result = await makeNodeLocalCostUsageScanner({
          costs: persistence.costs,
          roots: { codex: [sessions] },
          maxSourceBytes: 1,
        }).refresh("codex");
        expect(result.incomplete).toBe(true);
        expect(result.inventoryTruncated).toBe(false);
        await expect(Effect.runPromise(persistence.costs.list("codex", 0))).resolves.toEqual([]);
      } finally {
        await Effect.runPromise(persistence.close);
      }
    });
  });

  it("keeps an unterminated JSONL tail pending and marks the source incomplete", async () => {
    await withPersistence("local-cost-tail-pending", async ({ sessions, databasePath }) => {
      await writeFile(join(sessions, "rollout.jsonl"), firstCodexEvent(10, 2).slice(0, -3));
      const persistence = await Effect.runPromise(makeNodeSqlitePersistence({ databasePath }));
      try {
        const result = await makeNodeLocalCostUsageScanner({
          costs: persistence.costs,
          roots: { codex: [sessions] },
        }).refresh("codex");
        expect(result.incomplete).toBe(true);
        await expect(Effect.runPromise(persistence.costs.list("codex", 0))).resolves.toEqual([]);
      } finally {
        await Effect.runPromise(persistence.close);
      }
    });
  });
});
