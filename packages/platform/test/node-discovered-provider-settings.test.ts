import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { makeNodeDiscoveredProviderSettings, parseNodeCodexAuthJson } from "../src/node.ts";

describe("Node discovered provider settings factory", () => {
  it("re-reads Claude and Codex credentials on every settings.read", async () => {
    let claude = "claude-first";
    let codex = "codex-first";
    let claudeReads = 0;
    let codexReads = 0;
    const settings = makeNodeDiscoveredProviderSettings({
      environment: {},
      discoverClaudeCredential: () => {
        claudeReads += 1;
        return { accessToken: claude };
      },
      discoverCodexCredential: () => {
        codexReads += 1;
        return { accessToken: codex };
      },
    });
    expect(await Effect.runPromise(settings.read("claude", "CLAUDE_OAUTH_ACCESS_TOKEN"))).toBe(
      "claude-first",
    );
    claude = "claude-second";
    expect(await Effect.runPromise(settings.read("claude", "CLAUDE_OAUTH_ACCESS_TOKEN"))).toBe(
      "claude-second",
    );
    expect(await Effect.runPromise(settings.read("codex", "CODEX_ACCESS_TOKEN"))).toBe(
      "codex-first",
    );
    codex = "codex-second";
    expect(await Effect.runPromise(settings.read("codex", "CODEX_ACCESS_TOKEN"))).toBe(
      "codex-second",
    );
    expect(claudeReads).toBe(2);
    expect(codexReads).toBe(2);
  });

  it("scopes discovered values to provider and setting through the shared factory", async () => {
    const settings = makeNodeDiscoveredProviderSettings({
      environment: {},
      discoverClaudeCredential: () => ({ accessToken: "claude-token" }),
      discoverCodexCredential: () => ({
        accessToken: "codex-token",
        accountId: "acc-1",
        personalAccessToken: "pat-1",
      }),
    });
    expect(await Effect.runPromise(settings.read("claude", "CLAUDE_OAUTH_ACCESS_TOKEN"))).toBe(
      "claude-token",
    );
    expect(await Effect.runPromise(settings.read("codex", "CODEX_ACCESS_TOKEN"))).toBe(
      "codex-token",
    );
    expect(await Effect.runPromise(settings.read("codex", "CODEX_ACCOUNT_ID"))).toBe("acc-1");
    expect(await Effect.runPromise(settings.read("codex", "CODEX_PERSONAL_ACCESS_TOKEN"))).toBe(
      "pat-1",
    );
    expect(
      await Effect.runPromise(settings.read("codex", "CLAUDE_OAUTH_ACCESS_TOKEN")),
    ).toBeUndefined();
    expect(await Effect.runPromise(settings.read("claude", "CODEX_ACCESS_TOKEN"))).toBeUndefined();
    expect(
      await Effect.runPromise(settings.read("openai", "CLAUDE_OAUTH_ACCESS_TOKEN")),
    ).toBeUndefined();
  });

  it("falls through to environment settings when discovery has no value", async () => {
    const settings = makeNodeDiscoveredProviderSettings({
      environment: {
        CLAUDE_OAUTH_ACCESS_TOKEN: "env-claude",
        CODEX_ACCESS_TOKEN: "env-codex",
        CODEXBAR_MULTI_CLAUDE_CLAUDE_OAUTH_ACCESS_TOKEN: "namespaced-claude",
      },
      discoverClaudeCredential: () => ({}),
      discoverCodexCredential: () => ({}),
    });
    expect(await Effect.runPromise(settings.read("claude", "CLAUDE_OAUTH_ACCESS_TOKEN"))).toBe(
      "namespaced-claude",
    );
    expect(await Effect.runPromise(settings.read("codex", "CODEX_ACCESS_TOKEN"))).toBe("env-codex");
    const unprefixed = makeNodeDiscoveredProviderSettings({
      environment: { CLAUDE_OAUTH_ACCESS_TOKEN: "env-claude" },
      discoverClaudeCredential: () => ({}),
      discoverCodexCredential: () => ({}),
    });
    expect(await Effect.runPromise(unprefixed.read("claude", "CLAUDE_OAUTH_ACCESS_TOKEN"))).toBe(
      "env-claude",
    );
  });

  it("preserves explicit Codex environment fallback for an incomplete native OAuth file", async () => {
    const settings = makeNodeDiscoveredProviderSettings({
      environment: { CODEX_ACCESS_TOKEN: "explicit-env-codex" },
      discoverClaudeCredential: () => ({}),
      discoverCodexCredential: () =>
        parseNodeCodexAuthJson(
          JSON.stringify({ tokens: { access_token: "native-without-refresh" } }),
        )?.credential ?? {},
    });

    expect(await Effect.runPromise(settings.read("codex", "CODEX_ACCESS_TOKEN"))).toBe(
      "explicit-env-codex",
    );
  });

  it("prefers a discovered Claude token over environment fallback", async () => {
    const settings = makeNodeDiscoveredProviderSettings({
      environment: { CLAUDE_OAUTH_ACCESS_TOKEN: "env-claude" },
      discoverClaudeCredential: () => ({ accessToken: "file-claude" }),
      discoverCodexCredential: () => ({}),
    });
    expect(await Effect.runPromise(settings.read("claude", "CLAUDE_OAUTH_ACCESS_TOKEN"))).toBe(
      "file-claude",
    );
  });

  it("passes the factory environment into discovery on each read", async () => {
    const seen: Array<Readonly<Record<string, string | undefined>> | undefined> = [];
    const environment = { CLAUDE_CONFIG_DIR: "/custom-profile" };
    const settings = makeNodeDiscoveredProviderSettings({
      environment,
      discoverClaudeCredential: (options) => {
        seen.push(options?.environment);
        return {};
      },
      discoverCodexCredential: () => ({}),
    });
    await Effect.runPromise(settings.read("claude", "CLAUDE_OAUTH_ACCESS_TOKEN"));
    expect(seen).toEqual([environment]);
  });
});
