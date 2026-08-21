import { describe, expect, it } from "vite-plus/test";

import { DesktopChannels } from "../src/ipc/api.ts";
import { makeClaudeSwapApi } from "../src/preload/claude-swap-api.ts";

describe("Claude Swap preload bridge", () => {
  it("accepts only the explicit Claude opaque-account request and removes extra output", async () => {
    const calls: Array<{ readonly channel: string; readonly input: unknown }> = [];
    const api = makeClaudeSwapApi(async (channel, input) => {
      calls.push({ channel, input });
      return {
        provider: "claude",
        accountId: "source-account",
        switched: true,
        executablePath: "/private/cswap",
        reason: "not renderer-visible",
      };
    });
    await expect(
      api.activateClaudeSwapAccount({ provider: "claude", accountId: "source-account" }),
    ).resolves.toEqual({ provider: "claude", accountId: "source-account", switched: true });
    expect(calls).toEqual([
      {
        channel: DesktopChannels.activateClaudeSwapAccount,
        input: { provider: "claude", accountId: "source-account" },
      },
    ]);
    await expect(
      api.activateClaudeSwapAccount({ provider: "openai", accountId: "source-account" } as never),
    ).rejects.toThrow();
  });
});
