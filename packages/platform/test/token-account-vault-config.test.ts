import { describe, expect, it } from "vite-plus/test";
import { Effect, Fiber, Semaphore } from "effect";
import {
  InfrastructureError,
  makeTokenAccountRosterService,
  sha256Hex,
  type ConfigRepositoryService,
  type CredentialStoreService,
  type PersistedCodexBarConfig,
  type TokenAccountSupport,
} from "@codexbar/core";
import type { ProviderId } from "@codexbar/contracts";
import {
  addCodexTokenAccountCredentialToVault,
  makeTokenAccountVaultConfigRepository,
  resolveSelectedFirstPartyAccountFromVault,
  tokenAccountVaultKey,
  type TokenAccountMigrationLock,
} from "../src/token-account-vault-config.ts";

const v1Config = (
  accounts: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly token: string;
    readonly addedAt: number;
    readonly lastUsed?: number;
    readonly externalIdentifier?: string;
    readonly usageScope?: string;
    readonly organizationId?: string;
    readonly workspaceID?: string;
  }>,
  activeIndex = 0,
): PersistedCodexBarConfig => ({
  version: 1,
  providers: [
    {
      id: "claude",
      enabled: true,
      extensions: { retained: true },
      tokenAccounts: {
        version: 1,
        activeIndex,
        accounts,
      },
    },
    { id: "codex", enabled: true, extensions: {} },
  ],
});

const v2CodexConfig = (
  accounts: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly addedAt: number;
  }> = [],
  activeIndex = 0,
): PersistedCodexBarConfig => ({
  version: 1,
  providers: [
    {
      id: "codex",
      enabled: true,
      extensions: {},
      ...(accounts.length === 0
        ? {}
        : {
            tokenAccounts: {
              version: 2,
              activeIndex,
              accounts,
            },
          }),
    },
  ],
});

const memoryRepository = (
  initial: PersistedCodexBarConfig | undefined,
  failSave = false,
): ConfigRepositoryService & {
  readonly saves: PersistedCodexBarConfig[];
  current: PersistedCodexBarConfig | undefined;
} => {
  const repository: ConfigRepositoryService & {
    readonly saves: PersistedCodexBarConfig[];
    current: PersistedCodexBarConfig | undefined;
  } = {
    current: initial,
    saves: [] as PersistedCodexBarConfig[],
    load: Effect.sync(() => repository.current),
    save: (config: PersistedCodexBarConfig) =>
      failSave
        ? Effect.fail(new InfrastructureError("save", "save failed"))
        : Effect.sync(() => {
            repository.saves.push(config);
            repository.current = config;
          }),
    modify: (mutation) =>
      Effect.gen(function* () {
        const result = yield* mutation(repository.current);
        if (failSave) return yield* Effect.fail(new InfrastructureError("save", "save failed"));
        repository.saves.push(result.config);
        repository.current = result.config;
        return result;
      }),
  };
  return repository;
};

const memoryCredentials = (
  initial: Readonly<Record<string, string>> = {},
  options: {
    readonly failRead?: boolean;
    readonly failWrite?: boolean;
    readonly failRemove?: boolean;
    readonly retainAfterRemove?: boolean;
    readonly corruptReadback?: boolean;
  } = {},
): CredentialStoreService & {
  readonly values: Map<string, string>;
  readonly reads: string[];
  readonly writes: Array<{ readonly key: string; readonly value: string }>;
  readonly removes: string[];
} => {
  const values = new Map(Object.entries(initial));
  const reads: string[] = [];
  const writes: Array<{ readonly key: string; readonly value: string }> = [];
  const removes: string[] = [];
  let writeHappened = false;
  return {
    values,
    reads,
    writes,
    removes,
    read: (key) =>
      options.failRead
        ? Effect.fail(new InfrastructureError("read", "read failed"))
        : Effect.sync(() => {
            reads.push(key);
            if (options.corruptReadback === true && writeHappened) return "different";
            return values.get(key);
          }),
    write: (key, value) =>
      options.failWrite
        ? Effect.fail(new InfrastructureError("write", "write failed"))
        : Effect.sync(() => {
            writes.push({ key, value });
            values.set(key, value);
            writeHappened = true;
          }),
    remove: (key) =>
      options.failRemove
        ? Effect.fail(new InfrastructureError("remove", "remove failed"))
        : Effect.sync(() => {
            removes.push(key);
            if (options.retainAfterRemove !== true) values.delete(key);
          }),
  };
};

const memoryLock = (
  onAcquire: (() => void) | undefined = undefined,
): TokenAccountMigrationLock & {
  readonly events: string[];
  readonly acquisitions: () => number;
  readonly releases: () => number;
  readonly isHeld: () => boolean;
} => {
  const events: string[] = [];
  let acquisitions = 0;
  let releases = 0;
  let held = false;
  const semaphore = Semaphore.makeUnsafe(1);
  return {
    events,
    acquisitions: () => acquisitions,
    releases: () => releases,
    isHeld: () => held,
    runExclusive: (operation) =>
      semaphore.withPermits(1)(
        Effect.acquireUseRelease(
          Effect.sync(() => {
            events.push("acquire");
            acquisitions += 1;
            held = true;
            onAcquire?.();
          }),
          () => operation,
          () =>
            Effect.sync(() => {
              events.push("release");
              releases += 1;
              held = false;
            }),
        ),
      ),
  };
};

const vaultRepository = (
  repository: ConfigRepositoryService,
  credentials: CredentialStoreService,
  lock = memoryLock(),
): ConfigRepositoryService => makeTokenAccountVaultConfigRepository(repository, credentials, lock);

describe("token-account vault config repository", () => {
  it("migrates v1 token accounts into the vault and preserves v2 metadata", async () => {
    const input = v1Config(
      [
        {
          id: "account-1",
          label: "Main",
          token: "secret-1",
          addedAt: 10,
          lastUsed: 20,
          externalIdentifier: "external",
          usageScope: "scope",
          organizationId: "organization",
          workspaceID: "workspace",
        },
        { id: "account-2", label: "Second", token: "secret-2", addedAt: 30 },
      ],
      9,
    );
    const repository = memoryRepository(input);
    const credentials = memoryCredentials();

    const loaded = await Effect.runPromise(vaultRepository(repository, credentials).load);

    expect(credentials.values.get(tokenAccountVaultKey("claude", "account-1"))).toBe("secret-1");
    expect(credentials.values.get(tokenAccountVaultKey("claude", "account-2"))).toBe("secret-2");
    expect(repository.saves).toHaveLength(1);
    expect(loaded?.providers[0]).toEqual({
      id: "claude",
      enabled: true,
      extensions: { retained: true },
      tokenAccounts: {
        version: 2,
        activeIndex: 9,
        accounts: [
          {
            id: "account-1",
            label: "Main",
            addedAt: 10,
            lastUsed: 20,
            externalIdentifier: "external",
            usageScope: "scope",
            organizationId: "organization",
            workspaceID: "workspace",
          },
          { id: "account-2", label: "Second", addedAt: 30 },
        ],
      },
    });
  });

  it("migrates an empty v1 roster to v2", async () => {
    const repository = memoryRepository(v1Config([], 3));
    const credentials = memoryCredentials();
    const loaded = await Effect.runPromise(vaultRepository(repository, credentials).load);
    expect(loaded?.providers[0]?.tokenAccounts).toEqual({
      version: 2,
      activeIndex: 3,
      accounts: [],
    });
    expect(repository.saves).toHaveLength(1);
  });

  it("accepts same-secret idempotence without rewriting vault material", async () => {
    const key = tokenAccountVaultKey("claude", "account-1");
    const repository = memoryRepository(
      v1Config([{ id: "account-1", label: "Main", token: "same", addedAt: 0 }]),
    );
    const credentials = memoryCredentials({ [key]: "same" });
    await Effect.runPromise(vaultRepository(repository, credentials).load);
    expect(credentials.writes).toEqual([]);
    expect(repository.saves[0]?.providers[0]?.tokenAccounts?.version).toBe(2);
  });

  it("preflights duplicate derived keys before touching the vault", async () => {
    const repository = memoryRepository(
      v1Config([
        { id: "account-1", label: "First", token: "first", addedAt: 0 },
        { id: "account-1", label: "Second", token: "second", addedAt: 1 },
      ]),
    );
    const credentials = memoryCredentials();
    await expect(
      Effect.runPromise(vaultRepository(repository, credentials).load),
    ).rejects.toBeInstanceOf(InfrastructureError);
    expect(credentials.reads).toEqual([]);
    expect(credentials.writes).toEqual([]);
    expect(repository.saves).toEqual([]);
  });

  it("fails without overwriting or saving when an existing vault secret differs", async () => {
    const key = tokenAccountVaultKey("claude", "account-1");
    const repository = memoryRepository(
      v1Config([{ id: "account-1", label: "Main", token: "legacy", addedAt: 0 }]),
    );
    const credentials = memoryCredentials({ [key]: "different" });
    await expect(
      Effect.runPromise(vaultRepository(repository, credentials).load),
    ).rejects.toBeInstanceOf(InfrastructureError);
    expect(credentials.values.get(key)).toBe("different");
    expect(credentials.writes).toEqual([]);
    expect(repository.saves).toEqual([]);
  });

  it("preflights every existing value before writing a missing credential", async () => {
    const conflictingKey = tokenAccountVaultKey("claude", "account-2");
    const repository = memoryRepository(
      v1Config([
        { id: "account-1", label: "Missing", token: "first", addedAt: 0 },
        { id: "account-2", label: "Conflict", token: "second", addedAt: 1 },
      ]),
    );
    const credentials = memoryCredentials({ [conflictingKey]: "different" });

    await expect(
      Effect.runPromise(vaultRepository(repository, credentials).load),
    ).rejects.toBeInstanceOf(InfrastructureError);
    expect(credentials.writes).toEqual([]);
    expect(repository.saves).toEqual([]);
  });

  it("rejects plugin token-account migration before reading or writing the vault", async () => {
    const input = v1Config([{ id: "account-1", label: "Main", token: "secret", addedAt: 0 }]);
    const pluginConfig: PersistedCodexBarConfig = {
      ...input,
      providers: [{ ...input.providers[0]!, id: "user-plugin" }],
    };
    const repository = memoryRepository(pluginConfig);
    const credentials = memoryCredentials();

    await expect(
      Effect.runPromise(vaultRepository(repository, credentials).load),
    ).rejects.toBeInstanceOf(InfrastructureError);
    expect(credentials.reads).toEqual([]);
    expect(credentials.writes).toEqual([]);
    expect(repository.saves).toEqual([]);
  });

  it("propagates write, readback, and save failures without saving v2 config", async () => {
    for (const credentials of [
      memoryCredentials({}, { failWrite: true }),
      memoryCredentials({}, { corruptReadback: true }),
    ]) {
      const repository = memoryRepository(
        v1Config([{ id: "account-1", label: "Main", token: "legacy", addedAt: 0 }]),
      );
      await expect(
        Effect.runPromise(vaultRepository(repository, credentials).load),
      ).rejects.toBeInstanceOf(InfrastructureError);
      expect(repository.saves).toEqual([]);
    }

    const repository = memoryRepository(
      v1Config([{ id: "account-1", label: "Main", token: "legacy", addedAt: 0 }]),
      true,
    );
    await expect(
      Effect.runPromise(vaultRepository(repository, memoryCredentials()).load),
    ).rejects.toBeInstanceOf(InfrastructureError);
    expect(repository.current?.providers[0]?.tokenAccounts?.version).toBe(1);
  });

  it("can retry after a simulated crash between vault write and v2 config save", async () => {
    const input = v1Config([{ id: "account-1", label: "Main", token: "legacy", addedAt: 0 }]);
    const key = tokenAccountVaultKey("claude", "account-1");
    const crashingRepository = memoryRepository(input, true);
    const credentials = memoryCredentials();
    await expect(
      Effect.runPromise(vaultRepository(crashingRepository, credentials).load),
    ).rejects.toBeInstanceOf(InfrastructureError);
    expect(credentials.values.get(key)).toBe("legacy");
    expect(crashingRepository.current?.providers[0]?.tokenAccounts?.version).toBe(1);

    const retryRepository = memoryRepository(input);
    const loaded = await Effect.runPromise(vaultRepository(retryRepository, credentials).load);
    expect(loaded?.providers[0]?.tokenAccounts?.version).toBe(2);
    expect(credentials.writes).toHaveLength(1);
  });

  it("reloads after acquiring the migration lock and skips vault writes when a follower sees v2", async () => {
    const legacy = v1Config([{ id: "account-1", label: "Main", token: "legacy", addedAt: 0 }]);
    const migrated: PersistedCodexBarConfig = {
      ...legacy,
      providers: legacy.providers.map((provider) =>
        provider.tokenAccounts?.version !== 1
          ? provider
          : {
              ...provider,
              tokenAccounts: {
                version: 2,
                activeIndex: provider.tokenAccounts.activeIndex,
                accounts: provider.tokenAccounts.accounts.map(
                  ({ token: _token, ...account }) => account,
                ),
              },
            },
      ),
    };
    const events: string[] = [];
    let loads = 0;
    const repository: ConfigRepositoryService & {
      readonly saves: PersistedCodexBarConfig[];
    } = {
      saves: [],
      load: Effect.sync(() => {
        loads += 1;
        events.push(`load:${loads}`);
        return loads === 1 ? legacy : migrated;
      }),
      save: (config) =>
        Effect.sync(() => {
          repository.saves.push(config);
          events.push("save");
        }),
      modify: (mutation) =>
        Effect.gen(function* () {
          const result = yield* mutation(loads === 0 ? legacy : migrated);
          repository.saves.push(result.config);
          events.push("save");
          return result;
        }),
    };
    const credentials = memoryCredentials();
    const lock = memoryLock(() => events.push("lock"));

    const loaded = await Effect.runPromise(vaultRepository(repository, credentials, lock).load);

    expect(loaded?.providers[0]?.tokenAccounts?.version).toBe(2);
    expect(events).toEqual(["load:1", "lock", "load:2"]);
    expect(lock.events).toEqual(["acquire", "release"]);
    expect(credentials.reads).toEqual([]);
    expect(credentials.writes).toEqual([]);
    expect(repository.saves).toEqual([]);
  });

  it("releases the migration lock after typed migration failure", async () => {
    const repository = memoryRepository(
      v1Config([{ id: "account-1", label: "Main", token: "legacy", addedAt: 0 }]),
    );
    const lock = memoryLock();

    await expect(
      Effect.runPromise(
        vaultRepository(repository, memoryCredentials({}, { failRead: true }), lock).load,
      ),
    ).rejects.toBeInstanceOf(InfrastructureError);

    expect(lock.acquisitions()).toBe(1);
    expect(lock.releases()).toBe(1);
    expect(lock.isHeld()).toBe(false);
  });

  it("releases the migration lock after interruption", async () => {
    const repository = memoryRepository(
      v1Config([{ id: "account-1", label: "Main", token: "legacy", addedAt: 0 }]),
    );
    let enteredRead: (() => void) | undefined;
    const readEntered = new Promise<void>((resolve) => {
      enteredRead = resolve;
    });
    const credentials: CredentialStoreService = {
      read: () => Effect.sync(() => enteredRead?.()).pipe(Effect.andThen(Effect.never)),
      write: () => Effect.void,
      remove: () => Effect.void,
    };
    const lock = memoryLock();

    const fiber = Effect.runFork(vaultRepository(repository, credentials, lock).load);
    await readEntered;
    await Effect.runPromise(Fiber.interrupt(fiber));

    expect(lock.acquisitions()).toBe(1);
    expect(lock.releases()).toBe(1);
    expect(lock.isHeld()).toBe(false);
  });

  it("rejects wrapper saves that contain v1 or token-bearing account input", async () => {
    const repository = memoryRepository(undefined);
    const wrapper = vaultRepository(repository, memoryCredentials());
    await expect(
      Effect.runPromise(
        wrapper.save(v1Config([{ id: "account-1", label: "Main", token: "legacy", addedAt: 0 }])),
      ),
    ).rejects.toBeInstanceOf(InfrastructureError);
    await expect(
      Effect.runPromise(
        wrapper.save({
          version: 1,
          providers: [
            {
              id: "claude",
              extensions: {},
              tokenAccounts: {
                version: 2,
                activeIndex: 0,
                accounts: [
                  { id: "account-1", label: "Main", token: "legacy", addedAt: 0 } as never,
                ],
              },
            },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(InfrastructureError);
    expect(repository.saves).toEqual([]);
  });

  it("rejects duplicate v2 account IDs on load before any credential read", async () => {
    const legacy = v1Config([
      { id: "duplicate", label: "First", token: "one", addedAt: 0 },
      { id: "duplicate", label: "Second", token: "two", addedAt: 1 },
    ]);
    const duplicateV2: PersistedCodexBarConfig = {
      ...legacy,
      providers: legacy.providers.map((provider) =>
        provider.tokenAccounts === undefined
          ? provider
          : {
              ...provider,
              tokenAccounts: {
                version: 2,
                activeIndex: 0,
                accounts: provider.tokenAccounts.accounts.map(
                  ({ token: _token, ...account }) => account,
                ),
              },
            },
      ),
    };
    const repository = memoryRepository(duplicateV2);
    const credentials = memoryCredentials();

    await expect(
      Effect.runPromise(vaultRepository(repository, credentials).load),
    ).rejects.toMatchObject({ operation: "validate token accounts" });
    expect(credentials.reads).toEqual([]);
    expect(repository.saves).toEqual([]);
  });

  it("modifies a v1 config under the held lock without reacquiring it", async () => {
    const input = v1Config([{ id: "account-1", label: "Main", token: "legacy", addedAt: 0 }]);
    const repository = memoryRepository(input);
    const credentials = memoryCredentials();
    const lock = memoryLock();
    const wrapped = vaultRepository(repository, credentials, lock);

    const result = await Effect.runPromise(
      wrapped.modify((current) =>
        Effect.succeed({
          config: {
            ...current!,
            sessionQuotaNotificationsEnabled: false,
          },
          value: current?.providers[0]?.tokenAccounts?.version,
        }),
      ),
    );

    expect(result.value).toBe(2);
    expect(result.config.sessionQuotaNotificationsEnabled).toBe(false);
    expect(repository.current?.providers[0]?.tokenAccounts?.version).toBe(2);
    expect(lock.acquisitions()).toBe(1);
    expect(lock.releases()).toBe(1);
  });

  it("serializes concurrent modifies so both fresh changes persist", async () => {
    const input = v1Config([{ id: "account-1", label: "Main", token: "legacy", addedAt: 0 }]);
    const repository = memoryRepository(input);
    const credentials = memoryCredentials();
    const wrapped = vaultRepository(repository, credentials, memoryLock());

    await Promise.all([
      Effect.runPromise(
        wrapped.modify((current) =>
          Effect.succeed({
            config: {
              ...current!,
              providers: current!.providers.map((provider) =>
                provider.id === "claude" ? { ...provider, enabled: false } : provider,
              ),
            },
            value: undefined,
          }),
        ),
      ),
      Effect.runPromise(
        wrapped.modify((current) =>
          Effect.succeed({
            config: { ...current!, sessionQuotaNotificationsEnabled: false },
            value: undefined,
          }),
        ),
      ),
    ]);

    const saved = repository.current;
    expect(saved?.providers.find((provider) => provider.id === "claude")?.enabled).toBe(false);
    expect(saved?.sessionQuotaNotificationsEnabled).toBe(false);
    expect(saved?.providers[0]?.tokenAccounts?.version).toBe(2);
  });

  it("adds a Codex credential through the host vault lifecycle and selects it", async () => {
    const repository = memoryRepository(v2CodexConfig());
    const credentials = memoryCredentials();
    const lock = memoryLock();
    const credentialJson = JSON.stringify({ tokens: { access_token: "selected-oauth" } });

    const saved = await Effect.runPromise(
      addCodexTokenAccountCredentialToVault(repository, credentials, lock, {
        accountId: "codex-account",
        label: "  Personal  ",
        credentialJson,
        addedAt: 42,
      }),
    );

    expect(lock.events).toEqual(["acquire", "release"]);
    expect(credentials.writes).toEqual([
      { key: tokenAccountVaultKey("codex", "codex-account"), value: credentialJson },
    ]);
    expect(saved.providers[0]?.tokenAccounts).toEqual({
      version: 2,
      activeIndex: 0,
      accounts: [{ id: "codex-account", label: "Personal", addedAt: 42 }],
    });
    await expect(
      Effect.runPromise(resolveSelectedFirstPartyAccountFromVault(saved, credentials, "codex")),
    ).resolves.toMatchObject({
      id: "codex-account",
      secureSettings: { CODEX_ACCESS_TOKEN: "selected-oauth" },
    });
  });

  it("does not touch the vault when staging the Codex addition fails", async () => {
    const repository = memoryRepository(v2CodexConfig(), true);
    const credentials = memoryCredentials();

    await expect(
      Effect.runPromise(
        addCodexTokenAccountCredentialToVault(repository, credentials, memoryLock(), {
          accountId: "codex-account",
          label: "Personal",
          credentialJson: JSON.stringify({ tokens: { access_token: "selected-oauth" } }),
          addedAt: 1,
        }),
      ),
    ).rejects.toMatchObject({ operation: "stage token account addition" });

    expect(credentials.writes).toEqual([]);
    expect(credentials.removes).toEqual([]);
    expect(repository.current?.providers[0]?.tokenAccounts).toBeUndefined();
  });

  it("does not overwrite a divergent orphaned Codex credential", async () => {
    const key = tokenAccountVaultKey("codex", "codex-account");
    const repository = memoryRepository(v2CodexConfig());
    const credentials = memoryCredentials({ [key]: "different" });

    await expect(
      Effect.runPromise(
        addCodexTokenAccountCredentialToVault(repository, credentials, memoryLock(), {
          accountId: "codex-account",
          label: "Personal",
          credentialJson: JSON.stringify({ tokens: { access_token: "selected-oauth" } }),
          addedAt: 1,
        }),
      ),
    ).rejects.toMatchObject({ operation: "add token account" });

    expect(credentials.values.get(key)).toBe("different");
    expect(credentials.writes).toEqual([]);
    expect(repository.saves).toEqual([]);
  });

  it("recovers staged Codex metadata after the credential write", async () => {
    const key = tokenAccountVaultKey("codex", "codex-account");
    const credentialJson = JSON.stringify({ tokens: { access_token: "selected-oauth" } });
    const staged: PersistedCodexBarConfig = {
      ...v2CodexConfig(),
      providers: [
        {
          id: "codex",
          enabled: true,
          extensions: {},
          pendingTokenAccountAddition: {
            version: 1,
            account: { id: "codex-account", label: "Account 1", addedAt: 1 },
            credentialSha256: sha256Hex(credentialJson),
            makeActive: true,
          },
        },
      ],
    };
    const repository = memoryRepository(staged);
    const credentials = memoryCredentials({ [key]: credentialJson });
    const wrapped = vaultRepository(repository, credentials);

    const saved = await Effect.runPromise(wrapped.load);

    expect(credentials.writes).toEqual([]);
    expect(credentials.removes).toEqual([]);
    expect(saved?.providers[0]?.pendingTokenAccountAddition).toBeUndefined();
    expect(saved?.providers[0]?.tokenAccounts?.accounts).toEqual([
      { id: "codex-account", label: "Account 1", addedAt: 1 },
    ]);
  });

  it("discards an unpublished Codex addition when recovery finds no credential", async () => {
    const credentialJson = JSON.stringify({ tokens: { access_token: "selected-oauth" } });
    const staged: PersistedCodexBarConfig = {
      ...v2CodexConfig(),
      providers: [
        {
          id: "codex",
          enabled: true,
          extensions: {},
          pendingTokenAccountAddition: {
            version: 1,
            account: { id: "codex-account", label: "Account 1", addedAt: 1 },
            credentialSha256: sha256Hex(credentialJson),
            makeActive: true,
          },
        },
      ],
    };
    const repository = memoryRepository(staged);

    const recovered = await Effect.runPromise(
      vaultRepository(repository, memoryCredentials()).load,
    );

    expect(recovered?.providers[0]?.pendingTokenAccountAddition).toBeUndefined();
    expect(recovered?.providers[0]?.tokenAccounts).toBeUndefined();
  });

  it("keeps the Codex addition marker when final publication fails and recovers later", async () => {
    const underlying = memoryRepository(v2CodexConfig());
    let saveCount = 0;
    let failFinalSave = true;
    const repository: ConfigRepositoryService = {
      load: underlying.load,
      save: (config) => {
        saveCount += 1;
        return failFinalSave && saveCount === 2
          ? Effect.fail(new InfrastructureError("save", "final save failed"))
          : underlying.save(config);
      },
      modify: underlying.modify,
    };
    const credentialJson = JSON.stringify({ tokens: { access_token: "selected-oauth" } });
    const credentials = memoryCredentials();

    await expect(
      Effect.runPromise(
        addCodexTokenAccountCredentialToVault(repository, credentials, memoryLock(), {
          accountId: "codex-account",
          label: "Personal",
          credentialJson,
          addedAt: 1,
        }),
      ),
    ).rejects.toMatchObject({ operation: "save token account addition recovery" });

    expect(underlying.current?.providers[0]?.pendingTokenAccountAddition).toMatchObject({
      version: 1,
      account: { id: "codex-account" },
    });
    expect(credentials.values.get(tokenAccountVaultKey("codex", "codex-account"))).toBe(
      credentialJson,
    );

    failFinalSave = false;
    const recovered = await Effect.runPromise(
      makeTokenAccountVaultConfigRepository(repository, credentials, memoryLock()).load,
    );

    expect(recovered?.providers[0]?.pendingTokenAccountAddition).toBeUndefined();
    expect(recovered?.providers[0]?.tokenAccounts?.accounts).toEqual([
      { id: "codex-account", label: "Personal", addedAt: 1 },
    ]);
  });

  it("stages metadata removal before deleting and verifying the native credential", async () => {
    const input = v1Config([
      { id: "account-1", label: "Main", token: "secret-1", addedAt: 0 },
      { id: "account-2", label: "Second", token: "secret-2", addedAt: 1 },
    ]);
    const repository = memoryRepository(input);
    const credentials = memoryCredentials();
    const wrapped = vaultRepository(repository, credentials);
    await Effect.runPromise(wrapped.load);
    repository.saves.length = 0;

    const result = await Effect.runPromise(
      wrapped.modify((current) => {
        const next: PersistedCodexBarConfig = {
          ...current!,
          providers: current!.providers.map((provider) =>
            provider.id === "claude" && provider.tokenAccounts !== undefined
              ? {
                  ...provider,
                  tokenAccounts: {
                    version: 2,
                    activeIndex: 0,
                    accounts: provider.tokenAccounts.accounts.filter(
                      (account) => account.id !== "account-1",
                    ),
                  },
                }
              : provider,
          ),
        };
        return Effect.succeed({ config: next, value: "removed" });
      }),
    );

    expect(result.value).toBe("removed");
    expect(repository.saves).toHaveLength(2);
    expect(repository.saves[0]?.providers[0]).toMatchObject({
      pendingTokenAccountDeletion: { version: 1, accountId: "account-1" },
      tokenAccounts: { accounts: [{ id: "account-2" }] },
    });
    expect(repository.saves[1]?.providers[0]?.pendingTokenAccountDeletion).toBeUndefined();
    expect(credentials.removes).toEqual([tokenAccountVaultKey("claude", "account-1")]);
    expect(credentials.values.has(tokenAccountVaultKey("claude", "account-1"))).toBe(false);
    expect(credentials.values.get(tokenAccountVaultKey("claude", "account-2"))).toBe("secret-2");
  });

  it("integrates revision-CAS roster removal with the vault deletion transaction", async () => {
    const input = v1Config([
      { id: "account-1", label: "Main", token: "secret-1", addedAt: 0 },
      { id: "account-2", label: "Second", token: "secret-2", addedAt: 1 },
    ]);
    const repository = memoryRepository(input);
    const credentials = memoryCredentials();
    const config = vaultRepository(repository, credentials);
    const accounts = makeTokenAccountRosterService({
      config,
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
      ]),
    });
    const before = await Effect.runPromise(accounts.list("claude"));
    const after = await Effect.runPromise(
      accounts.remove({
        provider: "claude",
        accountId: "account-1",
        expectedRevision: before.revision,
      }),
    );

    expect(after.accounts.map((account) => account.id)).toEqual(["account-2"]);
    expect(after.activeIndex).toBe(0);
    expect(after.revision).not.toBe(before.revision);
    expect(credentials.removes).toEqual([tokenAccountVaultKey("claude", "account-1")]);
    expect(repository.current?.providers[0]?.pendingTokenAccountDeletion).toBeUndefined();
    expect(repository.current?.providers[0]?.tokenAccounts).toMatchObject({
      version: 2,
      activeIndex: 0,
      accounts: [{ id: "account-2" }],
    });
  });

  it("keeps a tombstone after keyring failure and recovers idempotently on next load", async () => {
    const key = tokenAccountVaultKey("claude", "account-1");
    const input = v1Config([{ id: "account-1", label: "Main", token: "secret-1", addedAt: 0 }]);
    const repository = memoryRepository(input);
    const migrationCredentials = memoryCredentials();
    await Effect.runPromise(vaultRepository(repository, migrationCredentials).load);
    repository.saves.length = 0;

    const failingCredentials = memoryCredentials({ [key]: "secret-1" }, { failRemove: true });
    await expect(
      Effect.runPromise(
        vaultRepository(repository, failingCredentials).modify((current) => {
          const provider = current!.providers.find((entry) => entry.id === "claude")!;
          const { tokenAccounts: _accounts, ...withoutAccounts } = provider;
          return Effect.succeed({
            config: {
              ...current!,
              providers: current!.providers.map((entry) =>
                entry.id === "claude" ? withoutAccounts : entry,
              ),
            },
            value: undefined,
          });
        }),
      ),
    ).rejects.toMatchObject({ operation: "remove token account credential" });
    expect(repository.current?.providers[0]).toMatchObject({
      pendingTokenAccountDeletion: { version: 1, accountId: "account-1" },
    });
    expect(repository.current?.providers[0]?.tokenAccounts).toBeUndefined();

    const recoveredCredentials = memoryCredentials({ [key]: "secret-1" });
    const recovered = await Effect.runPromise(
      vaultRepository(repository, recoveredCredentials).load,
    );
    expect(recoveredCredentials.removes).toEqual([key]);
    expect(recoveredCredentials.values.has(key)).toBe(false);
    expect(recovered?.providers[0]?.pendingTokenAccountDeletion).toBeUndefined();
    expect(repository.current?.providers[0]?.pendingTokenAccountDeletion).toBeUndefined();
  });

  it("does not touch the keyring when the deletion-staging save fails", async () => {
    const key = tokenAccountVaultKey("claude", "account-1");
    const underlying = memoryRepository(
      v1Config([{ id: "account-1", label: "Main", token: "secret-1", addedAt: 0 }]),
    );
    await Effect.runPromise(vaultRepository(underlying, memoryCredentials()).load);
    underlying.saves.length = 0;
    const before = underlying.current;
    const failStagingSave: ConfigRepositoryService = {
      load: underlying.load,
      save: () => Effect.fail(new InfrastructureError("save", "staging save failed")),
      modify: underlying.modify,
    };
    const credentials = memoryCredentials({ [key]: "secret-1" });

    await expect(
      Effect.runPromise(
        vaultRepository(failStagingSave, credentials).modify((current) => {
          const provider = current!.providers.find((entry) => entry.id === "claude")!;
          const { tokenAccounts: _accounts, ...withoutAccounts } = provider;
          return Effect.succeed({
            config: {
              ...current!,
              providers: current!.providers.map((entry) =>
                entry.id === "claude" ? withoutAccounts : entry,
              ),
            },
            value: undefined,
          });
        }),
      ),
    ).rejects.toMatchObject({ operation: "stage token account deletion" });
    expect(underlying.current).toBe(before);
    expect(underlying.current?.providers[0]?.tokenAccounts?.accounts).toHaveLength(1);
    expect(underlying.current?.providers[0]?.pendingTokenAccountDeletion).toBeUndefined();
    expect(credentials.removes).toEqual([]);
    expect(credentials.reads).toEqual([]);
  });

  it("retains recovery intent when keyring readback still exposes the credential", async () => {
    const key = tokenAccountVaultKey("claude", "account-1");
    const input = v1Config([{ id: "account-1", label: "Main", token: "secret-1", addedAt: 0 }]);
    const repository = memoryRepository(input);
    await Effect.runPromise(vaultRepository(repository, memoryCredentials()).load);
    repository.saves.length = 0;
    const credentials = memoryCredentials({ [key]: "secret-1" }, { retainAfterRemove: true });

    await expect(
      Effect.runPromise(
        vaultRepository(repository, credentials).modify((current) => {
          const provider = current!.providers.find((entry) => entry.id === "claude")!;
          const { tokenAccounts: _accounts, ...withoutAccounts } = provider;
          return Effect.succeed({
            config: {
              ...current!,
              providers: current!.providers.map((entry) =>
                entry.id === "claude" ? withoutAccounts : entry,
              ),
            },
            value: undefined,
          });
        }),
      ),
    ).rejects.toMatchObject({ operation: "verify token account credential removal" });
    expect(credentials.removes).toEqual([key]);
    expect(repository.current?.providers[0]?.pendingTokenAccountDeletion).toEqual({
      version: 1,
      accountId: "account-1",
    });
  });

  it("recovers when the final marker-clear save fails after credential deletion", async () => {
    const key = tokenAccountVaultKey("claude", "account-1");
    const underlying = memoryRepository(
      v1Config([{ id: "account-1", label: "Main", token: "secret-1", addedAt: 0 }]),
    );
    const migrationCredentials = memoryCredentials();
    await Effect.runPromise(vaultRepository(underlying, migrationCredentials).load);
    underlying.saves.length = 0;
    let saveCount = 0;
    const failFinalSave: ConfigRepositoryService = {
      load: underlying.load,
      save: (config) => {
        saveCount += 1;
        return saveCount === 2
          ? Effect.fail(new InfrastructureError("save", "final save failed"))
          : underlying.save(config);
      },
      modify: underlying.modify,
    };
    const credentials = memoryCredentials({ [key]: "secret-1" });

    await expect(
      Effect.runPromise(
        vaultRepository(failFinalSave, credentials).modify((current) => {
          const provider = current!.providers.find((entry) => entry.id === "claude")!;
          const { tokenAccounts: _accounts, ...withoutAccounts } = provider;
          return Effect.succeed({
            config: {
              ...current!,
              providers: current!.providers.map((entry) =>
                entry.id === "claude" ? withoutAccounts : entry,
              ),
            },
            value: undefined,
          });
        }),
      ),
    ).rejects.toMatchObject({ operation: "save token account deletion recovery" });
    expect(credentials.values.has(key)).toBe(false);
    expect(underlying.current?.providers[0]?.pendingTokenAccountDeletion).toEqual({
      version: 1,
      accountId: "account-1",
    });

    const recovered = await Effect.runPromise(vaultRepository(underlying, credentials).load);
    expect(credentials.removes).toEqual([key, key]);
    expect(recovered?.providers[0]?.pendingTokenAccountDeletion).toBeUndefined();
  });

  it("rejects metadata additions and blind roster replacement before config save", async () => {
    const repository = memoryRepository(v1Config([]));
    const credentials = memoryCredentials();
    const wrapped = vaultRepository(repository, credentials);
    await Effect.runPromise(wrapped.load);
    repository.saves.length = 0;
    const current = repository.current!;
    const withAccount: PersistedCodexBarConfig = {
      ...current,
      providers: current.providers.map((provider) =>
        provider.id === "claude"
          ? {
              ...provider,
              tokenAccounts: {
                version: 2,
                activeIndex: 0,
                accounts: [{ id: "new", label: "New", addedAt: 1 }],
              },
            }
          : provider,
      ),
    };
    await expect(
      Effect.runPromise(
        wrapped.modify(() => Effect.succeed({ config: withAccount, value: undefined })),
      ),
    ).rejects.toMatchObject({ operation: "add token account" });
    await expect(Effect.runPromise(wrapped.save(withAccount))).rejects.toMatchObject({
      operation: "save config",
    });
    expect(repository.saves).toEqual([]);
    expect(credentials.writes).toEqual([]);
  });

  it("prevents a stale full-document save from clearing or reversing pending deletion", async () => {
    const key = tokenAccountVaultKey("claude", "account-1");
    const repository = memoryRepository(
      v1Config([{ id: "account-1", label: "Main", token: "secret-1", addedAt: 0 }]),
    );
    const migrationCredentials = memoryCredentials();
    const first = vaultRepository(repository, migrationCredentials);
    const stale = (await Effect.runPromise(first.load))!;
    repository.saves.length = 0;
    const failingCredentials = memoryCredentials({ [key]: "secret-1" }, { failRemove: true });
    const failing = vaultRepository(repository, failingCredentials);

    await expect(
      Effect.runPromise(
        failing.modify((current) => {
          const provider = current!.providers.find((entry) => entry.id === "claude")!;
          const { tokenAccounts: _accounts, ...withoutAccounts } = provider;
          return Effect.succeed({
            config: {
              ...current!,
              providers: current!.providers.map((entry) =>
                entry.id === "claude" ? withoutAccounts : entry,
              ),
            },
            value: undefined,
          });
        }),
      ),
    ).rejects.toMatchObject({ operation: "remove token account credential" });
    const saveCountWithPending = repository.saves.length;
    await expect(Effect.runPromise(failing.save(stale))).rejects.toMatchObject({
      operation: "remove token account credential",
    });
    expect(repository.saves).toHaveLength(saveCountWithPending);
    expect(repository.current?.providers[0]?.pendingTokenAccountDeletion).toEqual({
      version: 1,
      accountId: "account-1",
    });

    const recoveredCredentials = memoryCredentials({ [key]: "secret-1" });
    const recovered = vaultRepository(repository, recoveredCredentials);
    await Effect.runPromise(recovered.load);
    const saveCountAfterRecovery = repository.saves.length;
    await expect(Effect.runPromise(recovered.save(stale))).rejects.toMatchObject({
      operation: "save config",
    });
    expect(repository.saves).toHaveLength(saveCountAfterRecovery);
    expect(repository.current?.providers[0]?.tokenAccounts).toBeUndefined();
  });

  it("serializes valid full-document saves and preserves an unchanged roster", async () => {
    const repository = memoryRepository(v1Config([]));
    const credentials = memoryCredentials();
    const lock = memoryLock();
    const wrapped = vaultRepository(repository, credentials, lock);
    const current = await Effect.runPromise(wrapped.load);
    const acquisitionsBeforeSave = lock.acquisitions();
    await Effect.runPromise(wrapped.save({ ...current!, sessionQuotaNotificationsEnabled: false }));
    expect(lock.acquisitions()).toBe(acquisitionsBeforeSave + 1);
    expect(repository.current?.sessionQuotaNotificationsEnabled).toBe(false);
    expect(repository.current?.providers[0]?.tokenAccounts).toEqual({
      version: 2,
      activeIndex: 0,
      accounts: [],
    });
  });

  it("maps selected Claude Admin API accounts and nulls ambient credential channels", async () => {
    const account = {
      id: "account-admin",
      label: "Admin",
      addedAt: 0,
      organizationId: " org-selected ",
    };
    const key = tokenAccountVaultKey("claude", account.id);
    const config: PersistedCodexBarConfig = {
      version: 1,
      providers: [
        {
          id: "claude",
          extensions: {},
          tokenAccounts: { version: 2, activeIndex: 0, accounts: [account] },
        },
      ],
    };

    const selected = await Effect.runPromise(
      resolveSelectedFirstPartyAccountFromVault(
        config,
        memoryCredentials({ [key]: "Bearer sk-ant-admin-selected" }),
        "claude",
      ),
    );

    expect(selected).toMatchObject({
      id: "account-admin",
      secureSettings: {
        ANTHROPIC_ADMIN_KEY: "sk-ant-admin-selected",
        ANTHROPIC_ADMIN_API_KEY: null,
        CLAUDE_OAUTH_ACCESS_TOKEN: null,
        CLAUDE_COOKIE_HEADER: null,
        CLAUDE_CLI_USAGE_JSON: null,
      },
      plainSettings: { CLAUDE_ORGANIZATION_ID: "org-selected" },
      claudeHistoryBinding: {
        tokenAccountKey: expect.any(String),
        selectionKey: expect.any(String),
      },
    });
  });

  it("maps selected Claude OAuth and web accounts with explicit Admin nulling", async () => {
    for (const [label, token, expected] of [
      [
        "OAuth",
        "Bearer sk-ant-oat-selected",
        {
          CLAUDE_OAUTH_ACCESS_TOKEN: "sk-ant-oat-selected",
          CLAUDE_COOKIE_HEADER: null,
        },
      ],
      [
        "Web",
        "sk-ant-session-selected",
        {
          CLAUDE_OAUTH_ACCESS_TOKEN: null,
          CLAUDE_COOKIE_HEADER: "sessionKey=sk-ant-session-selected",
        },
      ],
    ] as const) {
      const account = { id: `account-${label}`, label, addedAt: 0 };
      const key = tokenAccountVaultKey("claude", account.id);
      const config: PersistedCodexBarConfig = {
        version: 1,
        providers: [
          {
            id: "claude",
            extensions: {},
            tokenAccounts: { version: 2, activeIndex: 0, accounts: [account] },
          },
        ],
      };

      const selected = await Effect.runPromise(
        resolveSelectedFirstPartyAccountFromVault(
          config,
          memoryCredentials({ [key]: token }),
          "claude",
        ),
      );

      expect(selected?.secureSettings).toMatchObject({
        ANTHROPIC_ADMIN_KEY: null,
        ANTHROPIC_ADMIN_API_KEY: null,
        ...expected,
        CLAUDE_CLI_USAGE_JSON: null,
      });
      expect(selected?.plainSettings).toEqual({ CLAUDE_ORGANIZATION_ID: null });
    }
  });

  it("maps selected z.ai metadata and explicitly clears inherited team context", async () => {
    for (const [account, expected] of [
      [
        {
          id: "zai-team",
          label: "Team",
          addedAt: 0,
          usageScope: " team ",
          organizationId: " org-account ",
          workspaceID: " proj-account ",
        },
        {
          Z_AI_USAGE_SCOPE: "team",
          Z_AI_ORGANIZATION: "org-account",
          Z_AI_PROJECT: "proj-account",
        },
      ],
      [
        { id: "zai-personal", label: "Personal", addedAt: 0, usageScope: "personal" },
        {
          Z_AI_USAGE_SCOPE: "personal",
          Z_AI_ORGANIZATION: null,
          Z_AI_PROJECT: null,
        },
      ],
      [
        { id: "zai-incomplete", label: "Incomplete", addedAt: 0, usageScope: "team" },
        {
          Z_AI_USAGE_SCOPE: "team",
          Z_AI_ORGANIZATION: null,
          Z_AI_PROJECT: null,
        },
      ],
    ] as const) {
      const key = tokenAccountVaultKey("zai", account.id);
      const config: PersistedCodexBarConfig = {
        version: 1,
        providers: [
          {
            id: "zai",
            extensions: {},
            tokenAccounts: { version: 2, activeIndex: 0, accounts: [account] },
          },
        ],
      };

      const selected = await Effect.runPromise(
        resolveSelectedFirstPartyAccountFromVault(
          config,
          memoryCredentials({ [key]: " 'account-token' " }),
          "zai",
        ),
      );
      expect(selected).toEqual({
        id: account.id,
        secureSettings: { Z_AI_API_KEY: "account-token" },
        plainSettings: expected,
      });
    }
  });

  it("maps a selected Copilot account to only its opaque API token", async () => {
    const account = {
      id: "copilot-selected",
      label: "GitHub",
      addedAt: 0,
      externalIdentifier: "github:user:42",
    };
    const key = tokenAccountVaultKey("copilot", account.id);
    const config: PersistedCodexBarConfig = {
      version: 1,
      providers: [
        {
          id: "copilot",
          extensions: {},
          tokenAccounts: { version: 2, activeIndex: 0, accounts: [account] },
        },
      ],
    };

    const selected = await Effect.runPromise(
      resolveSelectedFirstPartyAccountFromVault(
        config,
        memoryCredentials({ [key]: " selected-token " }),
        "copilot",
      ),
    );
    expect(selected).toEqual({
      id: account.id,
      externalIdentifier: "github:user:42",
      secureSettings: { COPILOT_API_TOKEN: "selected-token" },
    });
  });

  it("maps a selected DeepInfra account to only its canonical API key", async () => {
    const account = { id: "deepinfra-selected", label: "Work", addedAt: 0 };
    const key = tokenAccountVaultKey("deepinfra", account.id);
    const config: PersistedCodexBarConfig = {
      version: 1,
      providers: [
        {
          id: "deepinfra",
          extensions: {},
          tokenAccounts: { version: 2, activeIndex: 0, accounts: [account] },
        },
      ],
    };

    const selected = await Effect.runPromise(
      resolveSelectedFirstPartyAccountFromVault(
        config,
        memoryCredentials({ [key]: ' "selected-key" ' }),
        "deepinfra",
      ),
    );
    expect(selected).toEqual({
      id: account.id,
      secureSettings: { DEEPINFRA_API_KEY: "selected-key", DEEPINFRA_TOKEN: null },
    });
  });

  it("maps a selected Groq account without copying global endpoint settings", async () => {
    const account = { id: "groq-selected", label: "Enterprise", addedAt: 0 };
    const key = tokenAccountVaultKey("groq", account.id);
    const config: PersistedCodexBarConfig = {
      version: 1,
      providers: [
        {
          id: "groq",
          extensions: { GROQ_API_URL: "https://groq.example.test/v1" },
          tokenAccounts: { version: 2, activeIndex: 0, accounts: [account] },
        },
      ],
    };

    const selected = await Effect.runPromise(
      resolveSelectedFirstPartyAccountFromVault(
        config,
        memoryCredentials({ [key]: ' "selected-key" ' }),
        "groq",
      ),
    );
    expect(selected).toEqual({
      id: account.id,
      secureSettings: { GROQ_API_KEY: "selected-key" },
    });
  });

  it("maps a selected Venice account to its canonical key and clears the legacy alias", async () => {
    const account = { id: "venice-selected", label: "Personal", addedAt: 0 };
    const key = tokenAccountVaultKey("venice", account.id);
    const config: PersistedCodexBarConfig = {
      version: 1,
      providers: [
        {
          id: "venice",
          extensions: {},
          tokenAccounts: { version: 2, activeIndex: 0, accounts: [account] },
        },
      ],
    };

    const selected = await Effect.runPromise(
      resolveSelectedFirstPartyAccountFromVault(
        config,
        memoryCredentials({ [key]: " selected-key " }),
        "venice",
      ),
    );
    expect(selected).toEqual({
      id: account.id,
      secureSettings: { VENICE_API_KEY: "selected-key", VENICE_KEY: null },
    });
  });

  it("maps a selected ElevenLabs account without copying its global endpoint", async () => {
    const account = { id: "elevenlabs-selected", label: "Studio", addedAt: 0 };
    const key = tokenAccountVaultKey("elevenlabs", account.id);
    const config: PersistedCodexBarConfig = {
      version: 1,
      providers: [
        {
          id: "elevenlabs",
          extensions: { ELEVENLABS_API_URL: "https://eleven.example.test" },
          tokenAccounts: { version: 2, activeIndex: 0, accounts: [account] },
        },
      ],
    };

    const selected = await Effect.runPromise(
      resolveSelectedFirstPartyAccountFromVault(
        config,
        memoryCredentials({ [key]: ' "selected-key" ' }),
        "elevenlabs",
      ),
    );
    expect(selected).toEqual({
      id: account.id,
      secureSettings: { ELEVENLABS_API_KEY: "selected-key", XI_API_KEY: null },
    });
  });

  it("maps selected IBM Bob material to the canonical secure setting only", async () => {
    const account = { id: "ibmbob-selected", label: "Enterprise", addedAt: 0 };
    const key = tokenAccountVaultKey("ibmbob", account.id);
    const config: PersistedCodexBarConfig = {
      version: 1,
      providers: [
        {
          id: "ibmbob",
          extensions: {},
          tokenAccounts: { version: 2, activeIndex: 0, accounts: [account] },
        },
      ],
    };

    const selected = await Effect.runPromise(
      resolveSelectedFirstPartyAccountFromVault(
        config,
        memoryCredentials({ [key]: " 'selected-key' " }),
        "ibmbob",
      ),
    );
    expect(selected).toEqual({
      id: account.id,
      secureSettings: { BOBSHELL_API_KEY: "selected-key" },
    });
  });

  it("maps a selected Neuralwatt account without copying its global endpoint", async () => {
    const account = { id: "neuralwatt-selected", label: "Prepaid", addedAt: 0 };
    const key = tokenAccountVaultKey("neuralwatt", account.id);
    const config: PersistedCodexBarConfig = {
      version: 1,
      providers: [
        {
          id: "neuralwatt",
          extensions: { NEURALWATT_API_URL: "https://neural.example.test/v1" },
          tokenAccounts: { version: 2, activeIndex: 0, accounts: [account] },
        },
      ],
    };

    const selected = await Effect.runPromise(
      resolveSelectedFirstPartyAccountFromVault(
        config,
        memoryCredentials({ [key]: ' "selected-key" ' }),
        "neuralwatt",
      ),
    );
    expect(selected).toEqual({
      id: account.id,
      secureSettings: { NEURALWATT_API_KEY: "selected-key" },
    });
  });

  it("maps a selected sub2api key while preserving its global base URL outside the vault", async () => {
    const account = { id: "sub2api-selected", label: "Group", addedAt: 0 };
    const key = tokenAccountVaultKey("sub2api", account.id);
    const config: PersistedCodexBarConfig = {
      version: 1,
      providers: [
        {
          id: "sub2api",
          extensions: { SUB2API_BASE_URL: "https://sub2api.example.test" },
          tokenAccounts: { version: 2, activeIndex: 0, accounts: [account] },
        },
      ],
    };

    const selected = await Effect.runPromise(
      resolveSelectedFirstPartyAccountFromVault(
        config,
        memoryCredentials({ [key]: " 'selected-key' " }),
        "sub2api",
      ),
    );
    expect(selected).toEqual({
      id: account.id,
      secureSettings: { SUB2API_API_KEY: "selected-key" },
    });
  });

  it("maps a selected LLM Proxy key without copying its enterprise host", async () => {
    const account = { id: "llmproxy-selected", label: "Proxy", addedAt: 0 };
    const key = tokenAccountVaultKey("llmproxy", account.id);
    const config: PersistedCodexBarConfig = {
      version: 1,
      providers: [
        {
          id: "llmproxy",
          extensions: { LLM_PROXY_BASE_URL: "https://proxy.example.test" },
          tokenAccounts: { version: 2, activeIndex: 0, accounts: [account] },
        },
      ],
    };
    await expect(
      Effect.runPromise(
        resolveSelectedFirstPartyAccountFromVault(
          config,
          memoryCredentials({ [key]: ' "selected-key" ' }),
          "llmproxy",
        ),
      ),
    ).resolves.toEqual({
      id: account.id,
      secureSettings: { LLM_PROXY_API_KEY: "selected-key" },
    });
  });

  it("maps a selected LiteLLM key while preserving its global base URL outside the vault", async () => {
    const account = { id: "litellm-selected", label: "Virtual key", addedAt: 0 };
    const key = tokenAccountVaultKey("litellm", account.id);
    const config: PersistedCodexBarConfig = {
      version: 1,
      providers: [
        {
          id: "litellm",
          extensions: { LITELLM_BASE_URL: "https://litellm.example.test/v1" },
          tokenAccounts: { version: 2, activeIndex: 0, accounts: [account] },
        },
      ],
    };
    await expect(
      Effect.runPromise(
        resolveSelectedFirstPartyAccountFromVault(
          config,
          memoryCredentials({ [key]: ' "selected-key" ' }),
          "litellm",
        ),
      ),
    ).resolves.toEqual({
      id: account.id,
      secureSettings: { LITELLM_API_KEY: "selected-key" },
    });
  });

  it("maps a selected DeepSeek key without inheriting ambient platform context", async () => {
    const account = { id: "deepseek-selected", label: "DeepSeek", addedAt: 0 };
    const key = tokenAccountVaultKey("deepseek", account.id);
    const config: PersistedCodexBarConfig = {
      version: 1,
      providers: [
        {
          id: "deepseek",
          extensions: {
            DEEPSEEK_PLATFORM_TOKEN: "ambient-platform-token",
            CODEXBAR_DEEPSEEK_PROFILE_ID: "ambient-profile",
            CODEXBAR_DEEPSEEK_PROFILE_SCOPE: "ambient-scope",
          },
          tokenAccounts: { version: 2, activeIndex: 0, accounts: [account] },
        },
      ],
    };
    await expect(
      Effect.runPromise(
        resolveSelectedFirstPartyAccountFromVault(
          config,
          memoryCredentials({ [key]: ' "selected-key" ' }),
          "deepseek",
        ),
      ),
    ).resolves.toEqual({
      id: account.id,
      secureSettings: {
        DEEPSEEK_API_KEY: "selected-key",
        DEEPSEEK_KEY: null,
        DEEPSEEK_PLATFORM_TOKEN: null,
        DEEPSEEK_USER_TOKEN: null,
      },
      plainSettings: {
        CODEXBAR_DEEPSEEK_PROFILE_ID: null,
        CODEXBAR_DEEPSEEK_PROFILE_SCOPE: null,
      },
    });
  });

  it("maps a selected OpenAI key as an unscoped Admin credential", async () => {
    const account = { id: "openai-selected", label: "OpenAI", addedAt: 0 };
    const key = tokenAccountVaultKey("openai", account.id);
    const config: PersistedCodexBarConfig = {
      version: 1,
      providers: [
        {
          id: "openai",
          extensions: {
            OPENAI_API_KEY: "ambient-legacy",
            OPENAI_PROJECT_ID: "ambient-project",
          },
          tokenAccounts: { version: 2, activeIndex: 0, accounts: [account] },
        },
      ],
    };
    await expect(
      Effect.runPromise(
        resolveSelectedFirstPartyAccountFromVault(
          config,
          memoryCredentials({ [key]: ' "selected-key" ' }),
          "openai",
        ),
      ),
    ).resolves.toEqual({
      id: account.id,
      secureSettings: {
        OPENAI_ADMIN_KEY: "selected-key",
        OPENAI_API_KEY: null,
      },
      plainSettings: { OPENAI_PROJECT_ID: null },
    });
  });

  it("maps a selected OpenRouter key without copying its global management settings", async () => {
    const account = { id: "openrouter-selected", label: "OpenRouter", addedAt: 0 };
    const key = tokenAccountVaultKey("openrouter", account.id);
    const config: PersistedCodexBarConfig = {
      version: 1,
      providers: [
        {
          id: "openrouter",
          extensions: {
            OPENROUTER_MANAGEMENT_API_KEY: "global-management",
            OPENROUTER_API_URL: "https://router.example.test/v1",
            OPENROUTER_HTTP_REFERER: "https://codexbar.example.test",
            OPENROUTER_X_TITLE: "CodexBar Multi",
          },
          tokenAccounts: { version: 2, activeIndex: 0, accounts: [account] },
        },
      ],
    };
    await expect(
      Effect.runPromise(
        resolveSelectedFirstPartyAccountFromVault(
          config,
          memoryCredentials({ [key]: ' "selected-key" ' }),
          "openrouter",
        ),
      ),
    ).resolves.toEqual({
      id: account.id,
      secureSettings: { OPENROUTER_API_KEY: "selected-key" },
    });
  });
});
