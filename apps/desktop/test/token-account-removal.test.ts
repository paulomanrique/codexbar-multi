import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import {
  InfrastructureError,
  makeDefaultCodexBarConfig,
  type CredentialStoreService,
  type PersistedCodexBarConfig,
} from "@codexbar/core";
import { resolveSelectedFirstPartyAccountFromVault } from "@codexbar/platform";

import { runTokenAccountRemovalMutation } from "../src/main/token-account-removal.ts";

describe("desktop token account removal cache", () => {
  it("publishes the committed config after successful vault cleanup", async () => {
    const published: unknown[] = [];
    await expect(
      runTokenAccountRemovalMutation({
        remove: async () => "removed",
        loadCommittedConfig: async () => ({ accounts: [] }),
        loadRawConfig: async () => ({ accounts: ["stale"] }),
        publishConfig: (config) => published.push(config),
      }),
    ).resolves.toBe("removed");
    expect(published).toEqual([{ accounts: [] }]);
  });

  it("replaces stale runtime state with staged raw config after keyring failure", async () => {
    const failure = new Error("keyring locked");
    const base = makeDefaultCodexBarConfig();
    const stale: PersistedCodexBarConfig = {
      ...base,
      providers: base.providers.map((provider) =>
        provider.id === "codex"
          ? {
              ...provider,
              tokenAccounts: {
                version: 2,
                activeIndex: 0,
                accounts: [{ id: "removed", label: "Removed", addedAt: 1 }],
              },
            }
          : provider,
      ),
    };
    const staged: PersistedCodexBarConfig = {
      ...stale,
      providers: stale.providers.map((provider) => {
        if (provider.id !== "codex") return provider;
        const { tokenAccounts: _accounts, ...withoutAccounts } = provider;
        return {
          ...withoutAccounts,
          pendingTokenAccountDeletion: { version: 1, accountId: "removed" },
        };
      }),
    };
    let live: PersistedCodexBarConfig | undefined = stale;
    await expect(
      runTokenAccountRemovalMutation({
        remove: async () => Promise.reject(failure),
        loadCommittedConfig: async () => stale,
        loadRawConfig: async () => staged,
        publishConfig: (config) => {
          live = config;
        },
      }),
    ).rejects.toBe(failure);
    expect(live).toBe(staged);

    const reads: string[] = [];
    const credentials: CredentialStoreService = {
      read: (key) =>
        Effect.sync(() => {
          reads.push(key);
          return "still-present-secret";
        }),
      write: () => Effect.void,
      remove: () => Effect.fail(new InfrastructureError("remove", "keyring locked")),
    };
    await expect(
      Effect.runPromise(resolveSelectedFirstPartyAccountFromVault(live, credentials, "codex")),
    ).resolves.toBeUndefined();
    expect(reads).toEqual([]);
  });

  it("leaves runtime state undefined when even raw config cannot be read", async () => {
    const published: unknown[] = [];
    await expect(
      runTokenAccountRemovalMutation({
        remove: async () => Promise.reject(new Error("keyring locked")),
        loadCommittedConfig: async () => ({ accounts: ["must-not-load"] }),
        loadRawConfig: async () => Promise.reject(new Error("disk unavailable")),
        publishConfig: (config) => published.push(config),
      }),
    ).rejects.toThrow("keyring locked");
    expect(published).toEqual([undefined]);
  });
});
