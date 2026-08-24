import { describe, expect, it } from "vite-plus/test";

import { DesktopChannels } from "../src/ipc/api.ts";

describe("default browser-session status main wiring", () => {
  it("uses a unique explicit channel", () => {
    expect(DesktopChannels.getDefaultBrowserSessionStatuses).toBe(
      "codexbar-multi:get-default-browser-session-statuses",
    );
    const channels = Object.values(DesktopChannels);
    expect(new Set(channels)).toHaveLength(channels.length);
  });

  it("validates void input, uses handleDesktopRequest, and wires the host reader", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../src/main/index.ts", import.meta.url), "utf8"),
    );
    const start = source.indexOf("DesktopChannels.getDefaultBrowserSessionStatuses");
    const end = source.indexOf("DesktopChannels.refreshProvider", start);
    const handler = source.slice(start, end);
    expect(handler).toContain("handleDesktopRequest");
    expect(handler).toContain("await decodeVoid(input)");
    expect(handler).toContain("decodeDefaultBrowserSessionStatuses");
    expect(handler).toContain("readDefaultBrowserSessionStatuses(credentials)");
  });
});
