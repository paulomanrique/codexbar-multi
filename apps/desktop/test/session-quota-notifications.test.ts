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

  it("selects copy through the shared 23-locale catalog and falls back safely", () => {
    expect(
      sessionQuotaNotificationCopy(
        { id: "session-claude-depleted", provider: "claude", transition: "depleted" },
        "Claude",
        "pt-BR",
      ),
    ).toEqual({
      title: "Sessão do Claude esgotada",
      body: "0% restante. Avisaremos quando estiver disponível novamente.",
    });
    expect(
      sessionQuotaNotificationCopy(
        { id: "session-claude-restored", provider: "claude", transition: "restored" },
        "Claude",
        "unavailable-locale",
      ),
    ).toEqual({
      title: "Claude session restored",
      body: "Session quota is available again.",
    });
  });

  it("does not need Electron, identity, a credential, or a raw snapshot to deliver", () => {
    const shown: { title: string; body: string }[] = [];
    const adapter = makeDesktopSessionQuotaNotificationAdapter({
      nativeNotifications: {
        create: (content) => ({ show: () => shown.push({ ...content }) }),
      },
      providerName: (provider) => (provider === "claude" ? "Claude" : "unexpected"),
      locale: () => "en",
    });
    adapter.notify({ id: "session-claude-restored", provider: "claude", transition: "restored" });
    expect(shown).toEqual([
      { title: "Claude session restored", body: "Session quota is available again." },
    ]);
  });
});
