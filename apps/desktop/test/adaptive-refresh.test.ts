import { describe, expect, it } from "vite-plus/test";

import { DesktopAdaptiveRefreshController } from "../src/main/adaptive-refresh.ts";

interface SleepRequest {
  readonly milliseconds: number;
  readonly signal: AbortSignal;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const sleepQueue = (): {
  readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly requests: SleepRequest[];
} => {
  const requests: SleepRequest[] = [];
  return {
    sleep: (milliseconds, signal) =>
      new Promise<void>((resolve, reject) => {
        const abort = () => reject(new Error("aborted"));
        signal.addEventListener("abort", abort, { once: true });
        requests.push({
          milliseconds,
          signal,
          resolve: () => {
            signal.removeEventListener("abort", abort);
            resolve();
          },
          reject: (error) => {
            signal.removeEventListener("abort", abort);
            reject(error);
          },
        });
      }),
    requests,
  };
};

describe("Desktop adaptive refresh composition", () => {
  it("uses the portable policy and refreshes only after its scheduled delay", async () => {
    const queue = sleepQueue();
    let calls = 0;
    const controller = new DesktopAdaptiveRefreshController({
      now: () => new Date("2026-08-20T12:00:00.000Z"),
      sleep: queue.sleep,
      refresh: async () => {
        calls += 1;
      },
      signals: () => ({ lowPowerModeEnabled: false, thermalPressure: "nominal" }),
    });

    controller.start();
    await flush();
    expect(queue.requests).toHaveLength(1);
    expect(queue.requests[0]?.milliseconds).toBe(30 * 60_000);
    expect(calls).toBe(0);
    queue.requests[0]?.resolve();
    await flush();
    expect(calls).toBe(1);
    controller.stop();
  });

  it("cancels the old sleep and reschedules from a menu interaction without overlapping work", async () => {
    const queue = sleepQueue();
    let calls = 0;
    const controller = new DesktopAdaptiveRefreshController({
      now: () => new Date("2026-08-20T12:00:00.000Z"),
      sleep: queue.sleep,
      refresh: async () => {
        calls += 1;
      },
      signals: () => ({ lowPowerModeEnabled: false, thermalPressure: "nominal" }),
    });

    controller.start();
    await flush();
    const idleSleep = queue.requests[0];
    controller.noteMenuOpen();
    await flush();
    expect(idleSleep?.signal.aborted).toBe(true);
    expect(queue.requests).toHaveLength(2);
    expect(queue.requests[1]?.milliseconds).toBe(2 * 60_000);
    queue.requests[1]?.resolve();
    await flush();
    expect(calls).toBe(1);
    controller.stop();
  });

  it("cancels the active refresh generation on shutdown and never schedules another tick", async () => {
    const queue = sleepQueue();
    let refreshSignal: AbortSignal | undefined;
    let resolveRefresh: (() => void) | undefined;
    const controller = new DesktopAdaptiveRefreshController({
      now: () => new Date("2026-08-20T12:00:00.000Z"),
      sleep: queue.sleep,
      refresh: (signal) =>
        new Promise<void>((resolve) => {
          refreshSignal = signal;
          resolveRefresh = resolve;
        }),
      signals: () => ({ lowPowerModeEnabled: false, thermalPressure: "nominal" }),
    });

    controller.start();
    await flush();
    queue.requests[0]?.resolve();
    await flush();
    controller.stop();
    expect(refreshSignal?.aborted).toBe(true);
    resolveRefresh?.();
    await flush();
    expect(queue.requests).toHaveLength(1);
  });

  it("keeps scheduling after a provider-local refresh failure", async () => {
    const queue = sleepQueue();
    const controller = new DesktopAdaptiveRefreshController({
      now: () => new Date("2026-08-20T12:00:00.000Z"),
      sleep: queue.sleep,
      refresh: async () => {
        throw new Error("redacted provider failure");
      },
      signals: () => ({ lowPowerModeEnabled: false, thermalPressure: "nominal" }),
    });

    controller.start();
    await flush();
    queue.requests[0]?.resolve();
    await flush();
    expect(queue.requests).toHaveLength(2);
    controller.stop();
  });
});
