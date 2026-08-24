import { describe, expect, it } from "vite-plus/test";

import {
  refreshAndReportPersistence,
  refreshOverviewAndPublish,
} from "../src/main/overview-publication.ts";

describe("overview background publication", () => {
  it("reports a committed snapshot even when an auxiliary step fails", async () => {
    const controller = new AbortController();
    const result = await refreshAndReportPersistence({
      signal: controller.signal,
      persist: async () => "committed",
      afterPersist: async () => {
        throw new Error("auxiliary history failed");
      },
    });

    expect(result).toBe(true);
  });

  it("reports no persistence when the provider refresh fails before commit", async () => {
    const controller = new AbortController();
    const result = await refreshAndReportPersistence({
      signal: controller.signal,
      persist: async () => {
        throw new Error("fetch failed");
      },
      afterPersist: async () => undefined,
    });

    expect(result).toBe(false);
  });

  it("publishes exactly once after a persisted refresh", async () => {
    const controller = new AbortController();
    let publishes = 0;
    let receivedSignal: AbortSignal | undefined;

    await refreshOverviewAndPublish({
      signal: controller.signal,
      refresh: async (signal) => {
        receivedSignal = signal;
        return true;
      },
      publish: () => {
        publishes += 1;
      },
    });

    expect(receivedSignal).toBe(controller.signal);
    expect(publishes).toBe(1);
  });

  it("does not publish when no provider persisted a snapshot", async () => {
    const controller = new AbortController();
    let publishes = 0;

    await refreshOverviewAndPublish({
      signal: controller.signal,
      refresh: async () => false,
      publish: () => {
        publishes += 1;
      },
    });

    expect(publishes).toBe(0);
  });

  it("does not publish when aborted before or after persistence", async () => {
    const before = new AbortController();
    before.abort();
    let beforeRefreshes = 0;
    let publishes = 0;

    await refreshOverviewAndPublish({
      signal: before.signal,
      refresh: async () => {
        beforeRefreshes += 1;
        return true;
      },
      publish: () => {
        publishes += 1;
      },
    });

    const after = new AbortController();
    await refreshOverviewAndPublish({
      signal: after.signal,
      refresh: async () => {
        after.abort();
        return true;
      },
      publish: () => {
        publishes += 1;
      },
    });

    expect(beforeRefreshes).toBe(0);
    expect(publishes).toBe(0);
  });

  it("does not publish when refresh rejects", async () => {
    const controller = new AbortController();
    let publishes = 0;

    await expect(
      refreshOverviewAndPublish({
        signal: controller.signal,
        refresh: async () => {
          throw new Error("provider failure");
        },
        publish: () => {
          publishes += 1;
        },
      }),
    ).rejects.toThrow("provider failure");
    expect(publishes).toBe(0);
  });
});
