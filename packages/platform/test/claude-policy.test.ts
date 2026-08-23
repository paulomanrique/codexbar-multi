import { describe, expect, it } from "vite-plus/test";
import { makeNodeFirstPartyLocalCapabilities } from "../src/node.ts";
import {
  filterProvidersForClaudeBackgroundPolicy,
  hasClaudeCliUserInitiatedSuccess,
  recordClaudeCliUserInitiatedSuccess,
  resetClaudeCliPolicyForTesting,
  shouldIncludeClaudeInRefresh,
} from "../src/node-claude-cli-policy.ts";

const providers = [
  { id: "codex", enabled: true },
  { id: "claude", enabled: true },
  { id: "grok", enabled: true },
  { id: "amp", enabled: false },
] as const;

describe("Claude CLI background policy", () => {
  it("does not expose Claude PTY on the shared Node first-party broker", () => {
    const caps = makeNodeFirstPartyLocalCapabilities({ environment: {} });
    expect(caps.fetchClaudeCliUsage).toBeUndefined();
  });

  it("startup and adaptive background skip Claude until user-initiated claude.cli success", () => {
    resetClaudeCliPolicyForTesting();
    expect(shouldIncludeClaudeInRefresh("background")).toBe(false);
    expect(shouldIncludeClaudeInRefresh("user")).toBe(true);
    expect(
      filterProvidersForClaudeBackgroundPolicy(providers, "background").map((p) => p.id),
    ).toEqual(["codex", "grok"]);
    expect(filterProvidersForClaudeBackgroundPolicy(providers, "user").map((p) => p.id)).toEqual([
      "codex",
      "claude",
      "grok",
    ]);
  });

  it("unsuccessful manual refresh does not enable later background", () => {
    resetClaudeCliPolicyForTesting();
    expect(hasClaudeCliUserInitiatedSuccess()).toBe(false);
    expect(
      filterProvidersForClaudeBackgroundPolicy(providers, "background").map((p) => p.id),
    ).toEqual(["codex", "grok"]);
  });

  it("success enables later background without a global in-flight toggle", () => {
    resetClaudeCliPolicyForTesting();
    recordClaudeCliUserInitiatedSuccess();
    expect(hasClaudeCliUserInitiatedSuccess()).toBe(true);
    expect(
      filterProvidersForClaudeBackgroundPolicy(providers, "background").map((p) => p.id),
    ).toEqual(["codex", "claude", "grok"]);
  });

  it("concurrent background and manual refresh do not race: manual keeps Claude, background does not", async () => {
    resetClaudeCliPolicyForTesting();
    const background = Promise.resolve(
      filterProvidersForClaudeBackgroundPolicy(providers, "background").map((p) => p.id),
    );
    const manual = Promise.resolve(
      filterProvidersForClaudeBackgroundPolicy(providers, "user").map((p) => p.id),
    );
    const [backgroundIds, manualIds] = await Promise.all([background, manual]);
    expect(backgroundIds).toEqual(["codex", "grok"]);
    expect(manualIds).toContain("claude");
    expect(hasClaudeCliUserInitiatedSuccess()).toBe(false);
  });
});
