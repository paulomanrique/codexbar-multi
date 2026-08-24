import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import {
  InfrastructureError,
  type ConfigRepositoryService,
  type CredentialStoreService,
  type PersistedCodexBarConfig,
} from "@codexbar/core";
import {
  makeTokenAccountVaultConfigRepository,
  tokenAccountVaultKey,
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

    const loaded = await Effect.runPromise(
      makeTokenAccountVaultConfigRepository(repository, credentials).load,
    );

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
    const loaded = await Effect.runPromise(
      makeTokenAccountVaultConfigRepository(repository, credentials).load,
    );
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
    await Effect.runPromise(makeTokenAccountVaultConfigRepository(repository, credentials).load);
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
      Effect.runPromise(makeTokenAccountVaultConfigRepository(repository, credentials).load),
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
      Effect.runPromise(makeTokenAccountVaultConfigRepository(repository, credentials).load),
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
      Effect.runPromise(makeTokenAccountVaultConfigRepository(repository, credentials).load),
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
      Effect.runPromise(makeTokenAccountVaultConfigRepository(repository, credentials).load),
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
        Effect.runPromise(makeTokenAccountVaultConfigRepository(repository, credentials).load),
      ).rejects.toBeInstanceOf(InfrastructureError);
      expect(repository.saves).toEqual([]);
    }

    const repository = memoryRepository(
      v1Config([{ id: "account-1", label: "Main", token: "legacy", addedAt: 0 }]),
      true,
    );
    await expect(
      Effect.runPromise(
        makeTokenAccountVaultConfigRepository(repository, memoryCredentials()).load,
      ),
    ).rejects.toBeInstanceOf(InfrastructureError);
    expect(repository.current?.providers[0]?.tokenAccounts?.version).toBe(1);
  });

  it("can retry after a simulated crash between vault write and v2 config save", async () => {
    const input = v1Config([{ id: "account-1", label: "Main", token: "legacy", addedAt: 0 }]);
    const key = tokenAccountVaultKey("claude", "account-1");
    const crashingRepository = memoryRepository(input, true);
    const credentials = memoryCredentials();
    await expect(
      Effect.runPromise(
        makeTokenAccountVaultConfigRepository(crashingRepository, credentials).load,
      ),
    ).rejects.toBeInstanceOf(InfrastructureError);
    expect(credentials.values.get(key)).toBe("legacy");
    expect(crashingRepository.current?.providers[0]?.tokenAccounts?.version).toBe(1);

    const retryRepository = memoryRepository(input);
    const loaded = await Effect.runPromise(
      makeTokenAccountVaultConfigRepository(retryRepository, credentials).load,
    );
    expect(loaded?.providers[0]?.tokenAccounts?.version).toBe(2);
    expect(credentials.writes).toHaveLength(1);
  });

  it("rejects wrapper saves that contain v1 or token-bearing account input", async () => {
    const repository = memoryRepository(undefined);
    const wrapper = makeTokenAccountVaultConfigRepository(repository, memoryCredentials());
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
});
