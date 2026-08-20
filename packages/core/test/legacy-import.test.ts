import { describe, expect, it } from "vite-plus/test";
import { planLegacyImport, stripLegacyCredentials } from "../src/legacy-import.ts";

describe("legacy import planning", () => {
  it("plans only validated ready sources and keeps the report data-free", () => {
    const plan = planLegacyImport("legacy-20260820", {
      candidates: [
        { kind: "config", source: "config.json", state: "ready", itemCount: 1, byteCount: 99 },
        { kind: "history", source: "history.jsonl", state: "missing", itemCount: 0, byteCount: 0 },
      ],
      excludedFeatures: ["icloud", "widgetkit", "sparkle", "approvals"],
      sqliteCompatibility: "not-attempted",
    });
    expect(plan.actions).toEqual([{ kind: "config", source: "config.json", itemCount: 1 }]);
    expect(JSON.stringify(plan)).not.toContain("secret-value");
  });

  it("rejects unsafe IDs and duplicate source plans", () => {
    const inspection = {
      candidates: [
        {
          kind: "config" as const,
          source: "config.json",
          state: "ready" as const,
          itemCount: 1,
          byteCount: 1,
        },
        {
          kind: "cost" as const,
          source: "config.json",
          state: "ready" as const,
          itemCount: 1,
          byteCount: 1,
        },
      ],
      excludedFeatures: [] as const,
      sqliteCompatibility: "not-attempted" as const,
    };
    expect(() => planLegacyImport("bad/id", inspection)).toThrow("Legacy import ID");
    expect(() => planLegacyImport("safe", inspection)).toThrow("appears more than once");
  });

  it("drops credentials and arbitrary provider/plugin fields rather than guessing them safe", () => {
    const sanitized = stripLegacyCredentials({
      version: 1,
      providers: [
        {
          id: "openai",
          enabled: true,
          apiKey: "do-not-copy",
          cookieHeader: "do-not-copy",
          pluginSettings: { innocuousName: "do-not-copy" },
          pluginSecrets: { session: "do-not-copy" },
          tokenAccounts: { version: 1, activeIndex: 0, accounts: [] },
          extensions: {
            region: "us",
            session: "do-not-copy",
            innocuousName: "do-not-copy",
            nested: { bearerToken: "do-not-copy", endpoint: "https://example.test" },
          },
        },
      ],
      hooks: {
        enabled: true,
        events: [
          {
            id: "legacy-hook",
            enabled: true,
            event: "quota_low",
            executable: "unsafe-legacy-command",
            arguments: ["--run"],
            timeoutSeconds: 30,
          },
        ],
      },
    });
    expect(sanitized).toEqual({
      version: 1,
      providers: [
        {
          id: "openai",
          enabled: true,
          extensions: {},
        },
      ],
      hooks: {
        enabled: false,
        events: [
          {
            id: "legacy-hook",
            enabled: false,
            event: "quota_low",
            executable: "unsafe-legacy-command",
            arguments: ["--run"],
            timeoutSeconds: 30,
          },
        ],
      },
    });
  });
});
