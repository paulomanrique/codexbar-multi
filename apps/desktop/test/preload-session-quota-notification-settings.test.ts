import { describe, expect, it } from "vite-plus/test";

import { DesktopChannels } from "../src/ipc/api.ts";
import { makeSessionQuotaNotificationSettingsApi } from "../src/preload/session-quota-notification-settings-api.ts";

describe("session quota notification settings preload bridge", () => {
  it("validates the complete Boolean request before invoking its explicit channel", async () => {
    const calls: Array<{ readonly channel: string; readonly input: unknown }> = [];
    const api = makeSessionQuotaNotificationSettingsApi(async (channel, input) => {
      calls.push({ channel, input });
      return { enabled: false, config: "never exposed" };
    });
    await expect(api.updateSessionQuotaNotificationSettings({ enabled: false })).resolves.toEqual({
      enabled: false,
    });
    expect(calls).toEqual([
      {
        channel: DesktopChannels.updateSessionQuotaNotificationSettings,
        input: { enabled: false },
      },
    ]);
    await expect(
      api.updateSessionQuotaNotificationSettings({ enabled: "no" } as never),
    ).rejects.toThrow();
  });

  it("rejects invalid host output rather than exposing it to the renderer", async () => {
    const api = makeSessionQuotaNotificationSettingsApi(async () => ({ enabled: "yes" }));
    await expect(api.getSessionQuotaNotificationSettings()).rejects.toThrow();
  });
});
