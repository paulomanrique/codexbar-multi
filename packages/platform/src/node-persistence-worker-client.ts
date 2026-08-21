import { Worker } from "node:worker_threads";
import { Effect } from "effect";
import type {
  CostUsageRecord,
  CostUsageRepositoryService,
  DailyCostUsageReplacement,
  DailyCostUsageSourceState,
  LocalCostUsageScanCommit,
  HistoryRecord,
  HistoryRepositoryService,
  UsageRecordRetentionRequest,
  UsageRecordRetentionResult,
  UsageRecordRetentionService,
} from "@codexbar/core";
import { InfrastructureError } from "@codexbar/core";
import type { NodeSqlitePersistenceOptions } from "./node-persistence.ts";

const NodeSqliteWorkerProtocolVersion = 1 as const;

type WorkerRequest =
  | {
      readonly version: 1;
      readonly id: string;
      readonly type: "append-history";
      readonly record: HistoryRecord;
    }
  | {
      readonly version: 1;
      readonly id: string;
      readonly type: "latest-history";
      readonly providerId: string;
    }
  | {
      readonly version: 1;
      readonly id: string;
      readonly type: "list-history";
      readonly providerId: string;
      readonly since: number;
      readonly limit?: number;
    }
  | {
      readonly version: 1;
      readonly id: string;
      readonly type: "remove-provider-history";
      readonly providerId: string;
    }
  | {
      readonly version: 1;
      readonly id: string;
      readonly type: "append-cost";
      readonly record: CostUsageRecord;
    }
  | {
      readonly version: 1;
      readonly id: string;
      readonly type: "commit-local-cost-scan";
      readonly commit: LocalCostUsageScanCommit;
    }
  | {
      readonly version: 1;
      readonly id: string;
      readonly type: "local-cost-scan-checkpoint";
      readonly providerId: string;
      readonly sourceKey: string;
    }
  | {
      readonly version: 1;
      readonly id: string;
      readonly type: "replace-daily-cost";
      readonly replacement: DailyCostUsageReplacement;
    }
  | {
      readonly version: 1;
      readonly id: string;
      readonly type: "daily-cost-source-state";
      readonly providerId: string;
      readonly sourceKey: string;
    }
  | {
      readonly version: 1;
      readonly id: string;
      readonly type: "list-cost";
      readonly providerId: string;
      readonly since: number;
      readonly limit?: number;
    }
  | {
      readonly version: 1;
      readonly id: string;
      readonly type: "prune-usage-records";
      readonly request: UsageRecordRetentionRequest;
    }
  | { readonly version: 1; readonly id: string; readonly type: "close" }
  | { readonly version: 1; readonly id: string; readonly type: "cancel" };

interface WireError {
  readonly operation: string;
  readonly message: string;
}

type WorkerResponse =
  | { readonly version: 1; readonly type: "ready"; readonly ok: true }
  | { readonly version: 1; readonly type: "ready"; readonly ok: false; readonly error: WireError }
  | {
      readonly version: 1;
      readonly type: "result";
      readonly id: string;
      readonly ok: true;
      readonly value: unknown;
    }
  | {
      readonly version: 1;
      readonly type: "result";
      readonly id: string;
      readonly ok: false;
      readonly error: WireError;
    };

export interface NodeSqliteWorkerPersistence {
  readonly history: HistoryRepositoryService;
  readonly costs: CostUsageRepositoryService;
  readonly retention: UsageRecordRetentionService;
  /** Graceful shutdown waits for queued work, closes SQLite, then exits the worker. */
  readonly close: Effect.Effect<void, InfrastructureError>;
}

/**
 * `workerUrl` is supplied by production bundlers. Omitting it is supported for
 * Node 24 development/test runs, where native type stripping executes the
 * module-relative `.ts` entry directly.
 */
export interface NodeSqliteWorkerPersistenceOptions extends NodeSqlitePersistenceOptions {
  readonly workerUrl?: URL;
}

/**
 * Node-only SQLite persistence with all synchronous database work confined to
 * one worker thread. The caller owns this factory's lifecycle: `close` is
 * required before desktop/CLI shutdown. Worker cancellation terminates the
 * thread, so an interrupted operation cannot outlive its host process.
 */
export const makeNodeSqliteWorkerPersistence = (
  options: NodeSqliteWorkerPersistenceOptions,
): Effect.Effect<NodeSqliteWorkerPersistence, InfrastructureError> =>
  Effect.tryPromise({
    try: async (signal) => {
      const client = new NodeSqliteWorkerClient(options);
      try {
        await client.ready(signal);
        return client.persistence();
      } catch (error) {
        await client.terminate();
        throw error;
      }
    },
    catch: asInfrastructureError("open SQLite persistence worker"),
  });

class NodeSqliteWorkerClient {
  private readonly worker: Worker;
  private readonly pending = new Map<string, PendingRequest>();
  private nextId = 0;
  private lifecycle: "opening" | "open" | "closing" | "closed" | "terminated" = "opening";
  private workerExited = false;
  private readySettled = false;
  private readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: InfrastructureError) => void;
  private closePromise: Promise<void> | undefined;

  constructor(options: NodeSqliteWorkerPersistenceOptions) {
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    const { workerUrl, ...persistenceOptions } = options;
    this.worker = new Worker(workerUrl ?? developmentWorkerUrl(), {
      workerData: { options: persistenceOptions },
    });
    this.worker.on("message", (message: unknown) => this.receive(message));
    this.worker.on("error", (error) =>
      this.failAll(new InfrastructureError("SQLite worker", "SQLite worker crashed", error)),
    );
    this.worker.on("exit", (code) => {
      this.workerExited = true;
      if (this.lifecycle === "closed" || this.lifecycle === "terminated") return;
      this.failAll(
        new InfrastructureError(
          "SQLite worker",
          `SQLite worker exited unexpectedly (code ${code})`,
        ),
      );
    });
  }

  ready(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return this.cancelAndTerminate("SQLite worker startup was cancelled");
    const abort = () => {
      void this.cancelAndTerminate("SQLite worker startup was cancelled").catch(() => undefined);
    };
    signal.addEventListener("abort", abort, { once: true });
    return this.readyPromise.finally(() => signal.removeEventListener("abort", abort));
  }

  persistence(): NodeSqliteWorkerPersistence {
    const history: HistoryRepositoryService = {
      append: (record) => this.effect("append-history", { record }, "append history record"),
      latest: (providerId) =>
        this.effect("latest-history", { providerId }, "get latest history record") as Effect.Effect<
          HistoryRecord | undefined,
          InfrastructureError
        >,
      list: (providerId, since, limit) =>
        this.effect(
          "list-history",
          { providerId, since, ...(limit === undefined ? {} : { limit }) },
          "list history records",
        ) as Effect.Effect<ReadonlyArray<HistoryRecord>, InfrastructureError>,
      removeProvider: (providerId) =>
        this.effect(
          "remove-provider-history",
          { providerId },
          "remove provider history",
        ) as Effect.Effect<void, InfrastructureError>,
    };
    const costs: CostUsageRepositoryService = {
      append: (record) => this.effect("append-cost", { record }, "append cost usage record"),
      commitLocalScan: (commit) =>
        this.effect(
          "commit-local-cost-scan",
          { commit },
          "commit local cost usage scan",
        ) as Effect.Effect<void, InfrastructureError>,
      localScanCheckpoint: (providerId, sourceKey) =>
        this.effect(
          "local-cost-scan-checkpoint",
          { providerId, sourceKey },
          "get local cost usage scan checkpoint",
        ) as Effect.Effect<string | undefined, InfrastructureError>,
      replaceDaily: (replacement) =>
        this.effect(
          "replace-daily-cost",
          { replacement },
          "replace daily cost usage records",
        ) as Effect.Effect<void, InfrastructureError>,
      dailySourceState: (providerId, sourceKey) =>
        this.effect(
          "daily-cost-source-state",
          { providerId, sourceKey },
          "get daily cost usage source state",
        ) as Effect.Effect<DailyCostUsageSourceState | undefined, InfrastructureError>,
      list: (providerId, since, limit) =>
        this.effect(
          "list-cost",
          { providerId, since, ...(limit === undefined ? {} : { limit }) },
          "list cost usage records",
        ) as Effect.Effect<ReadonlyArray<CostUsageRecord>, InfrastructureError>,
    };
    const retention: UsageRecordRetentionService = {
      prune: (request) =>
        this.effect("prune-usage-records", { request }, "prune usage records") as Effect.Effect<
          UsageRecordRetentionResult,
          InfrastructureError
        >,
    };
    return { history, costs, retention, close: this.close() };
  }

  private effect(
    type: RequestType,
    payload: RequestPayload,
    operation: string,
  ): Effect.Effect<unknown, InfrastructureError> {
    return Effect.tryPromise({
      try: (signal) => this.request(type, payload, signal),
      catch: asInfrastructureError(operation),
    });
  }

  private close(): Effect.Effect<void, InfrastructureError> {
    return Effect.tryPromise({
      try: (signal) => {
        if (this.closePromise !== undefined) return this.closePromise;
        this.lifecycle = "closing";
        this.closePromise = this.request("close", {}, signal, true).then(async () => {
          this.lifecycle = "closed";
          await this.worker.terminate();
        });
        return this.closePromise;
      },
      catch: asInfrastructureError("close SQLite persistence worker"),
    });
  }

  private request(
    type: RequestType,
    payload: RequestPayload,
    signal: AbortSignal,
    allowClosing = false,
  ): Promise<unknown> {
    if (this.lifecycle === "terminated" || this.lifecycle === "closed") {
      return Promise.reject(
        new InfrastructureError("SQLite worker", "SQLite worker is not available"),
      );
    }
    if (!allowClosing && this.lifecycle !== "open") {
      return Promise.reject(
        new InfrastructureError("SQLite worker", "SQLite worker is closing or not ready"),
      );
    }
    if (signal.aborted) return this.cancelAndTerminate("SQLite worker request was cancelled");
    const id = `sqlite-${++this.nextId}`;
    const request = {
      version: NodeSqliteWorkerProtocolVersion,
      id,
      type,
      ...payload,
    } as WorkerRequest;
    return new Promise<unknown>((resolve, reject) => {
      const abort = () => {
        this.worker.postMessage({
          version: NodeSqliteWorkerProtocolVersion,
          id,
          type: "cancel",
        } satisfies WorkerRequest);
        void this.cancelAndTerminate("SQLite worker request was cancelled").catch(() => undefined);
      };
      this.pending.set(id, { resolve, reject, signal, abort });
      signal.addEventListener("abort", abort, { once: true });
      this.worker.postMessage(request);
    });
  }

  private receive(raw: unknown): void {
    if (!isResponse(raw)) return;
    if (raw.type === "ready") {
      if (raw.ok) {
        this.lifecycle = "open";
        this.readySettled = true;
        this.resolveReady();
      } else {
        this.lifecycle = "closing";
        this.readySettled = true;
        this.rejectReady(fromWireError(raw.error));
      }
      return;
    }
    const pending = this.pending.get(raw.id);
    if (pending === undefined) return;
    this.pending.delete(raw.id);
    pending.signal.removeEventListener("abort", pending.abort);
    if (raw.ok) pending.resolve(raw.value);
    else pending.reject(fromWireError(raw.error));
  }

  async terminate(): Promise<void> {
    if (this.workerExited) return;
    this.lifecycle = "terminated";
    this.failAll(new InfrastructureError("SQLite worker", "SQLite worker was terminated"));
    await this.worker.terminate();
  }

  private async cancelAndTerminate(message: string): Promise<never> {
    const error = new InfrastructureError("SQLite worker", message);
    this.failAll(error);
    this.lifecycle = "terminated";
    await this.worker.terminate();
    throw error;
  }

  private failAll(error: InfrastructureError): void {
    if (!this.readySettled) {
      this.readySettled = true;
      this.rejectReady(error);
    }
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.signal.removeEventListener("abort", pending.abort);
      pending.reject(error);
    }
  }
}

type RequestType =
  | "append-history"
  | "latest-history"
  | "list-history"
  | "remove-provider-history"
  | "append-cost"
  | "commit-local-cost-scan"
  | "local-cost-scan-checkpoint"
  | "replace-daily-cost"
  | "daily-cost-source-state"
  | "list-cost"
  | "prune-usage-records"
  | "close";
type RequestPayload =
  | { readonly record: HistoryRecord }
  | { readonly record: CostUsageRecord }
  | { readonly commit: LocalCostUsageScanCommit }
  | { readonly replacement: DailyCostUsageReplacement }
  | { readonly request: UsageRecordRetentionRequest }
  | { readonly providerId: string }
  | { readonly providerId: string; readonly sourceKey: string }
  | { readonly providerId: string; readonly since: number; readonly limit?: number }
  | Record<never, never>;

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: InfrastructureError) => void;
  readonly signal: AbortSignal;
  readonly abort: () => void;
}

const asInfrastructureError =
  (operation: string) =>
  (error: unknown): InfrastructureError =>
    error instanceof InfrastructureError
      ? error
      : new InfrastructureError(operation, "SQLite worker operation failed", error);

const fromWireError = (error: WireError): InfrastructureError =>
  new InfrastructureError(error.operation, error.message);

const developmentWorkerUrl = (): URL => {
  // Keep the entry name dynamic: Vite must not attempt to bundle the worker
  // together with native SQLite/keyring dependencies. Production composition
  // passes an emitted JavaScript asset through `workerUrl` instead.
  const entryName = "node-persistence-worker.ts";
  return new URL(`./${entryName}`, import.meta.url);
};

const isResponse = (value: unknown): value is WorkerResponse => {
  if (typeof value !== "object" || value === null) return false;
  const response = value as Record<string, unknown>;
  if (response.version !== NodeSqliteWorkerProtocolVersion || typeof response.type !== "string")
    return false;
  if (response.type === "ready") {
    return typeof response.ok === "boolean";
  }
  return (
    response.type === "result" &&
    typeof response.id === "string" &&
    typeof response.ok === "boolean"
  );
};
