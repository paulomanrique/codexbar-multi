import { describe, expect, it } from "vite-plus/test";
import type { PersistedCodexBarConfig } from "@codexbar/core";

import {
  DesktopConfigMutations,
  providerSettingsFor,
  providerSettingsProjection,
  providerSettingsSourcesForKind,
  providerSettingsSourcesForStrategies,
  updateFirstPartyProviderSettings,
  updateSupportedFirstPartyProviderSettings,
} from "../src/main/provider-settings.ts";

const capabilities = [
  { id: "codex", availableSources: ["auto", "api"] },
  { id: "openai", availableSources: ["auto", "api"] },
  { id: "t3chat", availableSources: ["auto", "web"] },
  { id: "amp", availableSources: ["auto", "cli"] },
] as const;

const config: PersistedCodexBarConfig = {
  version: 1,
  providers: [
    {
      id: "openai",
      enabled: false,
      source: "api",
      apiKey: "not-renderer-visible",
      extensions: { upstreamOnly: { retain: true } },
    },
    {
      id: "fixture-plugin",
      enabled: true,
      source: "web",
      pluginSecrets: { TOKEN: "not-renderer-visible" },
      extensions: { pluginOnly: "retain" },
    },
  ],
};

describe("desktop provider settings", () => {
  it("projects only first-party enablement and source fields", () => {
    expect(providerSettingsProjection(config, capabilities.slice(0, 2))).toEqual([
      { provider: "codex", enabled: true, source: "auto", availableSources: ["auto", "api"] },
      {
        provider: "openai",
        enabled: false,
        source: "api",
        availableSources: ["auto", "api"],
      },
    ]);
  });

  it("maps runtime kinds to the only selectable explicit source", () => {
    expect(providerSettingsSourcesForKind("api")).toEqual(["auto", "api"]);
    expect(providerSettingsSourcesForKind("web")).toEqual(["auto", "web"]);
    expect(providerSettingsSourcesForKind("cli")).toEqual(["auto", "cli"]);
    expect(providerSettingsSourcesForKind("local")).toEqual(["auto", "cli"]);
    expect(providerSettingsSourcesForKind("oauth")).toEqual(["auto"]);
  });

  it("unions only declared source modes for a multi-strategy provider", () => {
    expect(providerSettingsSourcesForStrategies([{ kind: "api" }, { kind: "web" }])).toEqual([
      "auto",
      "api",
      "web",
    ]);
  });

  it("normalizes an unsupported persisted source in the returned projection", () => {
    const legacy = {
      ...config,
      providers: config.providers.map((provider) =>
        provider.id === "openai" ? { ...provider, source: "oauth" as const } : provider,
      ),
    };
    expect(
      providerSettingsFor(
        legacy,
        { provider: "openai", enabled: false, source: "api" },
        capabilities,
      ),
    ).toEqual({
      provider: "openai",
      enabled: false,
      source: "auto",
      availableSources: ["auto", "api"],
    });
  });

  it("updates only the requested first-party fields and preserves plugin and extension data", () => {
    const next = updateFirstPartyProviderSettings(config, {
      provider: "openai",
      enabled: true,
      source: "api",
    });
    expect(next.providers).toEqual([
      {
        id: "openai",
        enabled: true,
        source: "api",
        apiKey: "not-renderer-visible",
        extensions: { upstreamOnly: { retain: true } },
      },
      config.providers[1],
    ]);
  });

  it("adds a minimal first-party entry without changing unrelated entries", () => {
    const next = updateFirstPartyProviderSettings(config, {
      provider: "claude",
      enabled: true,
      source: "api",
    });
    expect(next.providers.at(-1)).toEqual({
      id: "claude",
      enabled: true,
      source: "api",
      extensions: {},
    });
    expect(next.providers[1]).toBe(config.providers[1]);
  });

  it("rejects an unsupported source before changing config", () => {
    expect(() =>
      updateSupportedFirstPartyProviderSettings(
        config,
        { provider: "openai", enabled: true, source: "web" },
        capabilities,
      ),
    ).toThrow("Provider source is not supported");
    expect(config.providers[0]).toEqual({
      id: "openai",
      enabled: false,
      source: "api",
      apiKey: "not-renderer-visible",
      extensions: { upstreamOnly: { retain: true } },
    });
  });

  it("returns the normalized saved projection rather than echoing the input", () => {
    const saved = updateSupportedFirstPartyProviderSettings(
      config,
      { provider: "openai", enabled: true, source: "api" },
      capabilities,
    );
    expect(
      providerSettingsFor(
        saved,
        { provider: "openai", enabled: true, source: "api" },
        capabilities,
      ),
    ).toEqual({
      provider: "openai",
      enabled: true,
      source: "api",
      availableSources: ["auto", "api"],
    });
  });

  it("serializes concurrent mutations and continues after a failed write", async () => {
    const mutations = new DesktopConfigMutations();
    const steps: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const first = mutations.run(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
          steps.push("first-start");
        }),
    );
    const second = mutations.run(async () => {
      steps.push("second");
    });
    await Promise.resolve();
    expect(steps).toEqual(["first-start"]);
    releaseFirst?.();
    await Promise.all([first, second]);
    await expect(
      mutations.run(async () => Promise.reject(new Error("save failed"))),
    ).rejects.toThrow("save failed");
    await mutations.run(async () => {
      steps.push("after-failure");
    });
    expect(steps).toEqual(["first-start", "second", "after-failure"]);
  });
});
