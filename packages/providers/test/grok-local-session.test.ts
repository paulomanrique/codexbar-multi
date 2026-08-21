import { describe, expect, it } from "vite-plus/test";

import {
  GROK_LOCAL_SESSION_MAX_TOTAL_TOKENS,
  parseGrokLocalSessionSignal,
  summarizeGrokLocalSessions,
} from "../src/providers/grok-local-session.ts";

describe("Grok local session projection", () => {
  it("aggregates only allow-listed signal fields and ranks models by use", () => {
    const first = parseGrokLocalSessionSignal(
      {
        totalTokensBeforeCompaction: 12,
        contextTokensUsed: 8,
        primaryModelId: " grok-4 ",
        modelsUsed: ["grok-4", "grok-code"],
        credential: "must not project",
      },
      100,
    );
    const second = parseGrokLocalSessionSignal(
      { totalTokensBeforeCompaction: 5, modelsUsed: ["grok-code"] },
      200,
    );
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(summarizeGrokLocalSessions([first!, second!])).toEqual({
      sessionCount: 2,
      totalTokens: 25,
      lastSessionAtMs: 200,
      primaryModel: "grok-4",
      models: ["grok-4", "grok-code"],
    });
  });

  it("matches Swift's strict JSON shape handling for malformed rows", () => {
    expect(parseGrokLocalSessionSignal([], 1)).toBeUndefined();
    expect(
      parseGrokLocalSessionSignal(
        { totalTokensBeforeCompaction: 1.5, contextTokensUsed: true, modelsUsed: ["ok", 2] },
        1,
      ),
    ).toEqual({
      modifiedAtMs: 1,
      totalTokensBeforeCompaction: 0,
      contextTokensUsed: 0,
      modelsUsed: [],
    });
  });

  it("saturates total tokens rather than overflowing a JavaScript-safe integer", () => {
    expect(
      summarizeGrokLocalSessions([
        {
          modifiedAtMs: 1,
          totalTokensBeforeCompaction: Number.MAX_SAFE_INTEGER,
          contextTokensUsed: Number.MAX_SAFE_INTEGER,
          modelsUsed: [],
        },
      ]).totalTokens,
    ).toBe(GROK_LOCAL_SESSION_MAX_TOTAL_TOKENS);
  });
});
