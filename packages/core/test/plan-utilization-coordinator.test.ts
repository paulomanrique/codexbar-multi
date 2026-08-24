import type { ProviderInstanceId, UsageSnapshot } from "@codexbar/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import {
  claudeOAuthPlanUtilizationAccountKey,
  claudeSelectedTokenAccountPlanUtilizationAccountKey,
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

const antigravitySnapshot = (
  sessionUsed: number,
  weeklyUsed: number,
  identity?: UsageSnapshot["identity"],
): UsageSnapshot =>
  usageSnapshot({
    extraRateWindows: [
      {
        id: "antigravity-quota-summary-gemini-session",
        title: "Gemini 5-hour",
        window: { usedPercent: sessionUsed, windowMinutes: 300 },
      },
      {
        id: "antigravity-quota-summary-gemini-weekly",
        title: "Gemini weekly",
        window: { usedPercent: weeklyUsed, windowMinutes: 10_080 },
      },
    ],
    ...(identity === undefined ? {} : { identity }),
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

  it("fails closed for mismatched or ownerless Claude identity and does not persist when sticky ownership is unavailable", async () => {
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
    await expect(
      Effect.runPromise(
        coordinator.recordClaudeIdentity({
          capturedAt,
          snapshot: usageSnapshot({
            primary: { usedPercent: 10, windowMinutes: 300 },
          }),
        }),
      ),
    ).resolves.toBe(false);
    expect(loads).toBe(1);
    expect(saves).toBe(0);
  });

  it("falls back to the sticky Claude account when a later snapshot loses identity", async () => {
    const accountKey = "existing";
    let saved: PlanUtilizationHistoryProviders | undefined;
    const coordinator = new PlanUtilizationHistoryCoordinator({
      load: Effect.succeed({
        claude: new PlanUtilizationHistoryBuckets({
          preferredAccountKey: accountKey,
          accounts: {
            [accountKey]: [
              new PlanUtilizationSeriesHistory({
                name: "session",
                windowMinutes: 300,
                entries: [sample(10).entry],
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
    await expect(
      Effect.runPromise(
        coordinator.recordClaudeIdentity({
          capturedAt: new Date(capturedAt.getTime() + 60 * 60 * 1_000),
          snapshot: usageSnapshot({
            primary: { usedPercent: 30, windowMinutes: 300 },
            secondary: { usedPercent: 40, windowMinutes: 10_080 },
          }),
        }),
      ),
    ).resolves.toBe(true);
    expect(saved?.claude?.preferredAccountKey).toBe(accountKey);
    expect(
      saved?.claude?.accounts[accountKey]?.map((history) =>
        history.entries.map((entry) => entry.usedPercent),
      ),
    ).toEqual([[10, 30], [40]]);
  });

  it("records Antigravity unscoped, then adopts it into an email owner", async () => {
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
        coordinator.recordAntigravity({
          capturedAt,
          snapshot: antigravitySnapshot(20, 40),
        }),
      ),
    ).resolves.toBe(true);
    expect(saved?.antigravity?.unscoped.map((history) => history.name.rawValue)).toEqual([
      "session",
      "weekly",
    ]);

    await expect(
      Effect.runPromise(
        coordinator.recordAntigravity({
          capturedAt: new Date(capturedAt.getTime() + 60 * 60 * 1_000),
          snapshot: antigravitySnapshot(25, 45, {
            providerId: "antigravity",
            accountEmail: " PERSON@Example.com ",
          }),
        }),
      ),
    ).resolves.toBe(true);

    const accountKey = "75d0b167bd6f71dd9568ea49a94f1563284f6e95c8ca2dad095fdc7ac9773cfc";
    expect(saved?.antigravity?.preferredAccountKey).toBe(accountKey);
    expect(saved?.antigravity?.unscoped).toEqual([]);
    expect(
      saved?.antigravity?.accounts[accountKey]?.map((history) =>
        history.entries.map((entry) => entry.usedPercent),
      ),
    ).toEqual([
      [20, 25],
      [40, 45],
    ]);
  });

  it("drops legacy provider-wide weekly history when the Gemini pair starts", async () => {
    const legacyWeekly = new PlanUtilizationSeriesHistory({
      name: "weekly",
      windowMinutes: 10_080,
      entries: [sample(99).entry],
    });
    let saved: PlanUtilizationHistoryProviders | undefined;
    const coordinator = new PlanUtilizationHistoryCoordinator({
      load: Effect.succeed({
        antigravity: new PlanUtilizationHistoryBuckets({ unscoped: [legacyWeekly] }),
      }),
      save: (providers) =>
        Effect.sync(() => {
          saved = providers;
        }),
    });
    await Effect.runPromise(
      coordinator.recordAntigravity({
        capturedAt,
        snapshot: antigravitySnapshot(20, 40),
      }),
    );
    expect(
      saved?.antigravity?.unscoped.map((history) => ({
        name: history.name.rawValue,
        values: history.entries.map((entry) => entry.usedPercent),
      })),
    ).toEqual([
      { name: "session", values: [20] },
      { name: "weekly", values: [40] },
    ]);
  });

  it("continues a sticky Antigravity owner and skips snapshots without a pinned pair", async () => {
    const accountKey = "existing";
    let loads = 0;
    let saves = 0;
    let saved: PlanUtilizationHistoryProviders | undefined;
    const coordinator = new PlanUtilizationHistoryCoordinator({
      load: Effect.sync(() => {
        loads += 1;
        return {
          antigravity: new PlanUtilizationHistoryBuckets({
            accounts: {
              [accountKey]: [
                new PlanUtilizationSeriesHistory({
                  name: "session",
                  windowMinutes: 300,
                  entries: [sample(10).entry],
                }),
              ],
            },
          }),
        };
      }),
      save: (providers) =>
        Effect.sync(() => {
          saves += 1;
          saved = providers;
        }),
    });
    await expect(
      Effect.runPromise(
        coordinator.recordAntigravity({
          capturedAt: new Date(capturedAt.getTime() + 60 * 60 * 1_000),
          snapshot: antigravitySnapshot(30, 50),
        }),
      ),
    ).resolves.toBe(true);
    expect(saved?.antigravity?.accounts[accountKey]).toHaveLength(2);
    expect(saved?.antigravity?.unscoped).toEqual([]);

    await expect(
      Effect.runPromise(
        coordinator.recordAntigravity({
          capturedAt,
          snapshot: usageSnapshot({
            extraRateWindows: [
              {
                id: "antigravity-quota-summary-third-party-session",
                title: "Claude/GPT 5-hour",
                window: { usedPercent: 90, windowMinutes: 300 },
              },
            ],
          }),
        }),
      ),
    ).resolves.toBe(false);
    expect(loads).toBe(1);
    expect(saves).toBe(1);
  });

  it("uses Swift Unicode-scalar ordering to break sticky Antigravity owner ties", async () => {
    const history = new PlanUtilizationSeriesHistory({
      name: "session",
      windowMinutes: 300,
      entries: [sample(10).entry],
    });
    let saved: PlanUtilizationHistoryProviders | undefined;
    const coordinator = new PlanUtilizationHistoryCoordinator({
      load: Effect.succeed({
        antigravity: new PlanUtilizationHistoryBuckets({
          accounts: { Å: [history], Z: [history] },
        }),
      }),
      save: (providers) =>
        Effect.sync(() => {
          saved = providers;
        }),
    });
    await Effect.runPromise(
      coordinator.recordAntigravity({
        capturedAt: new Date(capturedAt.getTime() + 60 * 60 * 1_000),
        snapshot: antigravitySnapshot(30, 50),
      }),
    );
    expect(saved?.antigravity?.accounts.Z).toHaveLength(2);
    expect(saved?.antigravity?.accounts.Å).toEqual([history]);
  });

  it("records Claude OAuth only in its opaque owner bucket without adopting existing history", async () => {
    const owner = "a".repeat(64);
    const accountKey = claudeOAuthPlanUtilizationAccountKey(owner);
    if (accountKey === undefined) throw new Error("fixture owner must be valid");
    const unscoped = new PlanUtilizationSeriesHistory({
      name: "session",
      windowMinutes: 300,
      entries: [sample(5).entry],
    });
    const sticky = new PlanUtilizationSeriesHistory({
      name: "session",
      windowMinutes: 300,
      entries: [sample(15).entry],
    });
    let saved: PlanUtilizationHistoryProviders | undefined;
    const coordinator = new PlanUtilizationHistoryCoordinator({
      load: Effect.succeed({
        claude: new PlanUtilizationHistoryBuckets({
          preferredAccountKey: "identity-owner",
          unscoped: [unscoped],
          accounts: { "identity-owner": [sticky] },
        }),
      }),
      save: (providers) =>
        Effect.sync(() => {
          saved = providers;
        }),
    });
    await expect(
      Effect.runPromise(
        coordinator.recordClaudeOAuth({
          historyOwnerIdentifier: owner,
          capturedAt: new Date(capturedAt.getTime() + 60 * 60 * 1_000),
          snapshot: usageSnapshot({ primary: { usedPercent: 35, windowMinutes: 300 } }),
        }),
      ),
    ).resolves.toBe(true);
    expect(saved?.claude?.preferredAccountKey).toBe(accountKey);
    expect(saved?.claude?.unscoped).toEqual([unscoped]);
    expect(saved?.claude?.accounts["identity-owner"]).toEqual([sticky]);
    expect(saved?.claude?.accounts[accountKey]?.[0]?.entries[0]?.usedPercent).toBe(35);
  });

  it("isolates selected Claude token-account history from identity sticky and unscoped buckets", async () => {
    const firstKey = claudeSelectedTokenAccountPlanUtilizationAccountKey("claude", "account-a");
    const secondKey = claudeSelectedTokenAccountPlanUtilizationAccountKey("claude", "account-b");
    if (firstKey === undefined || secondKey === undefined) throw new Error("fixture keys");
    const unscoped = new PlanUtilizationSeriesHistory({
      name: "session",
      windowMinutes: 300,
      entries: [sample(5).entry],
    });
    const sticky = new PlanUtilizationSeriesHistory({
      name: "session",
      windowMinutes: 300,
      entries: [sample(15).entry],
    });
    let saved: PlanUtilizationHistoryProviders | undefined;
    const coordinator = new PlanUtilizationHistoryCoordinator({
      load: Effect.succeed({
        claude: new PlanUtilizationHistoryBuckets({
          preferredAccountKey: "identity-owner",
          unscoped: [unscoped],
          accounts: { "identity-owner": [sticky] },
        }),
      }),
      save: (providers) =>
        Effect.sync(() => {
          saved = providers;
        }),
    });

    await expect(
      Effect.runPromise(
        coordinator.recordClaudeSelectedTokenAccount({
          accountKey: firstKey,
          capturedAt: new Date(capturedAt.getTime() + 60 * 60 * 1_000),
          snapshot: usageSnapshot({
            primary: { usedPercent: 35, windowMinutes: 300 },
            identity: { providerId: "claude", accountEmail: "same@example.com" },
          }),
        }),
      ),
    ).resolves.toBe(true);
    await expect(
      Effect.runPromise(
        coordinator.recordClaudeSelectedTokenAccount({
          accountKey: secondKey,
          capturedAt: new Date(capturedAt.getTime() + 2 * 60 * 60 * 1_000),
          snapshot: usageSnapshot({
            primary: { usedPercent: 55, windowMinutes: 300 },
            identity: { providerId: "claude", accountEmail: "same@example.com" },
          }),
        }),
      ),
    ).resolves.toBe(true);

    expect(saved?.claude?.preferredAccountKey).toBe(secondKey);
    expect(saved?.claude?.unscoped).toEqual([unscoped]);
    expect(saved?.claude?.accounts["identity-owner"]).toEqual([sticky]);
    expect(
      saved?.claude?.accounts[firstKey]?.[0]?.entries.map((entry) => entry.usedPercent),
    ).toEqual([35]);
    expect(
      saved?.claude?.accounts[secondKey]?.[0]?.entries.map((entry) => entry.usedPercent),
    ).toEqual([55]);
  });

  it("does not load or save Claude OAuth history without a valid owner", async () => {
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
    for (const historyOwnerIdentifier of [undefined, "invalid", "f".repeat(63)]) {
      await expect(
        Effect.runPromise(
          coordinator.recordClaudeOAuth({
            ...(historyOwnerIdentifier === undefined ? {} : { historyOwnerIdentifier }),
            capturedAt,
            snapshot: usageSnapshot({ primary: { usedPercent: 35, windowMinutes: 300 } }),
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
