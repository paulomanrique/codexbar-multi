import { describe, expect, it } from "vite-plus/test";
import { Effect, Fiber, Semaphore } from "effect";
import {
  InfrastructureError,
  type ConfigRepositoryService,
  type CredentialStoreService,
  type PersistedCodexBarConfig,
} from "@codexbar/core";
import {
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
    readonly corruptReadback?: boolean;
  } = {},
): CredentialStoreService & {
  readonly values: Map<string, string>;
  readonly reads: string[];
  readonly writes: Array<{ readonly key: string; readonly value: string }>;
} => {
  const values = new Map(Object.entries(initial));
  const reads: string[] = [];
  const writes: Array<{ readonly key: string; readonly value: string }> = [];
  let writeHappened = false;
  return {
    values,
    reads,
    writes,
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
    remove: () => Effect.void,
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
});
