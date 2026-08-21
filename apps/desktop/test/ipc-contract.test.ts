import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  CostUsageQueryDTO,
  CostUsageRecordDTO,
  HistoryQueryDTO,
  InstallPluginRequestDTO,
  LoginRequestDTO,
  PluginApprovalRequestDTO,
  PluginSecretRequestDTO,
  ProviderSettingsDTO,
  ProviderSettingsListDTO,
  RemovePluginRequestDTO,
  RefreshProviderRequestDTO,
  ActivateClaudeSwapAccountRequestDTO,
  SpendDashboardDTO,
  SpendOverviewDTO,
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

  it("accepts only the Claude-scoped opaque account activation request", () => {
    const decode = Schema.decodeUnknownSync(ActivateClaudeSwapAccountRequestDTO);
    expect(decode({ provider: "claude", accountId: "source-account" })).toEqual({
      provider: "claude",
      accountId: "source-account",
    });
    expect(() => decode({ provider: "openai", accountId: "source-account" })).toThrow();
    expect(() => decode({ provider: "claude", accountId: "../../2" })).toThrow();
  });

  it("allows only a bounded first-party provider settings projection", () => {
    const decodeSettings = Schema.decodeUnknownSync(ProviderSettingsDTO);
    const decodeList = Schema.decodeUnknownSync(ProviderSettingsListDTO);
    expect(
      decodeSettings({
        provider: "openai",
        enabled: true,
        source: "api",
        availableSources: ["auto", "api"],
      }),
    ).toEqual({
      provider: "openai",
      enabled: true,
      source: "api",
      availableSources: ["auto", "api"],
    });
    expect(() =>
      decodeSettings({
        provider: "fixture-plugin",
        enabled: true,
        source: "api",
        availableSources: ["auto", "api"],
      }),
    ).toThrow();
    expect(() =>
      decodeSettings({
        provider: "openai",
        enabled: true,
        source: "endpoint-override",
        availableSources: ["auto", "api"],
      }),
    ).toThrow();
    expect(
      decodeSettings({
        provider: "openai",
        enabled: true,
        source: "api",
        availableSources: ["auto", "api"],
        apiKey: "must never cross IPC",
      }),
    ).toEqual({
      provider: "openai",
      enabled: true,
      source: "api",
      availableSources: ["auto", "api"],
    });
    expect(() =>
      decodeList({
        providers: Array.from({ length: 70 }, () => ({
          provider: "openai",
          enabled: true,
          source: "api",
          availableSources: ["auto", "api"],
        })),
      }),
    ).toThrow();
  });

  it("uses unique, high-level channels", () => {
    const channels = Object.values(DesktopChannels);
    expect(new Set(channels)).toHaveLength(channels.length);
    expect(channels.every((channel) => channel.startsWith("codexbar-multi:"))).toBe(true);
  });

  it("projects spend without account identifiers, paths, or configuration fingerprints", () => {
    const decodeOverview = Schema.decodeUnknownSync(SpendOverviewDTO);
    const decodeDashboard = Schema.decodeUnknownSync(SpendDashboardDTO);
    const overview = decodeOverview({
      schemaVersion: 1,
      revision: 1,
      generation: 2,
      loadedAt: "2026-08-20T00:00:00.000Z",
      isRefreshing: false,
      truncated: false,
      sources: [
        {
          provider: "codex",
          displayName: "Codex work",
          role: "subscription",
          state: "available",
          coverage: "estimated",
          sourceId: "profile:/private/path",
          ownershipFingerprint: "must never cross IPC",
        },
      ],
      totals: {
        inputTokens: 1,
        outputTokens: 2,
        totalTokens: 3,
        costUsd: 0.01,
        coveredDayCount: 1,
        sourceCount: 1,
      },
      providers: [
        {
          provider: "codex",
          displayName: "Codex",
          totals: {
            inputTokens: 1,
            outputTokens: 2,
            totalTokens: 3,
            costUsd: 0.01,
            coveredDayCount: 1,
            sourceCount: 1,
          },
        },
      ],
    });
    expect(JSON.stringify(overview)).not.toContain("profile:/private/path");
    expect(JSON.stringify(overview)).not.toContain("ownershipFingerprint");
    expect(overview.sources[0]).toMatchObject({ coverage: "estimated" });
    expect(
      decodeDashboard({
        overview,
        requestedDays: 30,
        dailyPoints: [
          { provider: "codex", day: "2026-08-20", inputTokens: 1, outputTokens: 2, costUsd: 0.01 },
        ],
      }),
    ).toMatchObject({ requestedDays: 30 });
    expect(() => decodeDashboard({ overview, requestedDays: 366, dailyPoints: [] })).toThrow();
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
    const decodeSecret = Schema.decodeUnknownSync(PluginSecretRequestDTO);
    expect(() =>
      decodeSecret({
        pluginId: "fixture-plugin",
        key: "TOKEN",
        operation: "read",
      }),
    ).toThrow();
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
