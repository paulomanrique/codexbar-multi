import { describe, expect, it } from "vite-plus/test";

import { DesktopChannels } from "../src/ipc/api.ts";
import { makeProviderSettingsApi } from "../src/preload/provider-settings-api.ts";

describe("provider settings preload bridge", () => {
  it("decodes input before invoking the high-level update channel", async () => {
    const calls: Array<{ readonly channel: string; readonly input: unknown }> = [];
    const api = makeProviderSettingsApi(async (channel, input) => {
      calls.push({ channel, input });
      return {
        provider: "openai",
        enabled: false,
        source: "api",
        availableSources: ["auto", "api"],
        apiKey: "not-exposed",
      };
    });
    const result = await api.updateProviderSettings({
      provider: "openai",
      enabled: false,
      source: "api",
    });
    expect(calls).toEqual([
      {
        channel: DesktopChannels.updateProviderSettings,
        input: { provider: "openai", enabled: false, source: "api" },
      },
    ]);
    expect(result).toEqual({
      provider: "openai",
      enabled: false,
      source: "api",
      availableSources: ["auto", "api"],
    });
  });

  it("rejects untrusted settings output rather than exposing it to the renderer", async () => {
    const api = makeProviderSettingsApi(async () => ({
      providers: [
        {
          provider: "fixture-plugin",
          enabled: true,
          source: "api",
          availableSources: ["auto", "api"],
        },
      ],
    }));
    await expect(api.getProviderSettings()).rejects.toThrow();
  });
});
