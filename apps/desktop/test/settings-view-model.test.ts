import { describe, expect, it } from "vite-plus/test";

import {
  isAvailableProviderSource,
  sessionQuotaNotificationSettingsViewState,
} from "../src/renderer/settings-view-model.ts";

describe("settings view model", () => {
  it("offers only sources granted by the provider settings projection", () => {
    expect(isAvailableProviderSource("api", ["auto", "api"])).toBe(true);
    expect(isAvailableProviderSource("web", ["auto", "api"])).toBe(false);
    expect(isAvailableProviderSource("endpoint-override", ["auto", "web"])).toBe(false);
  });

  it("keeps the notification toggle disabled while loading/saving and scopes errors to it", () => {
    expect(sessionQuotaNotificationSettingsViewState(undefined, false, undefined)).toEqual({
      enabled: true,
      disabled: true,
      status: "loading",
    });
    expect(sessionQuotaNotificationSettingsViewState({ enabled: false }, true, undefined)).toEqual({
      enabled: false,
      disabled: true,
      status: "pending",
    });
    expect(
      sessionQuotaNotificationSettingsViewState({ enabled: true }, false, "Unavailable"),
    ).toEqual({
      enabled: true,
      disabled: false,
      status: "error",
    });
    expect(sessionQuotaNotificationSettingsViewState(undefined, false, "Unavailable")).toEqual({
      enabled: true,
      disabled: true,
      status: "error",
    });
  });
});
