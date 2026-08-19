import { approvalMatches, createApprovalBinding, type PluginApprovalBinding } from "./approval.js";
import { PluginRuntimeError } from "./errors.js";
import { PluginRuntimeLimits } from "./limits.js";
import type { PluginManifest } from "./manifest.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const forbiddenRequestHeaders = new Set([
  "authorization",
  "cookie",
  "host",
  "proxy-authorization",
  "set-cookie",
  "connection",
  "content-length",
  "transfer-encoding",
  "x-api-key",
]);
const redactedResponseHeaders = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
  "x-api-key",
]);
const method = /^[A-Z]+$/;

export interface PluginHttpRequest {
  readonly url: string;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly includeBrowserCookies?: boolean;
  readonly includeStatus?: boolean;
}

export interface PluginHttpResponse {
  readonly body: Uint8Array;
  readonly headers: Readonly<Record<string, string>>;
  readonly status?: number;
}

export interface PluginBrokerLimits {
  readonly maximumResponseBytes: number;
  readonly executionTimeoutMs: number;
  readonly requestTimeoutMs: number;
}

export interface PluginBrokerHostOptions {
  readonly manifest: PluginManifest;
  /** Plain endpoint settings only. Secure settings remain in the host secret store. */
  readonly endpointSettings: Readonly<Record<string, string>>;
  readonly approvedBinding: PluginApprovalBinding;
  readonly resolveSecret: (name: string) => string | undefined | Promise<string | undefined>;
  readonly fetch?: typeof globalThis.fetch;
  /** Returns one already-formatted Cookie header value for the supplied declared domains. */
  readonly readBrowserCookies?: (
    domains: readonly string[],
  ) => string | undefined | Promise<string | undefined>;
  readonly limits?: Partial<PluginBrokerLimits>;
  readonly now?: () => number;
}

type AbortReason = "cancelled" | "terminated" | "timed-out" | undefined;

interface ActiveRequest {
  readonly controller: AbortController;
  reason: AbortReason;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const maybeTimer = timer as unknown as { unref?: () => void };
  maybeTimer.unref?.();
}

function error(kind: PluginRuntimeError["kind"], message: string): PluginRuntimeError {
  return new PluginRuntimeError(kind, message);
}

function canonicalOrigin(url: URL): string {
  const port =
    (url.protocol === "https:" && url.port === "443") ||
    (url.protocol === "http:" && url.port === "80")
      ? ""
      : url.port;
  return `${url.protocol}//${url.hostname.toLowerCase()}${port === "" ? "" : `:${port}`}`;
}

function matchingCookieDomains(host: string, domains: readonly string[]): readonly string[] {
  const normalizedHost = host.toLowerCase().replace(/\.$/, "");
  return domains.filter(
    (domain) => normalizedHost === domain || normalizedHost.endsWith(`.${domain}`),
  );
}

function asSafeHeaders(
  headers: Headers,
  authHeader: string | undefined,
): Readonly<Record<string, string>> {
  const output: Record<string, string> = {};
  const authHeaderName = authHeader?.toLowerCase();
  for (const [name, value] of headers) {
    output[name] =
      redactedResponseHeaders.has(name.toLowerCase()) || name.toLowerCase() === authHeaderName
        ? "[REDACTED]"
        : value;
  }
  return output;
}

function validateRequestHeaders(
  headers: Readonly<Record<string, string>> | undefined,
  authHeader: string | undefined,
): Headers {
  const output = new Headers();
  if (headers === undefined) return output;
  const configuredAuthHeader = authHeader?.toLowerCase();
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (
      forbiddenRequestHeaders.has(normalized) ||
      (configuredAuthHeader !== undefined && normalized === configuredAuthHeader)
    ) {
      throw error("network-policy", `plugin requests may not set the '${name}' header`);
    }
    if (typeof value !== "string")
      throw error("network-policy", `plugin request header '${name}' must be a string`);
    try {
      output.set(name, value);
    } catch {
      throw error("network-policy", `plugin request header '${name}' is invalid`);
    }
  }
  return output;
}

async function readResponseBody(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maximumBytes)
    throw error("response-too-large", "plugin response exceeds the 1 MiB limit");

  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const next = await raceWithAbort(reader.read(), signal);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximumBytes) {
        void reader.cancel();
        throw error("response-too-large", "plugin response exceeds the 1 MiB limit");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function raceWithAbort<T>(value: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    void value.then(
      (result) => {
        signal.removeEventListener("abort", abort);
        resolve(result);
      },
      (cause: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(cause);
      },
    );
  });
}

/**
 * Host-owned HTTP/capability broker. It deliberately has no knowledge of Electron,
 * workers, or the QuickJS guest; only the host can provide fetch, secrets, or cookies.
 */
export class PluginBrokerHost {
  readonly limits: PluginBrokerLimits;

  private readonly options: PluginBrokerHostOptions;
  private readonly deadline: number;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly activeRequests = new Set<ActiveRequest>();
  private readonly globalTimer: ReturnType<typeof setTimeout>;
  private globallyTimedOut = false;
  private terminated = false;

  constructor(options: PluginBrokerHostOptions) {
    this.options = options;
    this.limits = {
      maximumResponseBytes:
        options.limits?.maximumResponseBytes ?? PluginRuntimeLimits.maximumResponseBytes,
      executionTimeoutMs:
        options.limits?.executionTimeoutMs ?? PluginRuntimeLimits.executionTimeoutMs,
      requestTimeoutMs: options.limits?.requestTimeoutMs ?? PluginRuntimeLimits.requestTimeoutMs,
    };
    this.now = options.now ?? Date.now;
    this.deadline = this.now() + this.limits.executionTimeoutMs;
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    this.globalTimer = setTimeout(() => this.timeoutExecution(), this.limits.executionTimeoutMs);
    unrefTimer(this.globalTimer);
  }

  get needsRecreation(): boolean {
    return this.terminated || this.globallyTimedOut;
  }

  recreate(): PluginBrokerHost {
    return new PluginBrokerHost(this.options);
  }

  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    clearTimeout(this.globalTimer);
    this.abortAll("terminated");
  }

  async request(request: PluginHttpRequest, signal?: AbortSignal): Promise<PluginHttpResponse> {
    this.assertUsable();
    this.assertApproval();
    const url = this.assertAllowedUrl(request.url);
    const requestMethod = request.method ?? "GET";
    if (!method.test(requestMethod))
      throw error("network-policy", "plugin request method is invalid");
    if (request.body !== undefined && typeof request.body !== "string")
      throw error("network-policy", "plugin request body must be a string");
    if (
      request.includeStatus === true &&
      !this.options.manifest.capabilities.includes("http-status")
    )
      throw error("network-policy", "plugin did not declare the http-status capability");
    if (
      request.includeBrowserCookies === true &&
      !this.options.manifest.capabilities.includes("browser-cookies")
    ) {
      throw error("network-policy", "plugin did not declare the browser-cookies capability");
    }

    const active: ActiveRequest = { controller: new AbortController(), reason: undefined };
    this.activeRequests.add(active);
    const timeout = setTimeout(() => {
      active.reason = "timed-out";
      active.controller.abort();
    }, this.limits.requestTimeoutMs);
    unrefTimer(timeout);
    const cancel = () => {
      active.reason = "cancelled";
      active.controller.abort();
    };
    signal?.addEventListener("abort", cancel, { once: true });

    try {
      const headers = validateRequestHeaders(request.headers, this.options.manifest.auth?.header);
      await this.injectHostCredentials(headers, url, request.includeBrowserCookies === true);
      this.throwIfInterrupted(active);
      const response = await this.fetchImplementation(url, {
        method: requestMethod,
        headers,
        ...(request.body === undefined ? {} : { body: request.body }),
        redirect: "error",
        signal: active.controller.signal,
      });
      this.throwIfInterrupted(active);
      if (response.redirected || (response.status >= 300 && response.status < 400))
        throw error("http", "redirect responses are not allowed");
      const body = await readResponseBody(
        response,
        this.limits.maximumResponseBytes,
        active.controller.signal,
      );
      this.throwIfInterrupted(active);
      return {
        body,
        headers: asSafeHeaders(response.headers, this.options.manifest.auth?.header),
        ...(request.includeStatus === true ? { status: response.status } : {}),
      };
    } catch (cause) {
      if (cause instanceof PluginRuntimeError) throw cause;
      this.throwIfInterrupted(active);
      throw error("http", "plugin HTTP request failed");
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", cancel);
      this.activeRequests.delete(active);
    }
  }

  private timeoutExecution(): void {
    if (this.globallyTimedOut || this.terminated) return;
    this.globallyTimedOut = true;
    this.abortAll("timed-out");
  }

  private abortAll(reason: Exclude<AbortReason, undefined>): void {
    for (const active of this.activeRequests) {
      active.reason = reason;
      active.controller.abort();
    }
  }

  private assertUsable(): void {
    if (this.terminated)
      throw error("terminated", "plugin host has been terminated and must be recreated");
    if (this.globallyTimedOut || this.now() >= this.deadline) {
      this.timeoutExecution();
      throw error("timed-out", "plugin execution exceeded the 20 second limit");
    }
  }

  private assertApproval(): void {
    let current: PluginApprovalBinding;
    try {
      current = createApprovalBinding(this.options.manifest, this.options.endpointSettings);
    } catch {
      throw error(
        "approval-drift",
        "plugin approval no longer matches its declared security surface",
      );
    }
    if (!approvalMatches(this.options.approvedBinding, current))
      throw error(
        "approval-drift",
        "plugin approval no longer matches its declared security surface",
      );
  }

  private assertAllowedUrl(raw: string): URL {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw error("network-policy", "plugin request URL is invalid");
    }
    if (
      url.username !== "" ||
      url.password !== "" ||
      !this.approvedOrigins().has(canonicalOrigin(url))
    )
      throw error("network-policy", "plugin request URL is outside its approved origins");
    return url;
  }

  private approvedOrigins(): ReadonlySet<string> {
    return new Set(this.options.approvedBinding.origins);
  }

  private async injectHostCredentials(
    headers: Headers,
    url: URL,
    includeBrowserCookies: boolean,
  ): Promise<void> {
    const auth = this.options.manifest.auth;
    if (auth !== undefined) {
      const secret = await this.options.resolveSecret(auth.secret);
      if (secret === undefined || secret.length === 0)
        throw error("secret-access", "host could not resolve the configured authentication secret");
      const value =
        auth.type === "bearer"
          ? `Bearer ${secret}`
          : auth.type === "authorization-scheme"
            ? `${auth.scheme} ${secret}`
            : secret;
      headers.set(auth.header, value);
    }
    if (!includeBrowserCookies) return;
    const domains = matchingCookieDomains(url.hostname, this.options.manifest.cookieDomains);
    if (domains.length === 0)
      throw error("network-policy", "no declared cookie domain matches the plugin request host");
    if (this.options.readBrowserCookies === undefined)
      throw error("secret-access", "host does not provide browser cookie access");
    const cookie = await this.options.readBrowserCookies(domains);
    if (cookie !== undefined && cookie !== "") headers.set("Cookie", cookie);
  }

  private throwIfInterrupted(active: ActiveRequest): void {
    const reason = active.reason;
    if (reason === "cancelled") throw error("cancelled", "plugin request was cancelled");
    if (reason === "terminated")
      throw error("terminated", "plugin host has been terminated and must be recreated");
    if (reason === "timed-out") throw error("timed-out", "plugin request timed out");
  }
}

export function decodePluginResponse(response: PluginHttpResponse): string {
  return textDecoder.decode(response.body);
}

export function pluginResponseByteLength(response: PluginHttpResponse): number {
  return response.body.byteLength;
}

export function pluginRequestByteLength(request: PluginHttpRequest): number {
  return textEncoder.encode(request.body ?? "").byteLength;
}
