import { describe, expect, it, vi } from "vite-plus/test";

import {
  createApprovalBinding,
  makeApprovedPluginSandboxCapabilities,
  parsePluginManifest,
} from "../src/index.js";

function plugin() {
  return parsePluginManifest(
    {
      id: "sample-plugin",
      name: "Sample",
      endpoints: [{ setting: "baseUrl", policy: "https" }],
      settings: [
        { key: "baseUrl", title: "Base URL", type: "plain" },
        { key: "apiKey", title: "API key", type: "secure" },
      ],
      capabilities: ["browser-cookies"],
      cookieDomains: ["example.com"],
    },
    { allowsDynamicId: true },
  );
}

function makeCapabilities(
  settings: Record<string, string> = { baseUrl: "https://api.example.com" },
) {
  const manifest = plugin();
  const log = vi.fn();
  const capabilities = makeApprovedPluginSandboxCapabilities(manifest, {
    endpointSettings: settings,
    approvedBinding: createApprovalBinding(manifest, settings),
    readSetting: (key, secure) => (secure && key === "apiKey" ? "secret-value" : settings[key]),
    readCookie: (domain) => (domain === "example.com" ? "session=cookie-value" : undefined),
    log,
  });
  return { capabilities, log, settings };
}

describe("approved plugin sandbox capabilities", () => {
  it("denies undeclared settings, secure mismatches, and undeclared cookie domains", async () => {
    const { capabilities } = makeCapabilities();
    await expect(capabilities.getSetting("unknown", false)).rejects.toMatchObject({
      kind: "secret-access",
    });
    await expect(capabilities.getSetting("apiKey", false)).rejects.toMatchObject({
      kind: "secret-access",
    });
    await expect(capabilities.getCookie("other.example.com")).rejects.toMatchObject({
      kind: "secret-access",
    });
    await expect(capabilities.getCookie(".example.com")).rejects.toMatchObject({
      kind: "network-policy",
    });
  });

  it("fails closed when the live endpoint approval surface drifts", async () => {
    const { capabilities, settings } = makeCapabilities();
    settings.baseUrl = "https://other.example.com";
    await expect(capabilities.getSetting("apiKey", true)).rejects.toMatchObject({
      kind: "approval-drift",
    });
  });

  it("redacts every capability value resolved before forwarding plugin logs", async () => {
    const { capabilities, log } = makeCapabilities();
    await expect(capabilities.getSetting("baseUrl", false)).resolves.toBe(
      "https://api.example.com",
    );
    await expect(capabilities.getSetting("apiKey", true)).resolves.toBe("secret-value");
    await expect(capabilities.getCookie("EXAMPLE.COM")).resolves.toBe("session=cookie-value");
    await capabilities.log?.("https://api.example.com secret-value session=cookie-value safe");
    expect(log).toHaveBeenCalledWith("[REDACTED] [REDACTED] [REDACTED] safe");
  });
});
