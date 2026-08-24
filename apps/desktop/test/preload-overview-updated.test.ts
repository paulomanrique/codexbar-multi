import { describe, expect, it } from "vite-plus/test";

import { DesktopChannels } from "../src/ipc/api.ts";
import {
  makeOverviewUpdatedApi,
  type DesktopEventListener,
} from "../src/preload/overview-updated-api.ts";

describe("overview updated preload bridge", () => {
  it("subscribes to the exact channel and discards event and payload arguments", () => {
    let subscribedChannel: string | undefined;
    let subscribedWrapper: DesktopEventListener | undefined;
    const removals: Array<{
      readonly channel: string;
      readonly listener: DesktopEventListener;
    }> = [];
    const api = makeOverviewUpdatedApi(
      (channel, listener) => {
        subscribedChannel = channel;
        subscribedWrapper = listener;
      },
      (channel, listener) => {
        removals.push({ channel, listener });
      },
    );
    const calls: unknown[][] = [];

    const unsubscribe = api.onOverviewUpdated((...args) => {
      calls.push(args);
    });
    subscribedWrapper?.(
      { sender: "electron event must not cross" },
      { snapshot: "sensitive" },
      "provider-id",
      new Error("secret path"),
    );

    expect(subscribedChannel).toBe(DesktopChannels.overviewUpdated);
    expect(calls).toEqual([[]]);

    unsubscribe();
    unsubscribe();
    expect(removals).toEqual([
      {
        channel: DesktopChannels.overviewUpdated,
        listener: subscribedWrapper,
      },
    ]);
  });

  it("keeps the subscription bridge explicit and free of generic IPC exposure", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../src/preload/overview-updated-api.ts", import.meta.url), "utf8"),
    );
    expect(source).toContain("DesktopChannels.overviewUpdated");
    expect(source).not.toContain("ipcRenderer");
    expect(source).not.toContain("invoke");
  });
});
