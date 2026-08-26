import { describe, expect, it } from "vite-plus/test";

import {
  isAvailableProviderSource,
  optimisticTokenAccountRoster,
  sessionQuotaNotificationSettingsViewState,
  tokenAccountDetail,
  tokenAccountLabel,
  tokenAccountSelectionViewState,
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

  it("projects metadata-only token accounts without exposing opaque IDs as labels", () => {
    const roster = {
      provider: "codex",
      accounts: [
        { id: "opaque-1", label: "", externalIdentifier: "team@example.test", addedAt: 1 },
        { id: "opaque-2", label: "Work", usageScope: "Team", addedAt: 2 },
      ],
      activeIndex: 0,
      selectionAvailable: true,
      revision: "a".repeat(64),
    } as const;
    const state = tokenAccountSelectionViewState(roster, false, false, undefined);
    expect(state.activeId).toBe("opaque-1");
    expect(state.disabled).toBe(false);
    expect(state.status).toBe("ready");
    expect(tokenAccountLabel(roster.accounts[0], "Saved account")).toBe("team@example.test");
    expect(tokenAccountLabel(roster.accounts[1], "Saved account")).toBe("Work");
    expect(tokenAccountLabel({ id: "opaque-3", label: "", addedAt: 3 }, "Saved account")).toBe(
      "Saved account",
    );
    expect(tokenAccountDetail(roster.accounts[1])).toBe("Team");

    const optimistic = optimisticTokenAccountRoster(roster, "opaque-2");
    expect(optimistic?.activeIndex).toBe(1);
    expect(optimistic?.revision).toBe(roster.revision);
    expect(optimisticTokenAccountRoster(roster, "not-listed")).toBeUndefined();
  });

  it("keeps token-account loading, empty, pending and error states local", () => {
    const empty = {
      provider: "codex",
      accounts: [],
      activeIndex: 0,
      selectionAvailable: true,
      revision: "b".repeat(64),
    } as const;
    expect(tokenAccountSelectionViewState(undefined, true, false, undefined)).toMatchObject({
      disabled: true,
      status: "loading",
    });
    expect(tokenAccountSelectionViewState(empty, false, false, undefined)).toMatchObject({
      disabled: true,
      status: "empty",
    });
    expect(tokenAccountSelectionViewState(empty, false, true, undefined).status).toBe("pending");
    expect(tokenAccountSelectionViewState(empty, false, false, "Unavailable").status).toBe("error");
  });
});
