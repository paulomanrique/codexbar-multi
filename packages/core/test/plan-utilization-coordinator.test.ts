import type { ProviderInstanceId, UsageSnapshot } from "@codexbar/contracts";
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

const usageSnapshot = (overrides: Partial<UsageSnapshot> = {}): UsageSnapshot => ({
  details: [],
  updatedAt: capturedAt.toISOString(),
  ...overrides,
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

  it("reconciles and records an OpenCode Go session-equivalent pair atomically", async () => {
    let saved: PlanUtilizationHistoryProviders | undefined;
    const coordinator = new PlanUtilizationHistoryCoordinator({
      load: Effect.succeed({}),
      save: (providers) =>
        Effect.sync(() => {
          saved = providers;
        }),
    });
    await expect(
      Effect.runPromise(
        coordinator.recordGenericSessionEquivalent({
          providerId: "opencodego",
          capturedAt,
          snapshot: usageSnapshot({
            primary: { usedPercent: 15, windowMinutes: 300 },
            secondary: { usedPercent: 45, windowMinutes: 10_080 },
            tertiary: { usedPercent: 75, windowMinutes: 43_200 },
          }),
        }),
      ),
    ).resolves.toBe(true);

    expect(saved?.opencodego?.unscoped.map((history) => history.name.rawValue)).toEqual([
      "session",
      "weekly",
      "monthly",
    ]);
    expect(saved?.opencodego?.sessionEquivalentWindowPairIdentities).toEqual({
      __codexbar_unscoped__: "16#standard:primary18#standard:secondary",
    });
  });

  it("removes only the generic lane whose source identity changed", async () => {
    const initial = new PlanUtilizationHistoryBuckets({
      unscoped: [
        new PlanUtilizationSeriesHistory({
          name: "session",
          windowMinutes: 300,
          entries: [sample(10).entry],
        }),
        new PlanUtilizationSeriesHistory({
          name: "weekly",
          windowMinutes: 10_080,
          entries: [sample(20).entry],
        }),
      ],
      sessionEquivalentWindowPairIdentities: {
        __codexbar_unscoped__: "16#standard:primary18#standard:secondary",
      },
    });
    let saved: PlanUtilizationHistoryProviders | undefined;
    const coordinator = new PlanUtilizationHistoryCoordinator({
      load: Effect.succeed({ zai: initial }),
      save: (providers) =>
        Effect.sync(() => {
          saved = providers;
        }),
    });
    await Effect.runPromise(
      coordinator.recordGenericSessionEquivalent({
        providerId: "zai",
        capturedAt: new Date("2026-08-21T13:05:00Z"),
        snapshot: usageSnapshot({
          secondary: { usedPercent: 25, windowMinutes: 10_080 },
          tertiary: { usedPercent: 35, windowMinutes: 300 },
        }),
      }),
    );

    expect(saved?.zai?.unscoped.map((history) => history.name.rawValue)).toEqual([
      "session",
      "weekly",
    ]);
    expect(saved?.zai?.unscoped[0]?.entries).toHaveLength(1);
    expect(saved?.zai?.unscoped[0]?.entries[0]?.usedPercent).toBe(35);
    expect(saved?.zai?.unscoped[1]?.entries.at(-1)?.usedPercent).toBe(25);
  });

  it("persists the stable weekly lane while a generic pair is incomplete", async () => {
    let saved: PlanUtilizationHistoryProviders | undefined;
    const coordinator = new PlanUtilizationHistoryCoordinator({
      load: Effect.succeed({}),
      save: (providers) =>
        Effect.sync(() => {
          saved = providers;
        }),
    });
    await Effect.runPromise(
      coordinator.recordGenericSessionEquivalent({
        providerId: "zai",
        capturedAt,
        snapshot: usageSnapshot({
          secondary: { usedPercent: 25, windowMinutes: 10_080 },
        }),
      }),
    );

    expect(saved?.zai?.unscoped.map((history) => history.name.rawValue)).toEqual(["weekly"]);
    expect(saved?.zai?.sessionEquivalentWindowPairIdentities).toEqual({
      __codexbar_unscoped__: "14#__unresolved__18#standard:secondary",
    });
  });

  it("rejects providers with dedicated ownership rules without loading or saving", async () => {
    let loads = 0;
    let saves = 0;
    const coordinator = new PlanUtilizationHistoryCoordinator({
      load: Effect.sync(() => {
        loads += 1;
        return {};
      }),
      save: () =>
        Effect.sync(() => {
          saves += 1;
        }),
    });
    const snapshot = usageSnapshot({
      primary: { usedPercent: 10, windowMinutes: 300 },
      secondary: { usedPercent: 20, windowMinutes: 10_080 },
    });
    for (const dedicated of ["codex", "claude", "antigravity"] as const) {
      await expect(
        Effect.runPromise(
          coordinator.recordGenericSessionEquivalent({
            providerId: dedicated,
            snapshot,
            capturedAt,
          }),
        ),
      ).resolves.toBe(false);
    }
    expect(loads).toBe(0);
    expect(saves).toBe(0);
  });

  it("records Codex under provider-account ownership and prefers it over email", async () => {
    let saved: PlanUtilizationHistoryProviders | undefined;
    const coordinator = new PlanUtilizationHistoryCoordinator({
      load: Effect.succeed({}),
      save: (providers) =>
        Effect.sync(() => {
          saved = providers;
        }),
    });
    await expect(
      Effect.runPromise(
        coordinator.recordCodex({
          capturedAt,
          snapshot: usageSnapshot({
            primary: { usedPercent: 10, windowMinutes: 300 },
            secondary: { usedPercent: 20, windowMinutes: 10_080 },
            identity: {
              providerId: "codex",
              accountId: " acct-123 ",
              accountEmail: "owner@example.com",
            },
          }),
        }),
      ),
    ).resolves.toBe(true);

    const key = "codex:v1:provider-account:acct-123";
    expect(saved?.codex?.preferredAccountKey).toBe(key);
    expect(saved?.codex?.accounts[key]?.map((history) => history.name.rawValue)).toEqual([
      "session",
      "weekly",
    ]);
    expect(saved?.codex?.unscoped).toEqual([]);
  });

  it("uses canonical email ownership for partial Codex identity", async () => {
    let saved: PlanUtilizationHistoryProviders | undefined;
    const coordinator = new PlanUtilizationHistoryCoordinator({
      load: Effect.succeed({}),
      save: (providers) =>
        Effect.sync(() => {
          saved = providers;
        }),
    });
    await Effect.runPromise(
      coordinator.recordCodex({
        capturedAt,
        snapshot: usageSnapshot({
          primary: { usedPercent: 10, windowMinutes: 300 },
          identity: { providerId: "codex", accountEmail: " USER@EXAMPLE.COM " },
        }),
      }),
    );
    expect(saved?.codex?.preferredAccountKey).toBe(
      "codex:v1:email-hash:b4c9a289323b21a01c3e940f150eb9b8c542587f1abfd8f0e1cc1ffc5e475514",
    );
  });

  it("fails closed for missing, mismatched, or ownerless Codex identity", async () => {
    let loads = 0;
    let saves = 0;
    const coordinator = new PlanUtilizationHistoryCoordinator({
      load: Effect.sync(() => {
        loads += 1;
        return {};
      }),
      save: () =>
        Effect.sync(() => {
          saves += 1;
        }),
    });
    for (const identity of [
      undefined,
      { providerId: "claude" as const },
      { providerId: "codex" as const },
    ]) {
      await expect(
        Effect.runPromise(
          coordinator.recordCodex({
            capturedAt,
            snapshot: usageSnapshot({
              primary: { usedPercent: 10, windowMinutes: 300 },
              ...(identity === undefined ? {} : { identity }),
            }),
          }),
        ),
      ).resolves.toBe(false);
    }
    expect(loads).toBe(0);
    expect(saves).toBe(0);
  });

  it("records Claude under a discriminated identity owner", async () => {
    let saved: PlanUtilizationHistoryProviders | undefined;
    const coordinator = new PlanUtilizationHistoryCoordinator({
      load: Effect.succeed({}),
      save: (providers) =>
        Effect.sync(() => {
          saved = providers;
        }),
    });
    await expect(
      Effect.runPromise(
        coordinator.recordClaudeIdentity({
          capturedAt,
          snapshot: usageSnapshot({
            primary: { usedPercent: 10, windowMinutes: 300 },
            secondary: { usedPercent: 20, windowMinutes: 10_080 },
            tertiary: { usedPercent: 30, windowMinutes: 43_200 },
            identity: {
              providerId: "claude",
              accountEmail: " Person@Example.com ",
              accountOrganization: "Team Org",
              loginMethod: "Claude Team",
            },
          }),
        }),
      ),
    ).resolves.toBe(true);

    const key = "21500b7561865f727d6ebb856154a26a8a3293af12e7f0271a0f1336d92ea351";
    expect(saved?.claude?.preferredAccountKey).toBe(key);
    expect(saved?.claude?.accounts[key]?.map((history) => history.name.rawValue)).toEqual([
      "session",
      "weekly",
      "opus",
    ]);
    expect(saved?.claude?.unscoped).toEqual([]);
  });

  it("materializes legacy Claude email history into a new discriminator", async () => {
    const legacyKey = "3c6300d22ba3ba6a16b29f2642fb28a9e0e76c74c3748fa6cadc10cc126ef5ca";
    const weekly = new PlanUtilizationSeriesHistory({
      name: "weekly",
      windowMinutes: 10_080,
      entries: [sample(42).entry],
    });
    let saved: PlanUtilizationHistoryProviders | undefined;
    const coordinator = new PlanUtilizationHistoryCoordinator({
      load: Effect.succeed({
        claude: new PlanUtilizationHistoryBuckets({
          preferredAccountKey: legacyKey,
          accounts: { [legacyKey]: [weekly] },
        }),
      }),
      save: (providers) =>
        Effect.sync(() => {
          saved = providers;
        }),
    });
    await Effect.runPromise(
      coordinator.recordClaudeIdentity({
        capturedAt: new Date("2026-08-21T13:05:00Z"),
        snapshot: usageSnapshot({
          secondary: { usedPercent: 55, windowMinutes: 10_080 },
          identity: {
            providerId: "claude",
            accountEmail: "person@example.com",
            accountOrganization: "Team Org",
            loginMethod: "Claude Team",
          },
        }),
      }),
    );

    const accountKey = "21500b7561865f727d6ebb856154a26a8a3293af12e7f0271a0f1336d92ea351";
    expect(saved?.claude?.accounts[legacyKey]).toBeUndefined();
    expect(saved?.claude?.preferredAccountKey).toBe(accountKey);
    expect(
      saved?.claude?.accounts[accountKey]?.[0]?.entries.map((entry) => entry.usedPercent),
    ).toEqual([42, 55]);
  });

  it("adopts unscoped Claude history only before scoped ownership exists", async () => {
    const unscopedWeekly = new PlanUtilizationSeriesHistory({
      name: "weekly",
      windowMinutes: 10_080,
      entries: [sample(12).entry],
    });
    const existingKey = "existing";
    let saved: PlanUtilizationHistoryProviders | undefined;
    const coordinator = new PlanUtilizationHistoryCoordinator({
      load: Effect.succeed({
        claude: new PlanUtilizationHistoryBuckets({
          unscoped: [unscopedWeekly],
          accounts: {
            [existingKey]: [
              new PlanUtilizationSeriesHistory({
                name: "weekly",
                windowMinutes: 10_080,
                entries: [sample(99).entry],
              }),
            ],
          },
        }),
      }),
      save: (providers) =>
        Effect.sync(() => {
          saved = providers;
        }),
    });
    await Effect.runPromise(
      coordinator.recordClaudeIdentity({
        capturedAt,
        snapshot: usageSnapshot({
          primary: { usedPercent: 10, windowMinutes: 300 },
          identity: {
            providerId: "claude",
            accountEmail: "person@example.com",
            loginMethod: "Claude Max",
          },
        }),
      }),
    );

    expect(saved?.claude?.unscoped).toEqual([unscopedWeekly]);
    expect(saved?.claude?.accounts[existingKey]?.[0]?.entries[0]?.usedPercent).toBe(99);
  });

  it("fails closed for missing, mismatched, or ownerless Claude identity", async () => {
    let loads = 0;
    let saves = 0;
    const coordinator = new PlanUtilizationHistoryCoordinator({
      load: Effect.sync(() => {
        loads += 1;
        return {};
      }),
      save: () =>
        Effect.sync(() => {
          saves += 1;
        }),
    });
    for (const identity of [
      undefined,
      { providerId: "codex" as const, accountEmail: "person@example.com" },
      { providerId: "claude" as const },
    ]) {
      await expect(
        Effect.runPromise(
          coordinator.recordClaudeIdentity({
            capturedAt,
            snapshot: usageSnapshot({
              primary: { usedPercent: 10, windowMinutes: 300 },
              ...(identity === undefined ? {} : { identity }),
            }),
          }),
        ),
      ).resolves.toBe(false);
    }
    expect(loads).toBe(0);
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
