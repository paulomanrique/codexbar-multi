import { describe, expect, it } from "vite-plus/test";
import {
  decodeCodexBarConfig,
  encodeCodexBarConfig,
  type PersistedCodexBarConfig,
} from "@codexbar/core";

import { DesktopConfigMutations } from "../src/main/provider-settings.ts";
import {
  sessionQuotaNotificationSettingsProjection,
  updateSessionQuotaNotificationSettings,
} from "../src/main/session-quota-notification-settings.ts";

const config: PersistedCodexBarConfig = {
  version: 1,
  providers: [
    {
      id: "openai",
      enabled: true,
      source: "api",
      extensions: { endpointVariant: "upstream" },
    },
    {
      id: "fixture-plugin",
      enabled: true,
      source: "web",
      pluginSettings: { endpoint: "https://example.test" },
      extensions: { pluginOnly: true },
    },
  ],
  hooks: { enabled: true, events: [] },
};

describe("session quota notification settings", () => {
  it("uses the upstream enabled default when a legacy config omits the key", () => {
    expect(sessionQuotaNotificationSettingsProjection(config)).toEqual({ enabled: true });
  });

  it("changes only the global Boolean and preserves plugins/extensions through serialization", () => {
    const next = updateSessionQuotaNotificationSettings(config, { enabled: false });
    expect(next).toEqual({ ...config, sessionQuotaNotificationsEnabled: false });
    expect(next.providers[0]).toBe(config.providers[0]);
    expect(next.providers[1]).toBe(config.providers[1]);
    expect(
      decodeCodexBarConfig(encodeCodexBarConfig(next), {
        pluginProviderIds: new Set(["fixture-plugin"]),
      }),
    ).toEqual(next);
  });

  it("does not advance an in-memory preference when the atomic write fails", async () => {
    const mutations = new DesktopConfigMutations();
    let current = config;
    const save = async (_next: PersistedCodexBarConfig): Promise<void> => {
      throw new Error("disk full");
    };
    await expect(
      mutations.run(async () => {
        const next = updateSessionQuotaNotificationSettings(current, { enabled: false });
        await save(next);
        current = next;
      }),
    ).rejects.toThrow("disk full");
    expect(sessionQuotaNotificationSettingsProjection(current)).toEqual({ enabled: true });
  });
});
