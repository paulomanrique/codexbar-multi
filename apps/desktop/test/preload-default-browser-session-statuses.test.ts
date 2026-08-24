import { describe, expect, it } from "vite-plus/test";

import { DesktopChannels } from "../src/ipc/api.ts";
import { makeDefaultBrowserSessionStatusesApi } from "../src/preload/default-browser-session-statuses-api.ts";

describe("default browser-session statuses preload bridge", () => {
  it("invokes only the exact parameterless status channel and decodes output", async () => {
    const calls: Array<{ readonly channel: string; readonly input: unknown }> = [];
    const api = makeDefaultBrowserSessionStatusesApi(async (channel, input) => {
      calls.push({ channel, input });
      return {
        schemaVersion: 1,
        t3chatDefault: "persisted",
        grokDefault: "absent",
        cookieHeaders: { "t3.chat": "__session=must-not-cross" },
      };
    });
    await expect(api.getDefaultBrowserSessionStatuses()).resolves.toEqual({
      schemaVersion: 1,
      t3chatDefault: "persisted",
      grokDefault: "absent",
    });
    expect(calls).toEqual([
      { channel: DesktopChannels.getDefaultBrowserSessionStatuses, input: undefined },
    ]);
  });

  it("rejects malformed main-process output rather than exposing it", async () => {
    const api = makeDefaultBrowserSessionStatusesApi(async () => ({
      schemaVersion: 1,
      t3chatDefault: "persisted",
      grokDefault: "logged-out",
    }));
    await expect(api.getDefaultBrowserSessionStatuses()).rejects.toThrow();
  });

  it("does not use generic IPC, subscriptions, or credential key helpers", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(
        new URL("../src/preload/default-browser-session-statuses-api.ts", import.meta.url),
        "utf8",
      ),
    );
    expect(source).toContain("DesktopChannels.getDefaultBrowserSessionStatuses");
    expect(source).not.toContain("ipcRenderer.on");
    expect(source).not.toContain("subscribe");
    expect(source).not.toContain("browser-session/");
    expect(source).not.toContain('invoke("');
  });
});
