import { parentPort, workerData } from "node:worker_threads";
import { Effect } from "effect";
import type {
  CostUsageRecord,
  DailyCostUsageReplacement,
  HistoryRecord,
  UsageRecordRetentionRequest,
} from "@codexbar/core";
import { InfrastructureError } from "@codexbar/core";
import {
  makeNodeSqlitePersistence,
  type NodeSqlitePersistence,
  type NodeSqlitePersistenceOptions,
} from "./node-persistence.ts";

/** This protocol is intentionally data-only so CLI and Electron can use the same worker entry. */
export const NodeSqliteWorkerProtocolVersion = 1 as const;

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

type SerializableInfrastructureError = {
  readonly operation: string;
  readonly message: string;
};

type WorkerResponse =
  | { readonly version: 1; readonly type: "ready"; readonly ok: true }
  | {
      readonly version: 1;
      readonly type: "ready";
      readonly ok: false;
      readonly error: SerializableInfrastructureError;
    }
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
      readonly error: SerializableInfrastructureError;
    };

interface WorkerBootstrap {
  readonly options: NodeSqlitePersistenceOptions;
}

const port = parentPort;
if (port === null) throw new Error("SQLite persistence worker requires a parent port");

const bootstrap = workerData as WorkerBootstrap;
let persistence: NodeSqlitePersistence | undefined;
let closing = false;
const cancelled = new Set<string>();

const errorForWire = (
  error: unknown,
  fallbackOperation: string,
): SerializableInfrastructureError => {
  if (error instanceof InfrastructureError) {
    return { operation: error.operation, message: error.message };
  }
  return { operation: fallbackOperation, message: "SQLite worker operation failed" };
};

const send = (message: WorkerResponse): void => port.postMessage(message);

const isRequest = (value: unknown): value is WorkerRequest => {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  if (message.version !== NodeSqliteWorkerProtocolVersion || typeof message.id !== "string")
    return false;
  return (
    message.type === "append-history" ||
    message.type === "latest-history" ||
    message.type === "list-history" ||
    message.type === "remove-provider-history" ||
    message.type === "append-cost" ||
    message.type === "replace-daily-cost" ||
    message.type === "daily-cost-source-state" ||
    message.type === "list-cost" ||
    message.type === "prune-usage-records" ||
    message.type === "close" ||
    message.type === "cancel"
  );
};

const runRequest = async (request: WorkerRequest): Promise<unknown> => {
  if (request.type === "cancel") {
    cancelled.add(request.id);
    return undefined;
  }
  if (persistence === undefined)
    throw new InfrastructureError("SQLite worker", "SQLite worker is not ready");
  if (request.type !== "close" && closing) {
    throw new InfrastructureError("SQLite worker", "SQLite worker is closing or already closed");
  }

  // `node:sqlite` is synchronous. Requests that have not started can be
  // discarded; a started request is cancelled by the host terminating this
  // worker, which lets SQLite recover the current transaction atomically.
  if (cancelled.delete(request.id)) {
    throw new InfrastructureError("SQLite worker", "SQLite worker request was cancelled");
  }

  switch (request.type) {
    case "append-history":
      return Effect.runPromise(persistence.history.append(request.record));
    case "latest-history":
      return Effect.runPromise(
        persistence.history.latest(request.providerId as HistoryRecord["providerId"]),
      );
    case "list-history":
      return Effect.runPromise(
        persistence.history.list(
          request.providerId as HistoryRecord["providerId"],
          request.since,
          request.limit,
        ),
      );
    case "remove-provider-history":
      return Effect.runPromise(
        persistence.history.removeProvider(request.providerId as HistoryRecord["providerId"]),
      );
    case "append-cost":
      return Effect.runPromise(persistence.costs.append(request.record));
    case "replace-daily-cost":
      return Effect.runPromise(persistence.costs.replaceDaily(request.replacement));
    case "daily-cost-source-state":
      return Effect.runPromise(
        persistence.costs.dailySourceState(
          request.providerId as CostUsageRecord["providerId"],
          request.sourceKey,
        ),
      );
    case "list-cost":
      return Effect.runPromise(
        persistence.costs.list(
          request.providerId as CostUsageRecord["providerId"],
          request.since,
          request.limit,
        ),
      );
    case "prune-usage-records":
      return Effect.runPromise(persistence.retention.prune(request.request));
    case "close":
      closing = true;
      return Effect.runPromise(persistence.close);
  }
};

const receive = (raw: unknown): void => {
  if (!isRequest(raw)) return;
  if (raw.type === "cancel") {
    cancelled.add(raw.id);
    return;
  }
  void runRequest(raw).then(
    (value) => {
      if (!cancelled.delete(raw.id)) {
        send({
          version: NodeSqliteWorkerProtocolVersion,
          type: "result",
          id: raw.id,
          ok: true,
          value,
        });
      }
      if (raw.type === "close") port.close();
    },
    (error) => {
      cancelled.delete(raw.id);
      send({
        version: NodeSqliteWorkerProtocolVersion,
        type: "result",
        id: raw.id,
        ok: false,
        error: errorForWire(error, `SQLite ${raw.type}`),
      });
    },
  );
};

void Effect.runPromise(makeNodeSqlitePersistence(bootstrap.options)).then(
  (opened) => {
    persistence = opened;
    send({ version: NodeSqliteWorkerProtocolVersion, type: "ready", ok: true });
    port.on("message", receive);
  },
  (error) =>
    send({
      version: NodeSqliteWorkerProtocolVersion,
      type: "ready",
      ok: false,
      error: errorForWire(error, "open SQLite persistence"),
    }),
);
