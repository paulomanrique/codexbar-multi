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

const deferred = <T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
} => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("Desktop startup refresh parity", () => {
  it("calls refresh immediately before the first sleep", async () => {
    const queue = sleepQueue();
    let calls = 0;
    let refreshSignals: AbortSignal[] = [];
    const controller = new DesktopAdaptiveRefreshController(
      {
        now: () => new Date("2026-08-20T12:00:00.000Z"),
        sleep: queue.sleep,
        refresh: async (signal) => {
          refreshSignals.push(signal);
          calls += 1;
        },
        signals: () => ({ lowPowerModeEnabled: false, thermalPressure: "nominal" }),
      },
      { immediate: true },
    );

    controller.start();
    await flush();
    // Immediate refresh must have been invoked before any sleep is scheduled.
    expect(calls).toBe(1);
    expect(queue.requests).toHaveLength(1);
    expect(queue.requests[0]?.milliseconds).toBe(30 * 60_000);
    expect(refreshSignals[0]?.aborted).toBe(false);
    queue.requests[0]?.resolve();
    await flush();
    // First adaptive tick completed after the initial immediate refresh.
    expect(calls).toBe(2);
    expect(queue.requests).toHaveLength(2);
    controller.stop();
  });

  it("performs exactly one immediate refresh and then follows adaptive delays", async () => {
    const queue = sleepQueue();
    let calls = 0;
    const controller = new DesktopAdaptiveRefreshController(
      {
        now: () => new Date("2026-08-20T12:00:00.000Z"),
        sleep: queue.sleep,
        refresh: async () => {
          calls += 1;
        },
        signals: () => ({ lowPowerModeEnabled: false, thermalPressure: "nominal" }),
      },
      { immediate: true },
    );

    controller.start();
    await flush();
    expect(calls).toBe(1);
    expect(queue.requests).toHaveLength(1);
    expect(queue.requests[0]?.milliseconds).toBe(30 * 60_000);

    // Complete first adaptive tick.
    queue.requests[0]?.resolve();
    await flush();
    expect(calls).toBe(2);
    expect(queue.requests).toHaveLength(2);

    // A menu interaction after the initial refresh must not produce a second immediate refresh.
    const sleepBeforeMenu = queue.requests[1]!;
    controller.noteMenuOpen(new Date("2026-08-20T12:01:00.000Z"));
    await flush();
    expect(sleepBeforeMenu.signal.aborted).toBe(true);
    expect(calls).toBe(2);
    expect(queue.requests).toHaveLength(3);
    expect(queue.requests[2]?.milliseconds).toBe(2 * 60_000);

    queue.requests[2]?.resolve();
    await flush();
    expect(calls).toBe(3);
    controller.stop();
  });

  it("stop before or during the initial refresh aborts it and schedules nothing", async () => {
    const queue = sleepQueue();
    let refreshSignal: AbortSignal | undefined;
    let resolveRefresh!: () => void;
    let calls = 0;
    const controller = new DesktopAdaptiveRefreshController(
      {
        now: () => new Date("2026-08-20T12:00:00.000Z"),
        sleep: queue.sleep,
        refresh: (signal) =>
          new Promise<void>((resolve) => {
            refreshSignal = signal;
            calls += 1;
            resolveRefresh = resolve;
          }),
        signals: () => ({ lowPowerModeEnabled: false, thermalPressure: "nominal" }),
      },
      { immediate: true },
    );

    controller.start();
    await flush();
    expect(calls).toBe(1);
    expect(queue.requests).toHaveLength(0);
    expect(refreshSignal?.aborted).toBe(false);

    controller.stop();
    expect(refreshSignal?.aborted).toBe(true);

    resolveRefresh();
    await flush();
    // No sleep must have been scheduled after an aborted initial refresh.
    expect(queue.requests).toHaveLength(0);
    // And no further refresh after stop.
    await flush();
    expect(calls).toBe(1);
  });

  it("noteMenuOpen during initial refresh does not overlap a second refresh", async () => {
    const queue = sleepQueue();
    let calls = 0;
    let firstRefreshSignal: AbortSignal | undefined;
    const firstDeferred = deferred<void>();
    let secondDeferred: ReturnType<typeof deferred<void>> | undefined;

    const controller = new DesktopAdaptiveRefreshController(
      {
        now: () => new Date("2026-08-20T12:00:00.000Z"),
        sleep: queue.sleep,
        refresh: async (signal) => {
          calls += 1;
          if (calls === 1) {
            firstRefreshSignal = signal;
            await firstDeferred.promise;
            return;
          }
          // Second refresh (after the initial) would use this deferred if it were started overlapping.
          secondDeferred = deferred<void>();
          await secondDeferred.promise;
        },
        signals: () => ({ lowPowerModeEnabled: false, thermalPressure: "nominal" }),
      },
      { immediate: true },
    );

    controller.start();
    await flush();
    expect(calls).toBe(1);
    expect(queue.requests).toHaveLength(0);
    expect(firstRefreshSignal?.aborted).toBe(false);

    // Menu open while initial refresh is still in flight must not start a second refresh.
    controller.noteMenuOpen(new Date("2026-08-20T12:00:30.000Z"));
    await flush();
    expect(calls).toBe(1);
    expect(firstRefreshSignal?.aborted).toBe(false);
    expect(queue.requests).toHaveLength(0);

    // Complete the initial refresh; now the timer should schedule with the updated menu timestamp (2 minutes).
    firstDeferred.resolve();
    await flush();
    expect(queue.requests).toHaveLength(1);
    expect(queue.requests[0]?.milliseconds).toBe(2 * 60_000);
    expect(calls).toBe(1);

    queue.requests[0]?.resolve();
    await flush();
    expect(calls).toBe(2);

    // Superseded generation ownership: old sleep abort must not clear successor controller.
    // Resolve the now-current refresh to avoid dangling.
    secondDeferred?.resolve();
    await flush();
    controller.stop();
  });

  it("contains a refresh failure and continues with the next delayed retry", async () => {
    const queue = sleepQueue();
    let calls = 0;
    const controller = new DesktopAdaptiveRefreshController(
      {
        now: () => new Date("2026-08-20T12:00:00.000Z"),
        sleep: queue.sleep,
        refresh: async () => {
          calls += 1;
          if (calls === 1) throw new Error("redacted provider failure");
        },
        signals: () => ({ lowPowerModeEnabled: false, thermalPressure: "nominal" }),
      },
      { immediate: true },
    );

    controller.start();
    await flush();
    // Immediate failure must be contained and still schedule the next sleep.
    expect(calls).toBe(1);
    expect(queue.requests).toHaveLength(1);
    expect(queue.requests[0]?.milliseconds).toBe(30 * 60_000);

    queue.requests[0]?.resolve();
    await flush();
    expect(calls).toBe(2);
    expect(queue.requests).toHaveLength(2);
    controller.stop();
  });

  it("a superseded generation cannot clear its successor", async () => {
    const queue = sleepQueue();
    let calls = 0;
    const refreshSignals: AbortSignal[] = [];
    const controller = new DesktopAdaptiveRefreshController(
      {
        now: () => new Date("2026-08-20T12:00:00.000Z"),
        sleep: queue.sleep,
        refresh: async (signal) => {
          refreshSignals.push(signal);
          calls += 1;
          // Small async gap to allow supersession.
          await Promise.resolve();
        },
        signals: () => ({ lowPowerModeEnabled: false, thermalPressure: "nominal" }),
      },
      { immediate: true },
    );

    controller.start();
    await flush();
    expect(calls).toBe(1);
    expect(queue.requests).toHaveLength(1);
    const firstSleep = queue.requests[0]!;

    // Trigger a generation replacement via menu interaction after the initial refresh completed.
    // First resolve the initial immediate's following sleep's interval? Actually we already scheduled first sleep.
    // Wait for first adaptive refresh to complete, then do menu open to supersede.
    firstSleep.resolve();
    await flush();
    expect(calls).toBe(2);
    expect(queue.requests).toHaveLength(2);
    const secondSleep = queue.requests[1]!;

    controller.noteMenuOpen(new Date("2026-08-20T12:02:00.000Z"));
    await flush();
    expect(secondSleep.signal.aborted).toBe(true);
    // Successor generation must have scheduled a new sleep and not been cleared by the predecessor.
    expect(queue.requests).toHaveLength(3);
    expect(queue.requests[2]?.milliseconds).toBe(2 * 60_000);
    // Successor's refresh signal must be distinct and not aborted by the old generation's cleanup.
    queue.requests[2]?.resolve();
    await flush();
    expect(calls).toBe(3);
    // The successor's refresh completed before stop, so its signal is not aborted.
    // Capture the signal before stop to avoid the stop-abort side effect on the same object.
    const thirdSignalAbortedBeforeStop = refreshSignals[2]?.aborted ?? false;
    expect(thirdSignalAbortedBeforeStop).toBe(false);
    expect(queue.requests).toHaveLength(4);
    controller.stop();
    expect(queue.requests).toHaveLength(4);
  });

  it("preserves non-immediate behavior for hosts that do not opt in", async () => {
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
    expect(calls).toBe(0);
    expect(queue.requests).toHaveLength(1);
    expect(queue.requests[0]?.milliseconds).toBe(30 * 60_000);
    controller.stop();
  });
});
