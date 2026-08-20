import {
  PluginBrokerProtocolServer,
  type PluginBrokerRequestMessage,
  type PluginBrokerResponseMessage,
} from "./protocol.js";
import { PluginRuntimeError, type PluginErrorKind } from "./errors.js";
import { PluginRuntimeLimits } from "./limits.js";
import type { PluginManifest } from "./manifest.js";
import type { LoadedPlugin } from "./sandbox.js";

export const PluginSandboxProtocolVersion = 1 as const;

export interface PluginSandboxInspectRequest {
  readonly version: typeof PluginSandboxProtocolVersion;
  readonly type: "inspect";
  readonly id: string;
  readonly source: string;
  readonly options: {
    readonly language: "javascript" | "typescript";
    readonly allowsDynamicId: boolean;
  };
}

/** Non-secret execution metadata deliberately safe to cross into an untrusted QuickJS guest. */
export interface PluginSandboxExecutionContext {
  readonly nowMillis?: number;
  readonly timeZone?: string;
}

export interface PluginSandboxExecuteRequest {
  readonly version: typeof PluginSandboxProtocolVersion;
  readonly type: "execute";
  readonly id: string;
  readonly source: string;
  /** Manifest obtained during inspection and used to construct the host approval binding. */
  readonly manifest: PluginManifest;
  readonly settings: {
    readonly plain: Readonly<Record<string, string>>;
    readonly secure: Readonly<Record<string, string>>;
  };
  readonly context: PluginSandboxExecutionContext;
}

export interface PluginSandboxBrokerRequest {
  readonly version: typeof PluginSandboxProtocolVersion;
  readonly type: "broker-request";
  readonly executionId: string;
  readonly message: PluginBrokerRequestMessage;
}

export interface PluginSandboxBrokerResponse {
  readonly version: typeof PluginSandboxProtocolVersion;
  readonly type: "broker-response";
  readonly executionId: string;
  readonly message: PluginBrokerResponseMessage;
}

export interface PluginSandboxCapabilityRequest {
  readonly version: typeof PluginSandboxProtocolVersion;
  readonly type: "capability-request";
  readonly executionId: string;
  readonly id: string;
  readonly capability: "setting" | "cookie" | "log";
  readonly key: string;
  readonly secure?: boolean;
}

export interface PluginSandboxCapabilityResponse {
  readonly version: typeof PluginSandboxProtocolVersion;
  readonly type: "capability-response";
  readonly executionId: string;
  readonly id: string;
  readonly ok: boolean;
  readonly value?: string | null;
  readonly error?: { readonly kind: PluginErrorKind; readonly message: string };
}

/** Main-process callbacks; each callback must enforce the current manifest + approval. */
export interface PluginSandboxCapabilities {
  readonly getSetting: (
    key: string,
    secure: boolean,
  ) => Promise<string | undefined> | string | undefined;
  readonly getCookie: (domain: string) => Promise<string | undefined> | string | undefined;
  readonly log?: (message: string) => void | Promise<void>;
}

export interface PluginSandboxInspectSuccess {
  readonly version: typeof PluginSandboxProtocolVersion;
  readonly type: "inspect-result";
  readonly id: string;
  readonly ok: true;
  readonly plugin: LoadedPlugin;
}

export interface PluginSandboxInspectFailure {
  readonly version: typeof PluginSandboxProtocolVersion;
  readonly type: "inspect-result";
  readonly id: string;
  readonly ok: false;
  readonly error: { readonly kind: PluginErrorKind; readonly message: string };
}

export interface PluginSandboxExecuteSuccess {
  readonly version: typeof PluginSandboxProtocolVersion;
  readonly type: "execute-result";
  readonly id: string;
  readonly ok: true;
  /** Bounded JSON parsed in the utility process. It contains no host secrets. */
  readonly value: Record<string, unknown>;
}

export interface PluginSandboxExecuteFailure {
  readonly version: typeof PluginSandboxProtocolVersion;
  readonly type: "execute-result";
  readonly id: string;
  readonly ok: false;
  readonly error: { readonly kind: PluginErrorKind; readonly message: string };
}

export type PluginSandboxRequest =
  | PluginSandboxInspectRequest
  | PluginSandboxExecuteRequest
  | PluginSandboxBrokerResponse
  | PluginSandboxCapabilityResponse;
export type PluginSandboxResponse =
  | PluginSandboxInspectSuccess
  | PluginSandboxInspectFailure
  | PluginSandboxExecuteSuccess
  | PluginSandboxExecuteFailure
  | PluginSandboxBrokerRequest
  | PluginSandboxCapabilityRequest;

export interface PluginSandboxTransport {
  postMessage(message: PluginSandboxRequest): void;
  onMessage(listener: (message: unknown) => void): () => void;
  onExit(listener: () => void): () => void;
  kill(): void;
}

export type PluginSandboxTransportFactory = () => PluginSandboxTransport;

interface PendingOperation<T> {
  readonly resolve: (value: T) => void;
  readonly reject: (error: PluginRuntimeError) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  readonly broker?: PluginBrokerProtocolServer;
  readonly capabilities?: PluginSandboxCapabilities;
}

interface QueuedOperation {
  readonly id: string;
  readonly build: (id: string) => PluginSandboxInspectRequest | PluginSandboxExecuteRequest;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  (timer as unknown as { unref?: () => void }).unref?.();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isResponse(value: unknown): value is PluginSandboxResponse {
  if (
    !isRecord(value) ||
    value.version !== PluginSandboxProtocolVersion ||
    typeof value.type !== "string"
  )
    return false;
  return (
    (value.type === "broker-request" &&
      typeof value.executionId === "string" &&
      isRecord(value.message)) ||
    (value.type === "capability-request" &&
      typeof value.executionId === "string" &&
      typeof value.id === "string" &&
      typeof value.capability === "string" &&
      typeof value.key === "string") ||
    ((value.type === "inspect-result" || value.type === "execute-result") &&
      typeof value.id === "string" &&
      typeof value.ok === "boolean")
  );
}

/**
 * Owns one disposable sandbox process. A timeout or unexpected exit rejects every
 * pending operation, kills the process, and forces a clean process on the next call.
 * Only manifest-declared settings enter the disposable utility process. The
 * renderer and generic host APIs never receive them; the QuickJS guest gets
 * only values approved for that specific manifest execution.
 */
export class PluginSandboxClient {
  private nextId = 0;
  private readonly pending = new Map<string, PendingOperation<unknown>>();
  private readonly queue: QueuedOperation[] = [];
  private runningId: string | undefined;
  private readonly spawn: PluginSandboxTransportFactory;
  private transport: PluginSandboxTransport | undefined;
  private removeMessageListener: (() => void) | undefined;
  private removeExitListener: (() => void) | undefined;

  constructor(spawn: PluginSandboxTransportFactory) {
    this.spawn = spawn;
  }

  inspect(
    source: string,
    options: {
      readonly language?: "javascript" | "typescript";
      readonly allowsDynamicId?: boolean;
    } = {},
  ): Promise<LoadedPlugin> {
    return this.start<LoadedPlugin>("inspect", undefined, undefined, (id) => ({
      version: PluginSandboxProtocolVersion,
      type: "inspect",
      id,
      source,
      options: {
        language: options.language ?? "javascript",
        allowsDynamicId: options.allowsDynamicId ?? false,
      },
    }));
  }

  execute(
    plugin: Pick<LoadedPlugin, "transpiledSource" | "manifest">,
    broker: PluginBrokerProtocolServer,
    context: PluginSandboxExecutionContext = {},
    capabilities?: PluginSandboxCapabilities,
  ): Promise<Record<string, unknown>> {
    if (capabilities === undefined)
      return this.start<Record<string, unknown>>("execute", broker, undefined, (id) => ({
        version: PluginSandboxProtocolVersion,
        type: "execute",
        id,
        source: plugin.transpiledSource,
        manifest: plugin.manifest,
        settings: { plain: {}, secure: {} },
        context,
      }));
    return this.resolveSettings(plugin.manifest, capabilities).then((settings) =>
      this.start<Record<string, unknown>>("execute", broker, capabilities, (id) => ({
        version: PluginSandboxProtocolVersion,
        type: "execute",
        id,
        source: plugin.transpiledSource,
        manifest: plugin.manifest,
        settings,
        context,
      })),
    );
  }

  private async resolveSettings(
    manifest: PluginManifest,
    capabilities: PluginSandboxCapabilities | undefined,
  ): Promise<PluginSandboxExecuteRequest["settings"]> {
    const plain: Record<string, string> = {};
    const secure: Record<string, string> = {};
    if (capabilities === undefined) return { plain, secure };
    let totalBytes = 0;
    for (const setting of manifest.settings) {
      const value = await capabilities.getSetting(setting.key, setting.type === "secure");
      if (value === undefined) continue;
      totalBytes += new TextEncoder().encode(value).byteLength;
      if (totalBytes > PluginRuntimeLimits.maximumResponseBytes)
        throw new PluginRuntimeError(
          "response-too-large",
          "plugin settings exceed the 1 MiB execution limit",
        );
      (setting.type === "secure" ? secure : plain)[setting.key] = value;
    }
    return { plain, secure };
  }

  terminate(): void {
    this.failPending(new PluginRuntimeError("terminated", "plugin sandbox was terminated"));
    this.discardTransport();
  }

  private start<T>(
    operation: "inspect" | "execute",
    broker: PluginBrokerProtocolServer | undefined,
    capabilities: PluginSandboxCapabilities | undefined,
    build: (id: string) => PluginSandboxInspectRequest | PluginSandboxExecuteRequest,
  ): Promise<T> {
    const id = `plugin-${operation}-${++this.nextId}`;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer: undefined,
        ...(broker === undefined ? {} : { broker }),
        ...(capabilities === undefined ? {} : { capabilities }),
      });
      this.queue.push({ id, build });
      this.pump();
    });
  }

  /** QuickJS is deliberately serial: one 64 MiB runtime/execution per utility process. */
  private pump(): void {
    if (this.runningId !== undefined) return;
    const queued = this.queue.shift();
    if (queued === undefined) return;
    const pending = this.pending.get(queued.id);
    if (pending === undefined) {
      this.pump();
      return;
    }
    let transport: PluginSandboxTransport;
    try {
      transport = this.activeTransport();
    } catch {
      this.pending.delete(queued.id);
      pending.reject(new PluginRuntimeError("terminated", "plugin sandbox could not be created"));
      this.failPending(new PluginRuntimeError("terminated", "plugin sandbox could not be created"));
      return;
    }
    this.runningId = queued.id;
    pending.timer = setTimeout(() => {
      if (!this.pending.delete(queued.id)) return;
      this.runningId = undefined;
      pending.reject(new PluginRuntimeError("timed-out", "Provider plugin timed out"));
      // A compromised utility process cannot safely retain queued sibling work.
      this.failPending(
        new PluginRuntimeError("terminated", "plugin sandbox was recreated after a timeout"),
      );
      this.discardTransport();
    }, PluginRuntimeLimits.executionTimeoutMs);
    unrefTimer(pending.timer);
    try {
      transport.postMessage(queued.build(queued.id));
    } catch {
      this.pending.delete(queued.id);
      clearTimeout(pending.timer);
      this.runningId = undefined;
      pending.reject(new PluginRuntimeError("terminated", "plugin sandbox transport failed"));
      this.failPending(new PluginRuntimeError("terminated", "plugin sandbox transport failed"));
      this.discardTransport();
    }
  }

  private activeTransport(): PluginSandboxTransport {
    if (this.transport !== undefined) return this.transport;
    const transport = this.spawn();
    this.transport = transport;
    this.removeMessageListener = transport.onMessage((message) => this.receive(message));
    this.removeExitListener = transport.onExit(() => {
      if (this.transport !== transport) return;
      this.transport = undefined;
      this.removeListeners();
      this.failPending(
        new PluginRuntimeError("terminated", "plugin sandbox exited and must be recreated"),
      );
    });
    return transport;
  }

  private receive(message: unknown): void {
    if (!isResponse(message)) return;
    if (message.type === "broker-request") {
      if (message.executionId === this.runningId) void this.answerBrokerRequest(message);
      return;
    }
    if (message.type === "capability-request") {
      if (message.executionId === this.runningId) void this.answerCapabilityRequest(message);
      return;
    }
    // A utility guest may be compromised; it must never complete queued work or
    // select another operation's pending capability/approval surface by ID.
    if (message.id !== this.runningId) return;
    const pending = this.pending.get(message.id);
    if (pending === undefined) return;
    this.pending.delete(message.id);
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    if (this.runningId === message.id) this.runningId = undefined;
    if (message.ok) {
      if (message.type === "inspect-result" && "plugin" in message) pending.resolve(message.plugin);
      else if (message.type === "execute-result" && "value" in message)
        pending.resolve(message.value);
      else
        pending.reject(
          new PluginRuntimeError("script", "plugin sandbox returned an invalid success response"),
        );
    } else if (
      "error" in message &&
      isRecord(message.error) &&
      typeof message.error.kind === "string" &&
      typeof message.error.message === "string"
    ) {
      pending.reject(
        new PluginRuntimeError(message.error.kind as PluginErrorKind, message.error.message),
      );
    } else
      pending.reject(
        new PluginRuntimeError("script", "plugin sandbox returned an invalid failure response"),
      );
    this.pump();
  }

  private async answerBrokerRequest(message: PluginSandboxBrokerRequest): Promise<void> {
    const pending = this.pending.get(message.executionId);
    const transport = this.transport;
    if (pending?.broker === undefined || transport === undefined) return;
    const response = await pending.broker.receive(message.message);
    if (
      response === undefined ||
      this.transport !== transport ||
      message.executionId !== this.runningId
    )
      return;
    try {
      transport.postMessage({
        version: PluginSandboxProtocolVersion,
        type: "broker-response",
        executionId: message.executionId,
        message: response,
      });
    } catch {
      this.failPending(new PluginRuntimeError("terminated", "plugin sandbox transport failed"));
      this.discardTransport();
    }
  }

  private async answerCapabilityRequest(message: PluginSandboxCapabilityRequest): Promise<void> {
    const pending = this.pending.get(message.executionId);
    const capabilities = pending?.capabilities;
    const transport = this.transport;
    if (capabilities === undefined || transport === undefined) return;
    try {
      let value: string | undefined;
      if (message.capability === "setting")
        value = await capabilities.getSetting(message.key, message.secure === true);
      else if (message.capability === "cookie") value = await capabilities.getCookie(message.key);
      else {
        await capabilities.log?.(message.key);
      }
      if (this.transport !== transport || message.executionId !== this.runningId) return;
      transport.postMessage({
        version: PluginSandboxProtocolVersion,
        type: "capability-response",
        executionId: message.executionId,
        id: message.id,
        ok: true,
        value: value ?? null,
      });
    } catch (cause) {
      const error =
        cause instanceof PluginRuntimeError
          ? { kind: cause.kind, message: cause.message.replace(/[\r\n\t]+/g, " ").slice(0, 512) }
          : { kind: "secret-access" as const, message: "plugin capability request was denied" };
      try {
        if (this.transport !== transport || message.executionId !== this.runningId) return;
        transport.postMessage({
          version: PluginSandboxProtocolVersion,
          type: "capability-response",
          executionId: message.executionId,
          id: message.id,
          ok: false,
          error,
        });
      } catch {
        this.failPending(new PluginRuntimeError("terminated", "plugin sandbox transport failed"));
        this.discardTransport();
      }
    }
  }

  private failPending(error: PluginRuntimeError): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.queue.length = 0;
    this.runningId = undefined;
  }

  private discardTransport(): void {
    const transport = this.transport;
    this.transport = undefined;
    this.removeListeners();
    try {
      transport?.kill();
    } catch {
      /* best-effort kill of a compromised child */
    }
  }

  private removeListeners(): void {
    this.removeMessageListener?.();
    this.removeExitListener?.();
    this.removeMessageListener = undefined;
    this.removeExitListener = undefined;
  }
}

export function pluginSandboxFailure(
  id: string,
  cause: unknown,
  type: "inspect-result" | "execute-result" = "inspect-result",
): PluginSandboxInspectFailure | PluginSandboxExecuteFailure {
  const error =
    cause instanceof PluginRuntimeError
      ? cause
      : new PluginRuntimeError("script", "plugin sandbox request failed");
  return {
    version: PluginSandboxProtocolVersion,
    type,
    id,
    ok: false,
    error: { kind: error.kind, message: error.message },
  };
}
