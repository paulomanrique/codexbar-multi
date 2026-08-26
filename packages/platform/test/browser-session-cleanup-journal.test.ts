import { describe, expect, it } from "vite-plus/test";
import { Effect, Semaphore } from "effect";
import {
  InfrastructureError,
  type ConfigRepositoryService,
  type CredentialStoreService,
  type PersistedCodexBarConfig,
} from "@codexbar/core";

import {
  browserSessionCleanupIsPending,
  commitCodexBrowserSessionCredential,
  drainPendingBrowserSessionCleanups,
  enqueueCodexBrowserSessionCleanup,
  pendingBrowserSessionCleanupTargets,
  stageCodexBrowserSessionLoginFence,
  stageValidatedCodexBrowserSessionCredential,
  type BrowserSessionCleanupAdapter,
} from "../src/browser-session-cleanup-journal.ts";
import type { TokenAccountMigrationLock } from "../src/token-account-vault-config.ts";
import { legacyBrowserSessionCredentialKey } from "../src/account-scoped-browser-session.ts";

const configWithCodexAccounts = (
  accountIds: readonly string[],
  options: { readonly claudeAccountIds?: readonly string[] } = {},
): PersistedCodexBarConfig => ({
  version: 1,
  providers: [
    {
      id: "codex",
      extensions: {},
      tokenAccounts: {
        version: 2,
        activeIndex: 0,
        accounts: accountIds.map((id, index) => ({ id, label: id, addedAt: index })),
      },
    },
    ...(options.claudeAccountIds === undefined
      ? []
      : [
          {
            id: "claude",
            extensions: {},
            tokenAccounts: {
              version: 2,
              activeIndex: 0,
              accounts: options.claudeAccountIds.map((id, index) => ({
                id,
                label: id,
                addedAt: index,
              })),
            },
          },
        ]),
  ],
});

const memoryRepository = (
  initial: PersistedCodexBarConfig,
  options: { readonly failSaveAt?: number } = {},
): ConfigRepositoryService & {
  current: PersistedCodexBarConfig;
  readonly saves: PersistedCodexBarConfig[];
  readonly events: string[];
  readonly saveAttempts: () => number;
} => {
  let saveAttempts = 0;
  const repository: ConfigRepositoryService & {
    current: PersistedCodexBarConfig;
    readonly saves: PersistedCodexBarConfig[];
    readonly events: string[];
    readonly saveAttempts: () => number;
  } = {
    current: initial,
    saves: [],
    events: [],
    saveAttempts: () => saveAttempts,
    load: Effect.sync(() => repository.current),
    save: (next) =>
      Effect.suspend(() => {
        saveAttempts += 1;
        if (options.failSaveAt === saveAttempts)
          return Effect.fail(new InfrastructureError("save", "injected save failure"));
        repository.events.push(`save:${JSON.stringify(pendingBrowserSessionCleanupTargets(next))}`);
        repository.saves.push(next);
        repository.current = next;
        return Effect.void;
      }),
    modify: (mutation) =>
      Effect.gen(function* () {
        const result = yield* mutation(repository.current);
        yield* repository.save(result.config);
        return result;
      }),
  };
  return repository;
};

const memoryLock = (): TokenAccountMigrationLock => {
  const semaphore = Semaphore.makeUnsafe(1);
  return { runExclusive: (operation) => semaphore.withPermits(1)(operation) };
};

const adapter = (
  cleanup: BrowserSessionCleanupAdapter["cleanup"],
): BrowserSessionCleanupAdapter => ({ cleanup });

const memoryCredentials = (
  initial: Readonly<Record<string, string>> = {},
  write:
    | ((values: Map<string, string>, key: string, value: string) => void)
    | undefined = undefined,
): CredentialStoreService & { readonly values: Map<string, string> } => {
  const values = new Map(Object.entries(initial));
  return {
    values,
    read: (key) => Effect.sync(() => values.get(key)),
    write: (key, value) =>
      Effect.try({
        try: () => (write === undefined ? values.set(key, value) : write(values, key, value)),
        catch: (cause) => new InfrastructureError("write credential", "injected failure", cause),
      }).pipe(Effect.asVoid),
    remove: (key) => Effect.sync(() => void values.delete(key)),
  };
};

describe("browser-session cleanup journal", () => {
  it("keeps the publication fence until the account controller commits it", async () => {
    const repository = memoryRepository(configWithCodexAccounts(["account-a"]));
    const lock = memoryLock();
    const credentials = memoryCredentials();
    const publication = { key: "browser-session/codex/account-a", value: "candidate" };
    let authorizations = 0;

    await Effect.runPromise(
      stageCodexBrowserSessionLoginFence(repository, lock, credentials, "account-a"),
    );
    await Effect.runPromise(
      stageValidatedCodexBrowserSessionCredential(
        repository,
        lock,
        credentials,
        "account-a",
        publication,
        () => Effect.sync(() => void (authorizations += 1)),
      ),
    );

    expect(credentials.values.get(publication.key)).toBe("candidate");
    expect(authorizations).toBe(2);
    expect(browserSessionCleanupIsPending(repository.current, "codex", "account-a")).toBe(true);

    await Effect.runPromise(
      commitCodexBrowserSessionCredential(repository, lock, "account-a", () => Effect.void),
    );
    expect(browserSessionCleanupIsPending(repository.current, "codex", "account-a")).toBe(false);
    expect(credentials.values.get(publication.key)).toBe("candidate");
  });

  it("refuses to fence a reconnect over an existing credential", async () => {
    const repository = memoryRepository(configWithCodexAccounts(["account-a"]));
    const lock = memoryLock();
    const key = "browser-session/codex/account-a";
    const credentials = memoryCredentials({ [key]: "previous" });

    await expect(
      Effect.runPromise(
        stageCodexBrowserSessionLoginFence(repository, lock, credentials, "account-a"),
      ),
    ).rejects.toMatchObject({ operation: "stage browser-session login" });

    expect(credentials.values.get(key)).toBe("previous");
    expect(browserSessionCleanupIsPending(repository.current, "codex", "account-a")).toBe(false);
  });

  it("also refuses to fence over a pre-opaque legacy credential", async () => {
    const accountId = "legacy/account";
    const repository = memoryRepository(configWithCodexAccounts([accountId]));
    const lock = memoryLock();
    const legacyKey = legacyBrowserSessionCredentialKey("codex", accountId);
    if (legacyKey === undefined) throw new Error("expected legacy key");
    const credentials = memoryCredentials({ [legacyKey]: "legacy-session" });

    await expect(
      Effect.runPromise(
        stageCodexBrowserSessionLoginFence(repository, lock, credentials, accountId),
      ),
    ).rejects.toMatchObject({ operation: "stage browser-session login" });
    expect(credentials.values.get(legacyKey)).toBe("legacy-session");
    expect(browserSessionCleanupIsPending(repository.current, "codex", accountId)).toBe(false);
  });

  it("removes a partially written candidate when the keyring mutates then throws", async () => {
    const repository = memoryRepository(configWithCodexAccounts(["account-a"]));
    const lock = memoryLock();
    const key = "browser-session/codex/account-a";
    let writes = 0;
    const credentials = memoryCredentials({}, (values, nextKey, value) => {
      writes += 1;
      values.set(nextKey, value);
      if (writes === 1) throw new Error("keyring interrupted");
    });

    await Effect.runPromise(
      stageCodexBrowserSessionLoginFence(repository, lock, credentials, "account-a"),
    );
    await expect(
      Effect.runPromise(
        stageValidatedCodexBrowserSessionCredential(
          repository,
          lock,
          credentials,
          "account-a",
          { key, value: "candidate" },
          () => Effect.void,
        ),
      ),
    ).rejects.toMatchObject({ operation: "write credential" });
    expect(credentials.values.get(key)).toBeUndefined();
    expect(browserSessionCleanupIsPending(repository.current, "codex", "account-a")).toBe(false);
  });

  it("leaves the durable fence when rollback cannot prove credential ownership", async () => {
    const repository = memoryRepository(configWithCodexAccounts(["account-a"]));
    const lock = memoryLock();
    const key = "browser-session/codex/account-a";
    const credentials = memoryCredentials({}, (values, nextKey) => {
      values.set(nextKey, "unknown-concurrent-value");
      throw new Error("write result unknown");
    });

    await Effect.runPromise(
      stageCodexBrowserSessionLoginFence(repository, lock, credentials, "account-a"),
    );
    await expect(
      Effect.runPromise(
        stageValidatedCodexBrowserSessionCredential(
          repository,
          lock,
          credentials,
          "account-a",
          { key, value: "candidate" },
          () => Effect.void,
        ),
      ),
    ).rejects.toMatchObject({ operation: "rollback browser-session publication" });
    expect(credentials.values.get(key)).toBe("unknown-concurrent-value");
    expect(browserSessionCleanupIsPending(repository.current, "codex", "account-a")).toBe(true);
  });

  it("enqueues only an existing Codex account", async () => {
    const repository = memoryRepository(
      configWithCodexAccounts(["codex-account"], { claudeAccountIds: ["claude-account"] }),
    );
    const lock = memoryLock();

    await expect(
      Effect.runPromise(enqueueCodexBrowserSessionCleanup(repository, lock, "claude-account")),
    ).rejects.toMatchObject({ operation: "stage browser-session cleanup" });
    expect(repository.saves).toEqual([]);

    await Effect.runPromise(enqueueCodexBrowserSessionCleanup(repository, lock, "codex-account"));
    expect(pendingBrowserSessionCleanupTargets(repository.current)).toEqual([
      { providerId: "codex", accountId: "codex-account" },
    ]);
  });

  it("commits the marker before calling the cleanup adapter and acknowledges only after success", async () => {
    const repository = memoryRepository(configWithCodexAccounts(["account-a"]));
    const lock = memoryLock();
    const events = repository.events;

    await Effect.runPromise(enqueueCodexBrowserSessionCleanup(repository, lock, "account-a"));
    await Effect.runPromise(
      drainPendingBrowserSessionCleanups(
        repository,
        lock,
        adapter((target) =>
          Effect.sync(() => {
            events.push(`cleanup:${target.accountId}`);
            expect(
              browserSessionCleanupIsPending(repository.current, "codex", target.accountId),
            ).toBe(true);
          }),
        ),
      ),
    );

    expect(events).toEqual([
      'save:[{"providerId":"codex","accountId":"account-a"}]',
      "cleanup:account-a",
      "save:[]",
    ]);
    expect(pendingBrowserSessionCleanupTargets(repository.current)).toEqual([]);
  });

  it("preserves the marker when cleanup fails and retries the same target idempotently", async () => {
    const repository = memoryRepository(configWithCodexAccounts(["account-a"]));
    const lock = memoryLock();
    const calls: string[] = [];
    let fail = true;
    const cleanup = adapter((target) =>
      Effect.suspend(() => {
        calls.push(target.accountId);
        return fail
          ? Effect.fail(new InfrastructureError("partition", "partition busy"))
          : Effect.void;
      }),
    );

    await Effect.runPromise(enqueueCodexBrowserSessionCleanup(repository, lock, "account-a"));
    await expect(
      Effect.runPromise(drainPendingBrowserSessionCleanups(repository, lock, cleanup)),
    ).rejects.toMatchObject({ operation: "clean browser session" });
    expect(browserSessionCleanupIsPending(repository.current, "codex", "account-a")).toBe(true);

    fail = false;
    await Effect.runPromise(drainPendingBrowserSessionCleanups(repository, lock, cleanup));
    expect(calls).toEqual(["account-a", "account-a"]);
    expect(pendingBrowserSessionCleanupTargets(repository.current)).toEqual([]);
  });

  it("preserves the marker when the acknowledgement save fails", async () => {
    const repository = memoryRepository(configWithCodexAccounts(["account-a"]), { failSaveAt: 2 });
    const lock = memoryLock();
    const calls: string[] = [];

    await Effect.runPromise(enqueueCodexBrowserSessionCleanup(repository, lock, "account-a"));
    await expect(
      Effect.runPromise(
        drainPendingBrowserSessionCleanups(
          repository,
          lock,
          adapter((target) =>
            Effect.sync(() => {
              calls.push(target.accountId);
            }),
          ),
        ),
      ),
    ).rejects.toMatchObject({ operation: "acknowledge browser-session cleanup" });
    expect(calls).toEqual(["account-a"]);
    expect(browserSessionCleanupIsPending(repository.current, "codex", "account-a")).toBe(true);
    expect(repository.saveAttempts()).toBe(2);
  });

  it("does not lose an account appended while an earlier cleanup is draining", async () => {
    const repository = memoryRepository(configWithCodexAccounts(["account-a", "account-b"]));
    const lock = memoryLock();
    const calls: string[] = [];

    await Effect.runPromise(enqueueCodexBrowserSessionCleanup(repository, lock, "account-a"));
    await Effect.runPromise(
      drainPendingBrowserSessionCleanups(
        repository,
        lock,
        adapter((target) =>
          Effect.gen(function* () {
            calls.push(target.accountId);
            if (target.accountId === "account-a") {
              yield* enqueueCodexBrowserSessionCleanup(repository, lock, "account-b");
            }
          }),
        ),
      ),
    );

    expect(pendingBrowserSessionCleanupTargets(repository.current)).toEqual([
      { providerId: "codex", accountId: "account-b" },
    ]);
    await Effect.runPromise(
      drainPendingBrowserSessionCleanups(
        repository,
        lock,
        adapter((target) =>
          Effect.sync(() => {
            calls.push(target.accountId);
          }),
        ),
      ),
    );
    expect(calls).toEqual(["account-a", "account-b"]);
    expect(pendingBrowserSessionCleanupTargets(repository.current)).toEqual([]);
  });

  it("continues after one target fails and acknowledges independent successes", async () => {
    const repository = memoryRepository(configWithCodexAccounts(["account-a", "account-b"]));
    const lock = memoryLock();
    const calls: string[] = [];
    await Effect.runPromise(enqueueCodexBrowserSessionCleanup(repository, lock, "account-a"));
    await Effect.runPromise(enqueueCodexBrowserSessionCleanup(repository, lock, "account-b"));

    await expect(
      Effect.runPromise(
        drainPendingBrowserSessionCleanups(
          repository,
          lock,
          adapter((target) => {
            calls.push(target.accountId);
            return target.accountId === "account-a"
              ? Effect.fail(new InfrastructureError("partition", "partition busy"))
              : Effect.void;
          }),
        ),
      ),
    ).rejects.toMatchObject({ operation: "clean browser session" });

    expect(calls).toEqual(["account-a", "account-b"]);
    expect(pendingBrowserSessionCleanupTargets(repository.current)).toEqual([
      { providerId: "codex", accountId: "account-a" },
    ]);
  });

  it("does not rewrite config when the same cleanup is already queued", async () => {
    const repository = memoryRepository(configWithCodexAccounts(["account-a"]));
    const lock = memoryLock();
    await Effect.runPromise(enqueueCodexBrowserSessionCleanup(repository, lock, "account-a"));
    await Effect.runPromise(enqueueCodexBrowserSessionCleanup(repository, lock, "account-a"));
    expect(repository.saves).toHaveLength(1);
  });
});
