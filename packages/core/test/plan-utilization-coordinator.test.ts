import type { ProviderInstanceId } from "@codexbar/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import {
  PlanUtilizationHistoryBuckets,
  PlanUtilizationHistoryCoordinator,
  PlanUtilizationHistoryEntry,
  PlanUtilizationSeriesHistory,
  type PlanUtilizationHistoryProviders,
  type PlanUtilizationHistoryRepository,
} from "../src/index.ts";

const providerId = "codex" as ProviderInstanceId;
const capturedAt = new Date("2026-08-21T12:05:00Z");

const sample = (usedPercent: number, minutesAfter = 0) => ({
  name: "session",
  windowMinutes: 300,
  entry: new PlanUtilizationHistoryEntry({
    capturedAt: new Date(capturedAt.getTime() + minutesAfter * 60 * 1_000),
    usedPercent,
  }),
});

const providersWith = (usedPercent: number): PlanUtilizationHistoryProviders => ({
  [providerId]: new PlanUtilizationHistoryBuckets({
    accounts: {
      work: [
        new PlanUtilizationSeriesHistory({
          name: "session",
          windowMinutes: 300,
          entries: [sample(usedPercent).entry],
        }),
      ],
    },
  }),
});

describe("plan-utilization history coordinator", () => {
  it("waits for startup load before recording and never overwrites persisted history", async () => {
    let releaseLoad!: () => void;
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    const saves: PlanUtilizationHistoryProviders[] = [];
    const repository: PlanUtilizationHistoryRepository = {
      load: Effect.promise(async () => {
        await loadGate;
        return providersWith(10);
      }),
      save: (providers) =>
        Effect.sync(() => {
          saves.push(providers);
        }),
    };
    const coordinator = new PlanUtilizationHistoryCoordinator(repository);
    const recording = Effect.runPromise(
      coordinator.record({ providerId, accountKey: "work", samples: [sample(35, 25)] }),
    );
    await Promise.resolve();
    expect(saves).toHaveLength(0);
    releaseLoad();
    await expect(recording).resolves.toBe(true);

    expect(saves).toHaveLength(1);
    expect(saves[0]?.[providerId]?.accounts.work?.[0]?.entries).toHaveLength(1);
    expect(saves[0]?.[providerId]?.accounts.work?.[0]?.entries[0]?.usedPercent).toBe(35);
  });

  it("serializes concurrent mutations and repository publications", async () => {
    let activeSaves = 0;
    let maximumActiveSaves = 0;
    const savedUsage: number[] = [];
    const repository: PlanUtilizationHistoryRepository = {
      load: Effect.succeed({}),
      save: (providers) =>
        Effect.promise(async () => {
          activeSaves += 1;
          maximumActiveSaves = Math.max(maximumActiveSaves, activeSaves);
          await new Promise((resolve) => setTimeout(resolve, 5));
          savedUsage.push(
            providers[providerId]?.unscoped.at(-1)?.entries.at(-1)?.usedPercent ?? -1,
          );
          activeSaves -= 1;
        }),
    };
    const coordinator = new PlanUtilizationHistoryCoordinator(repository);
    const changes = await Effect.runPromise(
      Effect.all(
        [
          coordinator.record({ providerId, samples: [sample(10)] }),
          coordinator.record({ providerId, samples: [sample(30, 25)] }),
          coordinator.record({ providerId, samples: [sample(50, 65)] }),
        ],
        { concurrency: "unbounded" },
      ),
    );
    expect(changes).toEqual([true, true, true]);
    expect(maximumActiveSaves).toBe(1);
    expect(savedUsage).toEqual([10, 30, 50]);
  });

  it("returns account-scoped selections and defensive snapshots", async () => {
    const loaded = providersWith(10);
    const coordinator = new PlanUtilizationHistoryCoordinator({
      load: Effect.succeed(loaded),
      save: () => Effect.void,
    });
    const first = await Effect.runPromise(coordinator.selection(providerId, "work"));
    expect(first.accountKey).toBe("work");
    expect(first.histories[0]?.entries[0]?.usedPercent).toBe(10);

    const externalEntry = loaded[providerId]!.accounts.work![0]!.entries[0]! as unknown as {
      usedPercent: number;
    };
    externalEntry.usedPercent = 99;
    (first.histories[0]!.entries[0]!.capturedAt as Date).setTime(0);
    const second = await Effect.runPromise(coordinator.selection(providerId, "work"));
    expect(second.histories[0]?.entries[0]?.usedPercent).toBe(10);
    expect(second.histories[0]?.entries[0]?.capturedAt.toISOString()).toBe(
      "2026-08-21T12:05:00.000Z",
    );
  });

  it("does not publish an unchanged sample", async () => {
    let saves = 0;
    const coordinator = new PlanUtilizationHistoryCoordinator({
      load: Effect.succeed(providersWith(10)),
      save: () =>
        Effect.sync(() => {
          saves += 1;
        }),
    });
    await expect(
      Effect.runPromise(
        coordinator.record({ providerId, accountKey: "work", samples: [sample(10)] }),
      ),
    ).resolves.toBe(false);
    expect(saves).toBe(0);
  });

  it("removes only the requested provider and persists the new namespace", async () => {
    const other = "claude" as ProviderInstanceId;
    let saved: PlanUtilizationHistoryProviders | undefined;
    const coordinator = new PlanUtilizationHistoryCoordinator({
      load: Effect.succeed({ ...providersWith(10), [other]: new PlanUtilizationHistoryBuckets() }),
      save: (providers) =>
        Effect.sync(() => {
          saved = providers;
        }),
    });
    await expect(Effect.runPromise(coordinator.removeProvider(providerId))).resolves.toBe(true);
    expect(saved?.[providerId]).toBeUndefined();
    expect(saved?.[other]).toBeDefined();
  });
});
