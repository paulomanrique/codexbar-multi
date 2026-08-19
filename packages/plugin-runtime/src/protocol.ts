import { PluginBrokerHost, type PluginHttpRequest, type PluginHttpResponse } from "./broker.js";
import { PluginRuntimeError, type PluginErrorKind } from "./errors.js";

export const PluginBrokerProtocolVersion = 1 as const;

export interface PluginBrokerHttpMessage {
  readonly version: typeof PluginBrokerProtocolVersion;
  readonly type: "http";
  readonly id: string;
  readonly request: PluginHttpRequest;
}

export interface PluginBrokerCancelMessage {
  readonly version: typeof PluginBrokerProtocolVersion;
  readonly type: "cancel";
  readonly id: string;
}

export type PluginBrokerRequestMessage = PluginBrokerHttpMessage | PluginBrokerCancelMessage;

export interface PluginBrokerSuccessMessage {
  readonly version: typeof PluginBrokerProtocolVersion;
  readonly type: "response";
  readonly id: string;
  readonly ok: true;
  readonly response: PluginHttpResponse;
}

export interface PluginBrokerFailureMessage {
  readonly version: typeof PluginBrokerProtocolVersion;
  readonly type: "response";
  readonly id: string;
  readonly ok: false;
  readonly error: { readonly kind: PluginErrorKind; readonly message: string };
}

export type PluginBrokerResponseMessage = PluginBrokerSuccessMessage | PluginBrokerFailureMessage;

export interface PluginBrokerMessageSink {
  postMessage(message: PluginBrokerRequestMessage): void;
}

function isRequestMessage(value: unknown): value is PluginBrokerRequestMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  return (
    message.version === PluginBrokerProtocolVersion &&
    typeof message.id === "string" &&
    (message.type === "cancel" || (message.type === "http" && typeof message.request === "object"))
  );
}

function failure(id: string, cause: unknown): PluginBrokerFailureMessage {
  if (cause instanceof PluginRuntimeError) {
    return {
      version: PluginBrokerProtocolVersion,
      type: "response",
      id,
      ok: false,
      error: { kind: cause.kind, message: cause.message },
    };
  }
  return {
    version: PluginBrokerProtocolVersion,
    type: "response",
    id,
    ok: false,
    error: { kind: "http", message: "plugin broker request failed" },
  };
}

/** Transport-neutral server: call receive from worker_threads, utilityProcess IPC, or a test harness. */
export class PluginBrokerProtocolServer {
  private readonly active = new Map<string, AbortController>();
  private readonly host: PluginBrokerHost;

  constructor(host: PluginBrokerHost) {
    this.host = host;
  }

  async receive(message: unknown): Promise<PluginBrokerResponseMessage | undefined> {
    if (!isRequestMessage(message)) return undefined;
    if (message.type === "cancel") {
      this.active.get(message.id)?.abort();
      return undefined;
    }
    if (this.active.has(message.id))
      return failure(
        message.id,
        new PluginRuntimeError("network-policy", "duplicate broker request id"),
      );
    const controller = new AbortController();
    this.active.set(message.id, controller);
    try {
      const response = await this.host.request(message.request, controller.signal);
      return {
        version: PluginBrokerProtocolVersion,
        type: "response",
        id: message.id,
        ok: true,
        response,
      };
    } catch (cause) {
      return failure(message.id, cause);
    } finally {
      this.active.delete(message.id);
    }
  }
}

interface PendingRequest {
  readonly resolve: (response: PluginHttpResponse) => void;
  readonly reject: (reason: PluginRuntimeError) => void;
  readonly signal: AbortSignal | undefined;
  readonly abort: () => void;
}

/** Guest-side protocol client. It has no Node, filesystem, secret, or direct network capability. */
export class PluginBrokerProtocolClient {
  private nextId = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly sink: PluginBrokerMessageSink;

  constructor(sink: PluginBrokerMessageSink) {
    this.sink = sink;
  }

  request(request: PluginHttpRequest, signal?: AbortSignal): Promise<PluginHttpResponse> {
    const id = `plugin-request-${++this.nextId}`;
    return new Promise<PluginHttpResponse>((resolve, reject) => {
      const abort = () => {
        if (!this.pending.delete(id)) return;
        this.sink.postMessage({ version: PluginBrokerProtocolVersion, type: "cancel", id });
        reject(new PluginRuntimeError("cancelled", "plugin request was cancelled"));
      };
      if (signal?.aborted) {
        reject(new PluginRuntimeError("cancelled", "plugin request was cancelled"));
        return;
      }
      this.pending.set(id, { resolve, reject, signal, abort });
      signal?.addEventListener("abort", abort, { once: true });
      this.sink.postMessage({ version: PluginBrokerProtocolVersion, type: "http", id, request });
    });
  }

  receive(message: unknown): boolean {
    if (typeof message !== "object" || message === null) return false;
    const response = message as Partial<PluginBrokerResponseMessage>;
    if (
      response.version !== PluginBrokerProtocolVersion ||
      response.type !== "response" ||
      typeof response.id !== "string" ||
      typeof response.ok !== "boolean"
    ) {
      return false;
    }
    const pending = this.pending.get(response.id);
    if (pending === undefined) return false;
    this.pending.delete(response.id);
    pending.signal?.removeEventListener("abort", pending.abort);
    if (response.ok === true && response.response !== undefined) pending.resolve(response.response);
    else if (response.ok === false && response.error !== undefined)
      pending.reject(new PluginRuntimeError(response.error.kind, response.error.message));
    else pending.reject(new PluginRuntimeError("http", "invalid plugin broker response"));
    return true;
  }

  terminate(): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.signal?.removeEventListener("abort", pending.abort);
      this.sink.postMessage({ version: PluginBrokerProtocolVersion, type: "cancel", id });
      pending.reject(
        new PluginRuntimeError(
          "terminated",
          "plugin host has been terminated and must be recreated",
        ),
      );
    }
  }
}
