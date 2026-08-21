import { describe, expect, it } from "vite-plus/test";

import {
  makeDesktopSessionQuotaNotificationAdapter,
  sessionQuotaNotificationCopy,
} from "../src/main/session-quota-notifications.ts";

describe("desktop session quota notification adapter", () => {
  it("uses the upstream English copy and only receives a provider transition", () => {
    expect(
      sessionQuotaNotificationCopy(
        { id: "session-claude-depleted", provider: "claude", transition: "depleted" },
        "Claude",
      ),
    ).toEqual({
      title: "Claude session depleted",
      body: "0% left. Will notify when it's available again.",
    });
  });

  it("does not need Electron, identity, a credential, or a raw snapshot to deliver", () => {
    const shown: { title: string; body: string }[] = [];
    const adapter = makeDesktopSessionQuotaNotificationAdapter({
      nativeNotifications: {
        create: (content) => ({ show: () => shown.push({ ...content }) }),
      },
      providerName: (provider) => (provider === "claude" ? "Claude" : "unexpected"),
    });
    adapter.notify({ id: "session-claude-restored", provider: "claude", transition: "restored" });
    expect(shown).toEqual([
      { title: "Claude session restored", body: "Session quota is available again." },
    ]);
  });
});
