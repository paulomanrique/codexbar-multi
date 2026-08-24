export interface OverviewPublicationOptions {
  readonly signal: AbortSignal;
  readonly refresh: (signal: AbortSignal) => Promise<boolean>;
  readonly publish: () => void;
}

export interface PersistedRefreshOptions<Value> {
  readonly signal: AbortSignal;
  readonly persist: (signal: AbortSignal) => Promise<Value>;
  readonly afterPersist: (value: Value, signal: AbortSignal) => Promise<void>;
}

/** Auxiliary failures must not erase the fact that the snapshot already committed. */
export const refreshAndReportPersistence = async <Value>({
  signal,
  persist,
  afterPersist,
}: PersistedRefreshOptions<Value>): Promise<boolean> => {
  let persisted = false;
  try {
    const value = await persist(signal);
    persisted = true;
    if (!signal.aborted) await afterPersist(value, signal);
    return true;
  } catch {
    if (signal.aborted) throw new Error("Adaptive refresh was cancelled.");
    return persisted;
  }
};

/**
 * Publishes one renderer invalidation for a consolidated background refresh
 * only after at least one snapshot persisted and the generation still owns the signal.
 */
export const refreshOverviewAndPublish = async ({
  signal,
  refresh,
  publish,
}: OverviewPublicationOptions): Promise<void> => {
  if (signal.aborted) return;
  const persisted = await refresh(signal);
  if (!persisted) return;
  if (signal.aborted) return;
  publish();
};
