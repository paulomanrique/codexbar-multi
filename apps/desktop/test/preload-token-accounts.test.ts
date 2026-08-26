import { describe, expect, it } from "vite-plus/test";

import { DesktopChannels } from "../src/ipc/api.ts";
import { makeTokenAccountsApi } from "../src/preload/token-accounts-api.ts";

describe("token account preload bridge", () => {
  it("decodes requests before invoking high-level channels", async () => {
    const calls: Array<{ readonly channel: string; readonly input: unknown }> = [];
    const api = makeTokenAccountsApi(async (channel, input) => {
      calls.push({ channel, input });
      const provider =
        typeof input === "object" &&
        input !== null &&
        "provider" in input &&
        input.provider === "codex"
          ? "codex"
          : "claude";
      return {
        provider,
        accounts: [{ id: "account-1", label: "Main", addedAt: 1 }],
        activeIndex: 0,
        selectionAvailable: true,
        revision: "a".repeat(64),
      };
    });

    await expect(
      api.selectTokenAccount({
        provider: "claude",
        accountId: "account-1",
        expectedRevision: "a".repeat(64),
      }),
    ).resolves.toEqual({
      provider: "claude",
      accounts: [{ id: "account-1", label: "Main", addedAt: 1 }],
      activeIndex: 0,
      selectionAvailable: true,
      revision: "a".repeat(64),
    });
    expect(calls).toEqual([
      {
        channel: DesktopChannels.selectTokenAccount,
        input: {
          provider: "claude",
          accountId: "account-1",
          expectedRevision: "a".repeat(64),
        },
      },
    ]);

    await expect(
      api.renameTokenAccount({
        provider: "claude",
        accountId: "account-1",
        label: "Renamed",
        expectedRevision: "a".repeat(64),
      }),
    ).resolves.toMatchObject({ provider: "claude" });
    expect(calls[1]).toEqual({
      channel: DesktopChannels.renameTokenAccount,
      input: {
        provider: "claude",
        accountId: "account-1",
        label: "Renamed",
        expectedRevision: "a".repeat(64),
      },
    });

    await expect(
      api.removeTokenAccount({
        provider: "claude",
        accountId: "account-1",
        expectedRevision: "a".repeat(64),
      }),
    ).resolves.toMatchObject({ provider: "claude" });
    expect(calls[2]).toEqual({
      channel: DesktopChannels.removeTokenAccount,
      input: {
        provider: "claude",
        accountId: "account-1",
        expectedRevision: "a".repeat(64),
      },
    });
    await expect(api.startCodexAccountLogin({ provider: "codex" })).resolves.toMatchObject({
      provider: "codex",
    });
    expect(calls[3]).toEqual({
      channel: DesktopChannels.startCodexAccountLogin,
      input: { provider: "codex" },
    });
    await expect(api.cancelCodexAccountLogin({ provider: "codex" })).resolves.toBeUndefined();
    expect(calls[4]).toEqual({
      channel: DesktopChannels.cancelCodexAccountLogin,
      input: { provider: "codex" },
    });

    await expect(api.listTokenAccounts({ provider: "fixture-plugin" as never })).rejects.toThrow();
    await expect(
      api.renameTokenAccount({
        provider: "claude",
        accountId: "account-1",
        label: "   ",
        expectedRevision: "a".repeat(64),
      }),
    ).rejects.toThrow();
    await expect(
      api.removeTokenAccount({
        provider: "claude",
        accountId: "account-1",
        expectedRevision: "a".repeat(64),
        token: "must-not-cross-preload",
      } as never),
    ).rejects.toThrow();
    await expect(
      api.startCodexAccountLogin({
        provider: "codex",
        credentialJson: "must-not-cross-preload",
      } as never),
    ).rejects.toThrow();
    await expect(
      api.cancelCodexAccountLogin({
        provider: "codex",
        command: "/usr/bin/codex",
      } as never),
    ).rejects.toThrow();
    expect(calls).toHaveLength(5);
  });

  it("rejects token-bearing responses before returning to the renderer", async () => {
    const api = makeTokenAccountsApi(async () => ({
      provider: "claude",
      accounts: [{ id: "account-1", label: "Main", addedAt: 1, token: "redacted" }],
      activeIndex: 0,
      selectionAvailable: true,
      revision: "a".repeat(64),
    }));

    await expect(api.listTokenAccounts({ provider: "claude" })).rejects.toThrow();
  });

  it("rejects a valid roster issued for a different provider", async () => {
    const api = makeTokenAccountsApi(async () => ({
      provider: "claude",
      accounts: [],
      activeIndex: 0,
      selectionAvailable: true,
      revision: "b".repeat(64),
    }));

    await expect(api.listTokenAccounts({ provider: "codex" })).rejects.toThrow("provider mismatch");
  });

  it("keeps Codex login host-owned across start and cancel", async () => {
    const calls: Array<{ readonly channel: string; readonly input: unknown }> = [];
    const api = makeTokenAccountsApi(async (channel, input) => {
      calls.push({ channel, input });
      return channel === DesktopChannels.cancelCodexAccountLogin
        ? undefined
        : {
            provider: "codex",
            accounts: [{ id: "host-id", label: "person@example.test", addedAt: 1 }],
            activeIndex: 0,
            selectionAvailable: true,
            revision: "d".repeat(64),
          };
    });

    await expect(api.startCodexAccountLogin({ provider: "codex" })).resolves.toMatchObject({
      provider: "codex",
    });
    await expect(api.cancelCodexAccountLogin({ provider: "codex" })).resolves.toBeUndefined();
    expect(calls).toEqual([
      {
        channel: DesktopChannels.startCodexAccountLogin,
        input: { provider: "codex" },
      },
      {
        channel: DesktopChannels.cancelCodexAccountLogin,
        input: { provider: "codex" },
      },
    ]);
    await expect(
      api.startCodexAccountLogin({
        provider: "codex",
        command: "C:\\malicious.exe",
      } as never),
    ).rejects.toThrow();
    await expect(
      api.startCodexAccountLogin({ provider: "codex", token: "secret" } as never),
    ).rejects.toThrow();
    expect(calls).toHaveLength(2);
  });
});
