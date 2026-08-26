import { describe, expect, it } from "vite-plus/test";
import {
  PROVIDER_TOKEN_ACCOUNT_SUPPORT,
  tokenAccountSupportForProvider,
} from "../src/token-account-support.ts";

describe("provider token account support inventory", () => {
  it("ports exactly the generic first-party support set and keeps Codex unsupported", () => {
    expect(PROVIDER_TOKEN_ACCOUNT_SUPPORT.map((support) => support.provider)).toEqual([
      "abacus",
      "antigravity",
      "augment",
      "claude",
      "copilot",
      "cursor",
      "deepinfra",
      "deepseek",
      "elevenlabs",
      "factory",
      "grok",
      "groq",
      "ibmbob",
      "litellm",
      "llmproxy",
      "manus",
      "minimax",
      "mistral",
      "neuralwatt",
      "ollama",
      "openai",
      "opencode",
      "opencodego",
      "openrouter",
      "qoder",
      "stepfun",
      "sub2api",
      "venice",
      "zai",
    ]);
    expect(PROVIDER_TOKEN_ACCOUNT_SUPPORT).toHaveLength(29);
    expect(tokenAccountSupportForProvider("codex")).toBeUndefined();
  });

  it("matches Swift persisted manual-cookie selection providers", () => {
    expect(
      PROVIDER_TOKEN_ACCOUNT_SUPPORT.filter((support) => support.requiresManualCookieSource).map(
        (support) => support.provider,
      ),
    ).toEqual([
      "abacus",
      "augment",
      "claude",
      "cursor",
      "factory",
      "manus",
      "minimax",
      "mistral",
      "ollama",
      "opencode",
      "opencodego",
      "qoder",
      "stepfun",
    ]);
    expect(
      PROVIDER_TOKEN_ACCOUNT_SUPPORT.filter(
        (support) => support.selectedAccountRequiresManualCookieSource,
      ).map((support) => support.provider),
    ).toEqual(["cursor"]);
  });

  it("exposes selection only after a complete runtime mapper exists", () => {
    expect(
      PROVIDER_TOKEN_ACCOUNT_SUPPORT.filter((support) => support.runtimeSelectionAvailable).map(
        (support) => support.provider,
      ),
    ).toEqual([
      "abacus",
      "antigravity",
      "augment",
      "claude",
      "copilot",
      "cursor",
      "deepinfra",
      "deepseek",
      "elevenlabs",
      "factory",
      "grok",
      "groq",
      "ibmbob",
      "litellm",
      "llmproxy",
      "manus",
      "minimax",
      "mistral",
      "neuralwatt",
      "ollama",
      "openai",
      "opencode",
      "opencodego",
      "openrouter",
      "qoder",
      "stepfun",
      "sub2api",
      "venice",
      "zai",
    ]);
  });
});
