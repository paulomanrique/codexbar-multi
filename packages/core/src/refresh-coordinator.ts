/** A cancellable unit owned by the refresh coordinator. */
export interface RefreshTaskHandle {
  readonly completion: Promise<void>;
  readonly cancel: () => void;
}

export type RefreshWaitResult = "completed" | "retryRequired" | "cancelled";

export interface RefreshRequest {
  readonly generation: number;
  readonly state: ProviderRefreshTaskState;
  readonly predecessorStates: ReadonlyArray<ProviderRefreshTaskState>;
}

/**
 * Platform-independent port of ProviderRefreshCoordinator.swift.
 *
 * It owns replacement generations, coalesced waiters and cancellation only;
 * provider execution and UI activity remain outside this small state machine.
 */
export class ProviderRefreshCoordinator<Key> {
  private readonly states = new Map<Key, ProviderRefreshTaskState[]>();
  private readonly latestGenerations = new Map<Key, number>();
  private readonly activeCounts = new Map<Key, number>();
  private nextGeneration = 0;
  private nextWaiterId = 0;

  coalescingState(key: Key): ProviderRefreshTaskState | undefined {
    const latestGeneration = this.latestGenerations.get(key);
    if (latestGeneration === undefined) return undefined;
    return this.states
      .get(key)
      ?.findLast((state) => state.generation === latestGeneration && !state.isCompleted);
  }

  beginReplacingRequest(key: Key): RefreshRequest {
    const generation = ++this.nextGeneration;
    const predecessorStates = [...(this.states.get(key) ?? [])];
    for (const state of predecessorStates) state.cancelTask();
    this.latestGenerations.set(key, generation);

    const state = new ProviderRefreshTaskState(generation);
    const states = this.states.get(key) ?? [];
    states.push(state);
    this.states.set(key, states);
    return { generation, state, predecessorStates };
  }

  invalidateRequests(key: Key): void {
    this.latestGenerations.set(key, ++this.nextGeneration);
    for (const state of this.states.get(key) ?? []) state.cancelTask();
  }

  async wait(
    key: Key,
    state: ProviderRefreshTaskState,
    signal?: AbortSignal,
  ): Promise<RefreshWaitResult> {
    const waiterId = ++this.nextWaiterId;
    const task = state.addWaiter(waiterId);
    if (task === undefined) return "completed";

    let cancelled = signal?.aborted ?? false;
    const cancel = (): void => {
      cancelled = true;
      state.cancelWaiter(waiterId);
    };
    signal?.addEventListener("abort", cancel, { once: true });
    if (cancelled) state.cancelWaiter(waiterId);

    try {
      await task.completion.catch(() => undefined);
    } finally {
      signal?.removeEventListener("abort", cancel);
      state.finishWaiter(waiterId);
      if (state.canRemove) this.scheduleRemoval(key, state);
    }

    if (cancelled) return "cancelled";
    return state.shouldRetry ? "retryRequired" : "completed";
  }

  complete(state: ProviderRefreshTaskState, key: Key, retryRequired: boolean): void {
    state.markCompleted(retryRequired);
    this.scheduleRemoval(key, state);
  }

  remove(state: ProviderRefreshTaskState, key: Key): void {
    const remaining = (this.states.get(key) ?? []).filter((candidate) => candidate !== state);
    if (remaining.length === 0) this.states.delete(key);
    else this.states.set(key, remaining);
  }

  isCurrent(generation: number, key: Key): boolean {
    return this.latestGenerations.get(key) === generation;
  }

  beginActivity(key: Key): boolean {
    const count = (this.activeCounts.get(key) ?? 0) + 1;
    this.activeCounts.set(key, count);
    return count === 1;
  }

  endActivity(key: Key): boolean {
    const remaining = Math.max(0, (this.activeCounts.get(key) ?? 1) - 1);
    if (remaining === 0) {
      this.activeCounts.delete(key);
      return true;
    }
    this.activeCounts.set(key, remaining);
    return false;
  }

  private scheduleRemoval(key: Key, state: ProviderRefreshTaskState): void {
    queueMicrotask(() => {
      if (this.states.get(key)?.includes(state) === true && state.canRemove) {
        this.remove(state, key);
      }
    });
  }
}

export class ProviderRefreshTaskState {
  readonly generation: number;

  private task: RefreshTaskHandle | undefined;
  private readonly waiterIds = new Set<number>();
  private completed = false;
  private retryRequired = false;

  constructor(generation: number) {
    this.generation = generation;
  }

  install(task: RefreshTaskHandle): void {
    this.task = task;
  }

  addWaiter(waiterId: number): RefreshTaskHandle | undefined {
    this.waiterIds.add(waiterId);
    return this.task;
  }

  cancelWaiter(waiterId: number): void {
    if (!this.waiterIds.delete(waiterId)) return;
    if (this.waiterIds.size === 0 && !this.completed) this.task?.cancel();
  }

  finishWaiter(waiterId: number): void {
    this.waiterIds.delete(waiterId);
  }

  markCompleted(retryRequired: boolean): void {
    this.completed = true;
    this.retryRequired = retryRequired;
  }

  cancelTask(): void {
    if (!this.completed) this.task?.cancel();
  }

  async waitForTaskCompletion(): Promise<void> {
    await this.task?.completion.catch(() => undefined);
  }

  get shouldRetry(): boolean {
    return this.retryRequired;
  }

  get isCompleted(): boolean {
    return this.completed;
  }

  get canRemove(): boolean {
    return this.completed && this.waiterIds.size === 0;
  }
}
