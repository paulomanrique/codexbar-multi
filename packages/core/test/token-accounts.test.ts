import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import {
  makeDefaultCodexBarConfig,
  makeTokenAccountRosterService,
  TokenAccountRosterError,
  type ConfigRepositoryService,
  type PersistedCodexBarConfig,
  type TokenAccountSupport,
} from "../src/index.ts";
import { InfrastructureError } from "../src/services.ts";
import type { ProviderId } from "@codexbar/contracts";

const accountConfig = (activeIndex = 9): PersistedCodexBarConfig => {
  const base = makeDefaultCodexBarConfig();
  return {
    ...base,
    providers: base.providers.map((provider) =>
      provider.id === "claude"
        ? {
            ...provider,
            cookieSource: "auto" as const,
            tokenAccounts: {
              version: 2,
              activeIndex,
              accounts: [
                { id: "first", label: "First", addedAt: 1 },
                { id: "second", label: "Second", addedAt: 2, usageScope: "team" },
              ],
            },
          }
        : provider,
    ),
  };
};

const repository = (
  initial: PersistedCodexBarConfig | undefined,
): ConfigRepositoryService & {
  readonly credentialReads: string[];
  current: PersistedCodexBarConfig | undefined;
} => {
  const store: ConfigRepositoryService & {
    readonly credentialReads: string[];
    current: PersistedCodexBarConfig | undefined;
  } = {
    credentialReads: [],
    current: initial,
    load: Effect.sync(() => store.current),
    save: (config) =>
      Effect.sync(() => {
        store.current = config;
      }),
    modify: (mutation) =>
      Effect.gen(function* () {
        const result = yield* mutation(store.current);
        store.current = result.config;
        return result;
      }),
  };
  return store;
};

const service = (config: PersistedCodexBarConfig | undefined) => {
  const store = repository(config);
  return {
    store,
    tokenAccounts: makeTokenAccountRosterService({
      config: store,
      support: new Map<ProviderId, TokenAccountSupport>([
        [
          "claude",
          {
            provider: "claude",
            requiresManualCookieSource: true,
            selectedAccountRequiresManualCookieSource: false,
            runtimeSelectionAvailable: true,
          },
        ],
        [
          "cursor",
          {
            provider: "cursor",
            requiresManualCookieSource: false,
            selectedAccountRequiresManualCookieSource: true,
            runtimeSelectionAvailable: false,
          },
        ],
      ]),
    }),
  };
};

describe("token account roster service", () => {
  it("lists metadata-only accounts and clamps activeIndex", async () => {
    const { tokenAccounts } = service(accountConfig(99));
    const roster = await Effect.runPromise(tokenAccounts.list("claude"));
    expect(roster.activeIndex).toBe(1);
    expect(roster.accounts).toEqual([
      { id: "first", label: "First", addedAt: 1 },
      { id: "second", label: "Second", addedAt: 2, usageScope: "team" },
    ]);
    expect(roster.revision).toMatch(/^[a-f0-9]{64}$/);
  });

  it("selects by account ID, preserves metadata order, and applies manual cookie source", async () => {
    const { store, tokenAccounts } = service(accountConfig(0));
    const before = await Effect.runPromise(tokenAccounts.list("claude"));
    const after = await Effect.runPromise(
      tokenAccounts.select({
        provider: "claude",
        accountId: "second",
        expectedRevision: before.revision,
      }),
    );
    expect(after.activeIndex).toBe(1);
    expect(after.accounts.map((account) => account.id)).toEqual(["first", "second"]);
    expect(store.current?.providers.find((provider) => provider.id === "claude")).toMatchObject({
      cookieSource: "manual",
      tokenAccounts: {
        version: 2,
        activeIndex: 1,
        accounts: [
          { id: "first", label: "First", addedAt: 1 },
          { id: "second", label: "Second", addedAt: 2, usageScope: "team" },
        ],
      },
    });
  });

  it("renames by account ID, trims labels, preserves account metadata, and refreshes revision", async () => {
    const { store, tokenAccounts } = service(accountConfig(0));
    const before = await Effect.runPromise(tokenAccounts.list("claude"));
    const after = await Effect.runPromise(
      tokenAccounts.rename({
        provider: "claude",
        accountId: "second",
        label: "  Renamed Second  ",
        expectedRevision: before.revision,
      }),
    );
    expect(after.activeIndex).toBe(0);
    expect(after.revision).not.toBe(before.revision);
    expect(after.accounts).toEqual([
      { id: "first", label: "First", addedAt: 1 },
      { id: "second", label: "Renamed Second", addedAt: 2, usageScope: "team" },
    ]);
    expect(store.current?.providers.find((provider) => provider.id === "claude")).toMatchObject({
      cookieSource: "auto",
      tokenAccounts: {
        version: 2,
        activeIndex: 0,
        accounts: [
          { id: "first", label: "First", addedAt: 1 },
          { id: "second", label: "Renamed Second", addedAt: 2, usageScope: "team" },
        ],
      },
    });
  });

  it("rejects stale, missing, and invalid token account renames without mutating", async () => {
    const { store, tokenAccounts } = service(accountConfig(0));
    const original = store.current;
    const roster = await Effect.runPromise(tokenAccounts.list("claude"));

    await expect(
      Effect.runPromise(
        tokenAccounts.rename({
          provider: "claude",
          accountId: "second",
          label: "Updated",
          expectedRevision: "0".repeat(64),
        }),
      ),
    ).rejects.toMatchObject({ code: "stale-revision" });
    expect(store.current).toBe(original);

    await expect(
      Effect.runPromise(
        tokenAccounts.rename({
          provider: "claude",
          accountId: "missing",
          label: "Updated",
          expectedRevision: roster.revision,
        }),
      ),
    ).rejects.toMatchObject({ code: "missing-account" });
    expect(store.current).toBe(original);

    await expect(
      Effect.runPromise(
        tokenAccounts.rename({
          provider: "claude",
          accountId: "second",
          label: " \n\t ",
          expectedRevision: roster.revision,
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid-label" });
    expect(store.current).toBe(original);

    await expect(
      Effect.runPromise(
        tokenAccounts.rename({
          provider: "claude",
          accountId: "second",
          label: "Bad\u0000Label",
          expectedRevision: roster.revision,
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid-label" });
    expect(store.current).toBe(original);
  });

  it("fails closed for stale revisions and missing accounts", async () => {
    const { tokenAccounts } = service(accountConfig(0));
    await expect(
      Effect.runPromise(
        tokenAccounts.select({
          provider: "claude",
          accountId: "second",
          expectedRevision: "0".repeat(64),
        }),
      ),
    ).rejects.toMatchObject({ code: "stale-revision" });

    const roster = await Effect.runPromise(tokenAccounts.list("claude"));
    await expect(
      Effect.runPromise(
        tokenAccounts.select({
          provider: "claude",
          accountId: "missing",
          expectedRevision: roster.revision,
        }),
      ),
    ).rejects.toMatchObject({ code: "missing-account" });
  });

  it("renames metadata only while preserving identity, order, selection, and duplicate labels", async () => {
    const { store, tokenAccounts } = service(accountConfig(99));
    const before = await Effect.runPromise(tokenAccounts.list("claude"));
    const after = await Effect.runPromise(
      tokenAccounts.rename({
        provider: "claude",
        accountId: "first",
        label: "  Second  ",
        expectedRevision: before.revision,
      }),
    );

    expect(after).toMatchObject({ activeIndex: 1, selectionAvailable: true });
    expect(after.revision).not.toBe(before.revision);
    expect(after.accounts).toEqual([
      { id: "first", label: "Second", addedAt: 1 },
      { id: "second", label: "Second", addedAt: 2, usageScope: "team" },
    ]);
    expect(store.current?.providers.find((provider) => provider.id === "claude")).toMatchObject({
      cookieSource: "auto",
      tokenAccounts: {
        version: 2,
        activeIndex: 1,
        accounts: [
          { id: "first", label: "Second", addedAt: 1 },
          { id: "second", label: "Second", addedAt: 2, usageScope: "team" },
        ],
      },
    });
  });

  it("fails closed for invalid labels, stale revisions, and missing rename targets", async () => {
    const { tokenAccounts } = service(accountConfig(0));
    const roster = await Effect.runPromise(tokenAccounts.list("claude"));

    await expect(
      Effect.runPromise(
        tokenAccounts.rename({
          provider: "claude",
          accountId: "first",
          label: "   ",
          expectedRevision: roster.revision,
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid-label" });
    await expect(
      Effect.runPromise(
        tokenAccounts.rename({
          provider: "claude",
          accountId: "first",
          label: "Renamed",
          expectedRevision: "0".repeat(64),
        }),
      ),
    ).rejects.toMatchObject({ code: "stale-revision" });
    await expect(
      Effect.runPromise(
        tokenAccounts.rename({
          provider: "claude",
          accountId: "missing",
          label: "Renamed",
          expectedRevision: roster.revision,
        }),
      ),
    ).rejects.toMatchObject({ code: "missing-account" });
  });

  it("fails closed for duplicate account IDs instead of selecting ambiguously", async () => {
    const base = accountConfig(0);
    const duplicate: PersistedCodexBarConfig = {
      ...base,
      providers: base.providers.map((provider) => {
        if (provider.id !== "claude" || provider.tokenAccounts === undefined) return provider;
        const [first, second] = provider.tokenAccounts.accounts;
        if (first === undefined || second === undefined)
          throw new Error("missing fixture accounts");
        return {
          ...provider,
          tokenAccounts: {
            ...provider.tokenAccounts,
            accounts: [first, { ...second, id: first.id }],
          },
        };
      }),
    };
    const { tokenAccounts } = service(duplicate);

    await expect(Effect.runPromise(tokenAccounts.list("claude"))).rejects.toMatchObject({
      code: "invalid-roster",
    });
    await expect(
      Effect.runPromise(
        tokenAccounts.rename({
          provider: "claude",
          accountId: "first",
          label: "Renamed",
          expectedRevision: "0".repeat(64),
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid-roster" });
  });

  it("rejects unsupported providers before credential access", async () => {
    const store = repository(accountConfig(0));
    const tokenAccounts = makeTokenAccountRosterService({
      config: {
        ...store,
        load: Effect.fail(new InfrastructureError("credential", "must not load")),
      },
      support: new Map(),
    });

    await expect(Effect.runPromise(tokenAccounts.list("codex"))).rejects.toBeInstanceOf(
      TokenAccountRosterError,
    );
    expect(store.credentialReads).toEqual([]);
  });

  it("rejects selection before mutation when the runtime mapper is incomplete", async () => {
    const { store, tokenAccounts } = service(accountConfig(0));
    const original = store.current;
    const roster = await Effect.runPromise(tokenAccounts.list("cursor"));

    await expect(
      Effect.runPromise(
        tokenAccounts.select({
          provider: "cursor",
          accountId: "missing",
          expectedRevision: roster.revision,
        }),
      ),
    ).rejects.toMatchObject({ code: "selection-unavailable" });
    expect(store.current).toBe(original);
  });
});
