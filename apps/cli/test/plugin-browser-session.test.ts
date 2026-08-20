import { describe, expect, it } from "vite-plus/test";

import {
  decodePluginBrowserCredential,
  pluginBrowserCredentialKey,
} from "../src/plugin-browser-session.ts";

describe("CLI plugin browser-session credential wire", () => {
  it("accepts only the desktop-bound keyring payload for the declared plugin and domain", () => {
    const raw = JSON.stringify({
      version: 1,
      pluginId: "fixture-plugin",
      domain: "api.example.test",
      cookieHeader: "session=fixture",
    });
    expect(pluginBrowserCredentialKey("fixture-plugin", "API.EXAMPLE.TEST")).toBe(
      "plugin/fixture-plugin/browser-session/api.example.test",
    );
    expect(decodePluginBrowserCredential(raw, "fixture-plugin", "api.example.test")).toBe(
      "session=fixture",
    );
    expect(() => decodePluginBrowserCredential(raw, "other-plugin", "api.example.test")).toThrow(
      "invalid",
    );
    expect(() =>
      decodePluginBrowserCredential("session=plaintext", "fixture-plugin", "api.example.test"),
    ).toThrow("invalid");
  });
});
