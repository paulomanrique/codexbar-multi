import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSpendPublication,
  type CostUsageRecord,
  type DailyCostUsageReplacement,
} from "@codexbar/core";
import { makeNodeGrokLocalTokenScanner } from "@codexbar/platform/node";
import { grok } from "@codexbar/providers";

import {
  DesktopSpendPublisher,
  publishedSpendOverviewInputs,
  refreshGrokLocalTokensForSpend,
  type DesktopSpendPersistence,
} from "../src/main/spend-overview.ts";

const snapshot = {
  details: [],
  updatedAt: "2026-08-20T00:00:00.000Z",
  dataConfidence: "exact" as const,
};

describe("published desktop spend overview (Swift #3067 parity)", () => {
  it("does not scan Grok local files when Grok is disabled from the spend roster", async () => {
    let calls = 0;
    await refreshGrokLocalTokensForSpend(
      {
        ownershipFingerprint: "no-grok",
        requestedDays: 30,
        roster: [{ id: "xai", providerId: "xai", displayName: "xAI" }],
      },
      {
        refresh: async () => {
          calls += 1;
        },
      },
    );
    expect(calls).toBe(0);
  });

  it("keeps xAI analytics unavailable rather than publishing retained prepaid-era rows as zero spend", async () => {
    const persistence: DesktopSpendPersistence = {
      costs: {
        list: () =>
          Effect.succeed([
            {
              providerId: "xai",
              recordedAt: Date.parse("2026-08-20T00:00:00.000Z"),
              inputTokens: 0,
              outputTokens: 0,
              costUsd: 4,
            },
          ]),
        dailySourceState: () => Effect.succeed({ availability: "unavailable", coverage: "exact" }),
      },
    };
    const publisher = new DesktopSpendPublisher(
      persistence,
      () => new Date("2026-08-20T12:00:00.000Z"),
    );
    const projection = await publisher.refresh({
      ownershipFingerprint: "xai-owner",
      requestedDays: 30,
      roster: [
        {
          id: "xai",
          providerId: "xai",
          displayName: "xAI",
          dailySpendSourceKey: "vendor-daily-spend",
        },
      ],
    });
    expect(projection.overview.sources).toEqual([
      expect.objectContaining({ provider: "xai", state: "unavailable" }),
    ]);
    expect(projection.overview.totals.costUsd).toBe(0);
  });

  it("publishes estimated xAI chart coverage without its internal source key", async () => {
    const persistence: DesktopSpendPersistence = {
      costs: {
        list: () =>
          Effect.succeed([
            {
              providerId: "xai",
              recordedAt: Date.parse("2026-08-20T00:00:00.000Z"),
              inputTokens: 0,
              outputTokens: 0,
              costUsd: 4,
            },
          ]),
        dailySourceState: () =>
          Effect.succeed({ availability: "available", coverage: "estimated" }),
      },
    };
    const publisher = new DesktopSpendPublisher(
      persistence,
      () => new Date("2026-08-20T12:00:00.000Z"),
    );
    const projection = await publisher.refresh({
      ownershipFingerprint: "xai-owner",
      requestedDays: 30,
      roster: [
        {
          id: "xai-private-account",
          providerId: "xai",
          displayName: "xAI",
          dailySpendSourceKey: "vendor-daily-spend",
        },
      ],
    });
    expect(projection.overview.sources).toEqual([
      expect.objectContaining({ provider: "xai", state: "available", coverage: "estimated" }),
    ]);
    expect(JSON.stringify(projection)).not.toContain("vendor-daily-spend");
    expect(JSON.stringify(projection)).not.toContain("xai-private-account");
  });

  it("keeps Grok unavailable when its local session scan has no publishable daily tokens", async () => {
    const persistence: DesktopSpendPersistence = {
      costs: {
        list: () => Effect.succeed([]),
        dailySourceState: () => Effect.succeed({ availability: "unavailable", coverage: "exact" }),
      },
    };
    const publisher = new DesktopSpendPublisher(
      persistence,
      () => new Date("2026-08-20T12:00:00.000Z"),
    );
    const projection = await publisher.refresh({
      ownershipFingerprint: "grok-local-owner",
      requestedDays: 30,
      roster: [
        {
          id: "grok",
          providerId: "grok",
          displayName: "Grok",
          dailySpendSourceKey: "local-session-tokens",
        },
      ],
    });
    expect(projection.overview.sources).toEqual([
      expect.objectContaining({ provider: "grok", state: "unavailable" }),
    ]);
    expect(projection.overview.totals).toMatchObject({ totalTokens: 0, costUsd: 0 });
  });

  it("publishes Grok local tokens without attributing subscription credits as dollars", async () => {
    const persistence: DesktopSpendPersistence = {
      costs: {
        list: () =>
          Effect.succeed([
            {
              providerId: "grok",
              recordedAt: Date.parse("2026-08-20T00:00:00.000Z"),
              inputTokens: 250,
              outputTokens: 0,
              costUsd: 0,
            },
          ]),
        dailySourceState: () => Effect.succeed({ availability: "available", coverage: "exact" }),
      },
    };
    const publisher = new DesktopSpendPublisher(
      persistence,
      () => new Date("2026-08-20T12:00:00.000Z"),
    );
    const projection = await publisher.refresh({
      ownershipFingerprint: "grok-local-owner",
      requestedDays: 30,
      roster: [
        {
          id: "grok-private-source",
          providerId: "grok",
          displayName: "Grok",
          dailySpendSourceKey: "local-session-tokens",
        },
      ],
    });
    expect(projection.overview).toMatchObject({
      totals: { totalTokens: 250, costUsd: 0 },
      providers: [{ provider: "grok", totals: { totalTokens: 250, costUsd: 0 } }],
    });
    expect(JSON.stringify(projection)).not.toContain("grok-private-source");
  });

  it("keeps Grok local tokens publishable when remote billing fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codexbar-grok-spend-integration-"));
    const root = join(directory, "sessions");
    const signalPath = join(root, "cwd", "session", "signals.json");
    let replacement: DailyCostUsageReplacement | undefined;
    const now = new Date("2026-08-20T12:00:00.000Z");
    try {
      await mkdir(join(root, "cwd", "session"), { recursive: true });
      await writeFile(signalPath, '{"totalTokensBeforeCompaction":200,"contextTokensUsed":50}');
      await utimes(signalPath, now, now);
      // The remote quota is unavailable, exactly as it would be after an
      // expired/failed web billing probe. It must not gate the local scanner.
      await expect(
        grok.fetchUsage({
          settings: { get: () => undefined, getSecret: () => "fixture-cookie" },
          http: {
            get: async () => ({ status: 500, bodyText: "" }),
            getJSON: async () => ({ status: 500, bodyText: "", json: {} }),
            postJSON: async () => ({ status: 500, bodyText: "", json: {} }),
            postBinary: async () => ({ status: 503, headers: {}, body: new Uint8Array() }),
          },
          browser: { cookieHeader: async () => "" },
          env: {},
          date: {
            now: () => now,
            nowMillis: () => now.getTime(),
            iso: (value) => new Date(value).toISOString(),
            unixSeconds: (value) => new Date(value * 1_000).toISOString(),
            unixMillis: (value) => new Date(value).toISOString(),
            nextDailyReset: () => "2026-08-21T00:00:00.000Z",
          },
          format: { number: String, usd: (value) => `$${value}`, monthDay: () => "Aug 20" },
          pct: (used, limit) => (used / limit) * 100,
          amountFromPercent: (usedPercent, limit) => (usedPercent / 100) * limit,
          fail: Object.fromEntries(
            [
              "authenticationExpired",
              "missingCredential",
              "permissionDenied",
              "rateLimited",
              "providerUnavailable",
              "parseFailure",
              "networkFailure",
              "apiFailure",
            ].map((name) => [name, (message: string) => new Error(`${name}: ${message}`)]),
          ) as never,
        }),
      ).rejects.toThrow("providerUnavailable");

      const scanner = makeNodeGrokLocalTokenScanner({
        costs: {
          replaceDaily: (next: DailyCostUsageReplacement) =>
            Effect.sync(() => {
              replacement = next;
            }),
        } as never,
        scan: { root },
        now: () => now,
      });
      await scanner.refresh();
      const persistence: DesktopSpendPersistence = {
        costs: {
          list: () => Effect.succeed(replacement?.records ?? []),
          dailySourceState: () =>
            Effect.succeed(
              replacement === undefined
                ? undefined
                : { availability: replacement.availability, coverage: replacement.coverage },
            ),
        },
      };
      const projection = await new DesktopSpendPublisher(persistence, () => now).refresh({
        ownershipFingerprint: "grok-independent-local-source",
        requestedDays: 30,
        roster: [
          {
            id: "grok-private-source",
            providerId: "grok",
            displayName: "Grok",
            dailySpendSourceKey: "local-session-tokens",
          },
        ],
      });
      expect(projection.overview).toMatchObject({
        sources: [{ provider: "grok", state: "available" }],
        totals: { totalTokens: 250, costUsd: 0 },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reuses only current, available sources in the requested provider silo", () => {
    const publication = createSpendPublication({
      revision: 1,
      generation: 1,
      configuration: { ownershipFingerprint: "owner-a" },
      loadedAt: "2026-08-20T00:00:00.000Z",
      isRefreshing: false,
      roster: [
        { id: "codex:work", providerId: "codex", displayName: "Codex work" },
        { id: "claude", providerId: "claude", displayName: "Claude" },
      ],
      inputs: [
        { id: "codex:work", providerId: "codex", displayName: "Codex work", snapshot },
        { id: "claude", providerId: "claude", displayName: "Claude", snapshot },
      ],
      failedSourceIds: new Set(["claude"]),
    });

    expect(publishedSpendOverviewInputs(publication, "owner-a", new Set(["codex"]))).toEqual([
      expect.objectContaining({ id: "codex:work", providerId: "codex" }),
    ]);
    expect(publishedSpendOverviewInputs(publication, "owner-a", new Set(["claude"]))).toEqual([]);
    expect(publishedSpendOverviewInputs(publication, "owner-b", new Set(["codex"]))).toEqual([]);
  });

  it("publishes repository-backed overview and dashboard DTOs without source identities", async () => {
    const records: readonly CostUsageRecord[] = [
      {
        providerId: "codex",
        recordedAt: Date.parse("2026-08-20T10:00:00.000Z"),
        inputTokens: 12,
        outputTokens: 8,
        costUsd: 0.5,
      },
    ];
    const persistence: DesktopSpendPersistence = {
      costs: {
        list: (provider) => Effect.succeed(provider === "codex" ? records : []),
      },
    };
    const publisher = new DesktopSpendPublisher(
      persistence,
      () => new Date("2026-08-20T12:00:00.000Z"),
    );
    const projection = await publisher.refresh({
      ownershipFingerprint: "safe-owner-digest",
      requestedDays: 30,
      roster: [
        { id: "codex:private-profile", providerId: "codex", displayName: "Codex" },
        { id: "openai", providerId: "openai", displayName: "OpenAI" },
      ],
    });

    expect(projection.overview).toMatchObject({
      schemaVersion: 1,
      isRefreshing: false,
      totals: expect.objectContaining({ totalTokens: 20, costUsd: 0.5, sourceCount: 1 }),
      sources: [
        { provider: "codex", displayName: "Codex", state: "available" },
        { provider: "openai", displayName: "OpenAI", state: "confirmed-empty" },
      ],
    });
    expect(projection.dashboard.dailyPoints).toEqual([
      {
        provider: "codex",
        day: "2026-08-20",
        inputTokens: 12,
        outputTokens: 8,
        costUsd: 0.5,
      },
    ]);
    expect(JSON.stringify(projection)).not.toContain("codex:private-profile");
  });

  it("keeps a prior provider result stale on a failed read and rejects late generations", async () => {
    let shouldFail = false;
    let resolveFirst: ((records: readonly CostUsageRecord[]) => void) | undefined;
    let firstCall = true;
    const persistence: DesktopSpendPersistence = {
      costs: {
        list: () =>
          Effect.promise(() => {
            if (shouldFail) return Promise.reject(new Error("private storage detail"));
            if (!firstCall) {
              return Promise.resolve([
                {
                  providerId: "codex",
                  recordedAt: Date.parse("2026-08-20T10:00:00.000Z"),
                  inputTokens: 2,
                  outputTokens: 3,
                  costUsd: 0.1,
                },
              ]);
            }
            firstCall = false;
            return new Promise<readonly CostUsageRecord[]>((resolve) => {
              resolveFirst = resolve;
            });
          }),
      },
    };
    const publisher = new DesktopSpendPublisher(
      persistence,
      () => new Date("2026-08-20T12:00:00.000Z"),
    );
    const configuration = {
      ownershipFingerprint: "safe-owner-digest",
      requestedDays: 30,
      roster: [{ id: "codex", providerId: "codex" as const, displayName: "Codex" }],
    };
    const first = publisher.refresh(configuration);
    const second = await publisher.refresh(configuration);
    resolveFirst?.([]);
    const firstResult = await first;
    expect(firstResult.overview.generation).toBe(second.overview.generation);

    shouldFail = true;
    const stale = await publisher.refresh(configuration);
    expect(stale.overview.sources).toEqual([
      expect.objectContaining({ provider: "codex", state: "stale-last-known" }),
    ]);
    expect(stale.overview.totals.totalTokens).toBe(0);
  });
});
