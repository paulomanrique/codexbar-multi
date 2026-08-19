import { describe, expect, it } from "vite-plus/test";
import { ProviderRefreshCoordinator, type RefreshTaskHandle } from "../src/refresh-coordinator.ts";

interface ControlledTask extends RefreshTaskHandle {
  readonly cancelled: () => boolean;
  readonly finish: () => void;
}

function controlledTask(): ControlledTask {
  let finish!: () => void;
  let cancelled = false;
  const completion = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return {
    completion,
    cancel: () => {
      cancelled = true;
    },
    cancelled: () => cancelled,
    finish,
  };
}

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("ProviderRefreshCoordinator (Swift parity)", () => {
  it("cancels and orders predecessors while advancing the generation", async () => {
    const coordinator = new ProviderRefreshCoordinator<string>();
    const first = coordinator.beginReplacingRequest("codex");
    const firstTask = controlledTask();
    first.state.install(firstTask);

    const second = coordinator.beginReplacingRequest("codex");
    expect(firstTask.cancelled()).toBe(true);
    expect(second.predecessorStates).toEqual([first.state]);
    expect(coordinator.isCurrent(first.generation, "codex")).toBe(false);
    expect(coordinator.isCurrent(second.generation, "codex")).toBe(true);
    firstTask.finish();
    await firstTask.completion;
  });

  it("invalidates work without dropping waiter completion", async () => {
    const coordinator = new ProviderRefreshCoordinator<string>();
    const request = coordinator.beginReplacingRequest("codex");
    const task = controlledTask();
    request.state.install(task);
    const waiter = coordinator.wait("codex", request.state);

    coordinator.invalidateRequests("codex");
    expect(task.cancelled()).toBe(true);
    expect(coordinator.isCurrent(request.generation, "codex")).toBe(false);
    expect(coordinator.coalescingState("codex")).toBeUndefined();

    task.finish();
    coordinator.complete(request.state, "codex", false);
    await expect(waiter).resolves.toBe("completed");
  });

  it("coalesces the latest request independently per key", () => {
    const coordinator = new ProviderRefreshCoordinator<string>();
    const firstCodex = coordinator.beginReplacingRequest("codex");
    const claude = coordinator.beginReplacingRequest("claude");
    const latestCodex = coordinator.beginReplacingRequest("codex");

    expect(coordinator.coalescingState("codex")).toBe(latestCodex.state);
    expect(coordinator.coalescingState("claude")).toBe(claude.state);
    expect(coordinator.coalescingState("codex")).not.toBe(firstCodex.state);
  });

  it("keeps a shared task alive when only one waiter cancels", async () => {
    const coordinator = new ProviderRefreshCoordinator<string>();
    const request = coordinator.beginReplacingRequest("codex");
    const task = controlledTask();
    request.state.install(task);
    const ownerCancellation = new AbortController();
    const owner = coordinator.wait("codex", request.state, ownerCancellation.signal);
    const shared = coordinator.wait("codex", request.state);

    ownerCancellation.abort();
    expect(task.cancelled()).toBe(false);
    task.finish();
    coordinator.complete(request.state, "codex", false);
    await expect(owner).resolves.toBe("cancelled");
    await expect(shared).resolves.toBe("completed");
  });

  it("cancels an unfinished task when its last waiter cancels", async () => {
    const coordinator = new ProviderRefreshCoordinator<string>();
    const request = coordinator.beginReplacingRequest("codex");
    const task = controlledTask();
    request.state.install(task);
    const cancellation = new AbortController();
    const waiter = coordinator.wait("codex", request.state, cancellation.signal);

    cancellation.abort();
    expect(task.cancelled()).toBe(true);
    task.finish();
    await expect(waiter).resolves.toBe("cancelled");
  });

  it("exposes retry and removes completed states after waiters drain", async () => {
    const coordinator = new ProviderRefreshCoordinator<string>();
    const request = coordinator.beginReplacingRequest("codex");
    const task = controlledTask();
    request.state.install(task);
    const waiter = coordinator.wait("codex", request.state);
    task.finish();
    coordinator.complete(request.state, "codex", true);

    await expect(waiter).resolves.toBe("retryRequired");
    expect(coordinator.coalescingState("codex")).toBeUndefined();
    await flushMicrotasks();
  });

  it("tracks activity independently per key", () => {
    const coordinator = new ProviderRefreshCoordinator<string>();
    expect(coordinator.beginActivity("codex")).toBe(true);
    expect(coordinator.beginActivity("codex")).toBe(false);
    expect(coordinator.beginActivity("claude")).toBe(true);
    expect(coordinator.endActivity("codex")).toBe(false);
    expect(coordinator.endActivity("codex")).toBe(true);
    expect(coordinator.endActivity("claude")).toBe(true);
  });
});
