import { describe, expect, it } from "vite-plus/test";
import { DesktopChannels } from "../src/ipc/api.ts";
import { makeCodexBrowserSessionApi } from "../src/preload/codex-browser-session-api.ts";

const result = {
  provider: "codex" as const,
  revision: "d".repeat(64),
  statuses: [{ accountId: "account-1", status: "persisted" as const }],
};

describe("Codex browser-session preload bridge", () => {
  it("sends exact metadata-only requests and validates metadata-only results", async () => {
    const calls: Array<{ channel: string; input: unknown }> = [];
    const api = makeCodexBrowserSessionApi(async (channel, input) => {
      calls.push({ channel, input });
      return result;
    });

    await expect(
      api.startCodexBrowserSession({ accountId: "account-1", expectedRevision: "a".repeat(64) }),
    ).resolves.toEqual(result);
    await expect(api.cancelCodexBrowserSession({ accountId: "account-1" })).resolves.toEqual(
      result,
    );
    await expect(
      api.logoutCodexBrowserSession({ accountId: "account-1", expectedRevision: "b".repeat(64) }),
    ).resolves.toEqual(result);
    await expect(
      api.getCodexBrowserSessionStatuses({ expectedRevision: "b".repeat(64) }),
    ).resolves.toEqual(result);
    expect(calls.map(({ channel }) => channel)).toEqual([
      DesktopChannels.startCodexBrowserSession,
      DesktopChannels.cancelCodexBrowserSession,
      DesktopChannels.logoutCodexBrowserSession,
      DesktopChannels.getCodexBrowserSessionStatuses,
    ]);
    expect(calls[0]?.input).toEqual({ accountId: "account-1", expectedRevision: "a".repeat(64) });
  });

  it("rejects provider, secret, path, and command fields before invoke", async () => {
    const invoke = async () => result;
    const api = makeCodexBrowserSessionApi(invoke);
    await expect(
      api.startCodexBrowserSession({
        accountId: "a",
        expectedRevision: "a".repeat(64),
        provider: "codex",
      } as never),
    ).rejects.toThrow();
    await expect(
      api.cancelCodexBrowserSession({ accountId: "a", cookieHeader: "secret" } as never),
    ).rejects.toThrow();
    await expect(
      api.logoutCodexBrowserSession({
        accountId: "a",
        expectedRevision: "a".repeat(64),
        command: "codex",
      } as never),
    ).rejects.toThrow();
    await expect(
      api.getCodexBrowserSessionStatuses({
        expectedRevision: "a".repeat(64),
        partition: "secret",
      } as never),
    ).rejects.toThrow();
  });

  it("rejects non-Codex or credential-bearing results", async () => {
    const api = makeCodexBrowserSessionApi(async () => ({ ...result, provider: "openai" }));
    await expect(
      api.getCodexBrowserSessionStatuses({ expectedRevision: "a".repeat(64) }),
    ).rejects.toThrow();
    const secretApi = makeCodexBrowserSessionApi(async () => ({
      ...result,
      statuses: [{ accountId: "account-1", status: "persisted", cookieHeader: "secret" }],
    }));
    await expect(
      secretApi.getCodexBrowserSessionStatuses({ expectedRevision: "a".repeat(64) }),
    ).rejects.toThrow();
  });
});
