import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  CostUsageQueryDTO,
  CostUsageRecordDTO,
  HistoryQueryDTO,
  InstallPluginRequestDTO,
  LoginRequestDTO,
  PluginApprovalRequestDTO,
  RemovePluginRequestDTO,
  RefreshProviderRequestDTO,
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

  it("accepts only provider-scoped high-level refresh input", () => {
    const decode = Schema.decodeUnknownSync(RefreshProviderRequestDTO);
    expect(() => decode({ provider: "not-first-party" })).toThrow();
    expect(() => decode({ provider: "openai", source: "endpoint-override" })).toThrow();
    expect(decode({ provider: "openai", source: "api" })).toEqual({
      provider: "openai",
      source: "api",
    });
  });

  it("uses unique, high-level channels", () => {
    const channels = Object.values(DesktopChannels);
    expect(new Set(channels)).toHaveLength(channels.length);
    expect(channels.every((channel) => channel.startsWith("codexbar-multi:"))).toBe(true);
  });

  it("bounds plugin lifecycle input and never accepts a filesystem path", () => {
    const decodeInstall = Schema.decodeUnknownSync(InstallPluginRequestDTO);
    const decodeApproval = Schema.decodeUnknownSync(PluginApprovalRequestDTO);
    const decodeRemove = Schema.decodeUnknownSync(RemovePluginRequestDTO);
    expect(decodeInstall({ source: "defineProvider({})", language: "javascript" })).toEqual({
      source: "defineProvider({})",
      language: "javascript",
    });
    expect(() => decodeInstall({ path: "/tmp/plugin.js", language: "javascript" })).toThrow();
    expect(() =>
      decodeInstall({ source: "x".repeat(1_048_577), language: "javascript" }),
    ).toThrow();
    expect(() => decodeRemove({ pluginId: "../escape" })).toThrow();
    expect(() =>
      decodeApproval({
        pluginId: "fixture-plugin",
        settings: Object.fromEntries(
          Array.from({ length: 33 }, (_, index) => [`KEY${index}`, "value"]),
        ),
        typedConfirmations: {},
      }),
    ).toThrow();
  });
});
