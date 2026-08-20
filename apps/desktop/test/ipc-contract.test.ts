import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  CostUsageQueryDTO,
  CostUsageRecordDTO,
  HistoryQueryDTO,
  LoginRequestDTO,
} from "@codexbar/contracts";

import { DesktopChannels } from "../src/ipc/api.ts";

describe("desktop IPC boundary", () => {
  it("rejects invalid account and provider input before a handler runs", () => {
    const decode = Schema.decodeUnknownSync(LoginRequestDTO);
    expect(() => decode({ provider: "not-first-party", accountId: "default" })).toThrow();
    expect(() => decode({ provider: "t3chat", accountId: "../../escape" })).toThrow();
  });

  it("bounds provider-scoped history and cost queries before a handler runs", () => {
    const decodeHistory = Schema.decodeUnknownSync(HistoryQueryDTO);
    const decodeCosts = Schema.decodeUnknownSync(CostUsageQueryDTO);
    expect(() => decodeHistory({ provider: "not-first-party" })).toThrow();
    expect(() => decodeHistory({ provider: "codex", since: -1 })).toThrow();
    expect(() => decodeHistory({ provider: "codex", since: 1.5 })).toThrow();
    expect(() =>
      decodeHistory({ provider: "codex", since: Number.MAX_SAFE_INTEGER + 1 }),
    ).toThrow();
    expect(() => decodeHistory({ provider: "codex", limit: 10_001 })).toThrow();
    expect(() => decodeHistory({ provider: "codex", limit: 1.5 })).toThrow();
    expect(() => decodeCosts({ provider: "codex", limit: 0 })).toThrow();
    const decodeCostRecord = Schema.decodeUnknownSync(CostUsageRecordDTO);
    expect(() =>
      decodeCostRecord({
        providerId: "codex",
        recordedAt: 1,
        inputTokens: -1,
        outputTokens: 0,
        costUsd: 0,
      }),
    ).toThrow();
    expect(() =>
      decodeCostRecord({
        providerId: "codex",
        recordedAt: 1,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: -0.01,
      }),
    ).toThrow();
  });

  it("uses unique, high-level channels", () => {
    const channels = Object.values(DesktopChannels);
    expect(new Set(channels)).toHaveLength(channels.length);
    expect(channels.every((channel) => channel.startsWith("codexbar-multi:"))).toBe(true);
  });
});
