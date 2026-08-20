import { describe, expect, it } from "vite-plus/test";

import {
  makePluginCredentialBrowserSessions,
  pluginBrowserCredentialKey,
  pluginBrowserCredentialPayload,
} from "../src/main/plugin-browser-session.ts";

describe("plugin credential browser sessions", () => {
  it("releases only the exact plugin/domain credential", async () => {
    const entries = new Map<string, string>();
    const sessions = makePluginCredentialBrowserSessions({
      read: async (key) => entries.get(key),
      remove: async (key) => void entries.delete(key),
    });
    entries.set(
      pluginBrowserCredentialKey("fixture-meter", "api.example.test"),
      pluginBrowserCredentialPayload("fixture-meter", "api.example.test", "session=fixture"),
    );
    expect(await sessions.readCookie("fixture-meter", "api.example.test")).toBe("session=fixture");
    expect(await sessions.readCookie("other-meter", "api.example.test")).toBeUndefined();
  });

  it("fails closed for a cross-plugin, cross-domain, or malformed keyring payload", async () => {
    const entries = new Map<string, string>();
    const sessions = makePluginCredentialBrowserSessions({
      read: async (key) => entries.get(key),
      remove: async () => undefined,
    });
    const key = pluginBrowserCredentialKey("fixture-meter", "api.example.test");
    entries.set(
      key,
      pluginBrowserCredentialPayload("other-meter", "api.example.test", "session=x"),
    );
    await expect(sessions.readCookie("fixture-meter", "api.example.test")).rejects.toThrow(
      "invalid",
    );
    entries.set(key, "not-json");
    await expect(sessions.readCookie("fixture-meter", "api.example.test")).rejects.toThrow(
      "invalid",
    );
  });

  it("removes only declared browser-session credentials", async () => {
    const entries = new Map<string, string>([
      [pluginBrowserCredentialKey("fixture-meter", "api.example.test"), "one"],
      [pluginBrowserCredentialKey("fixture-meter", "auth.example.test"), "two"],
      [pluginBrowserCredentialKey("other-meter", "api.example.test"), "other"],
    ]);
    const sessions = makePluginCredentialBrowserSessions({
      read: async (key) => entries.get(key),
      remove: async (key) => void entries.delete(key),
    });
    await sessions.remove("fixture-meter", ["api.example.test"]);
    expect(entries.has(pluginBrowserCredentialKey("fixture-meter", "api.example.test"))).toBe(
      false,
    );
    expect(entries.has(pluginBrowserCredentialKey("fixture-meter", "auth.example.test"))).toBe(
      true,
    );
    expect(entries.has(pluginBrowserCredentialKey("other-meter", "api.example.test"))).toBe(true);
  });
});
