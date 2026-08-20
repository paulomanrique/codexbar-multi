import {
  getQuickJS,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type QuickJSRuntime,
} from "quickjs-emscripten";

import { PluginRuntimeError } from "./errors.js";
import {
  PluginSandboxProtocolVersion,
  type PluginSandboxBrokerResponse,
  type PluginSandboxCapabilityRequest,
  type PluginSandboxCapabilityResponse,
  type PluginSandboxExecutionContext,
} from "./isolate-protocol.js";
import { PluginRuntimeLimits } from "./limits.js";
import { PluginBrokerProtocolVersion, type PluginBrokerRequestMessage } from "./protocol.js";
import { nextDailyResetMillis } from "./time.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const maximumCacheEntries = 128;
const maximumCacheBytes = 256 * 1024;

interface CachedValue {
  readonly serialized: string;
  readonly expiresAt: number;
  readonly bytes: number;
}

/** Utility-process-only cache: capped below guest memory and lost on process recreation. */
export class PluginExecutionCache {
  private readonly entries = new Map<string, CachedValue>();
  private totalBytes = 0;

  get(pluginId: string, key: string, now: number): string | undefined {
    const entry = this.entries.get(`${pluginId}\u0000${key}`);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= now) {
      this.delete(pluginId, key);
      return undefined;
    }
    return entry.serialized;
  }

  set(pluginId: string, key: string, value: unknown, ttlSeconds: number, now: number): void {
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) return;
    let serialized: string;
    try {
      serialized = JSON.stringify(value);
    } catch {
      return;
    }
    if (serialized === undefined) return;
    const bytes = encoder.encode(serialized).byteLength;
    if (bytes > maximumCacheBytes) return;
    const scopedKey = `${pluginId}\u0000${key}`;
    this.delete(pluginId, key);
    this.prune(now);
    while (
      this.entries.size >= maximumCacheEntries ||
      this.totalBytes + bytes > maximumCacheBytes
    ) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      const entry = this.entries.get(oldest);
      if (entry !== undefined) this.totalBytes -= entry.bytes;
      this.entries.delete(oldest);
    }
    this.entries.set(scopedKey, {
      serialized,
      bytes,
      expiresAt: now + Math.min(ttlSeconds, 86_400) * 1000,
    });
    this.totalBytes += bytes;
  }

  private delete(pluginId: string, key: string): void {
    const scopedKey = `${pluginId}\u0000${key}`;
    const entry = this.entries.get(scopedKey);
    if (entry !== undefined) {
      this.totalBytes -= entry.bytes;
      this.entries.delete(scopedKey);
    }
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries)
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
        this.totalBytes -= entry.bytes;
      }
  }
}

/**
 * This is a source copy of the public Swift prelude's capability surface, adapted
 * to the stronger Multi rule that a guest never receives secret or cookie values.
 * It has no imports, timers, fetch, Node, or Electron access.
 */
const prelude = String.raw`
function __codexbarApplyPluginPrelude(ctx, host) {
  "use strict";
  const request = (url, opts, method, json) => host.http(String(url), opts || {}, method, json).then((raw) => {
    const response = JSON.parse(raw);
    return json ? { status: response.status, headers: response.headers, json: JSON.parse(response.body) } : { status: response.status, headers: response.headers, bodyText: response.body };
  });
  ctx.http = Object.freeze({
    getJSON(url, opts) { return request(url, opts, "GET", true); },
    get(url, opts) { return request(url, opts, "GET", false); },
    postJSON(url, opts) {
      if (!opts || typeof opts !== "object" || !("body" in opts)) return Promise.reject(new TypeError("postJSON requires a body"));
      let bodyJSON; try { bodyJSON = JSON.stringify(opts.body); } catch { return Promise.reject(new TypeError("postJSON body is not JSON-serializable")); }
      if (bodyJSON === undefined) return Promise.reject(new TypeError("postJSON body is not JSON-serializable"));
      return request(url, Object.assign({}, opts, { bodyJSON }), "POST", true);
    },
  });
  ctx.settings = Object.freeze({ get(key) { return host.settingGet(String(key), false); }, getSecret(key) { return host.settingGet(String(key), true); } });
  const kinds = Object.freeze({ authenticationExpired: "authentication-expired", missingCredential: "missing-credential", permissionDenied: "permission-denied", rateLimited: "rate-limited", providerUnavailable: "provider-unavailable", parseFailure: "parse-failure", networkFailure: "network-failure", apiFailure: "api-failure" });
  const retryable = new Set([kinds.rateLimited, kinds.providerUnavailable, kinds.networkFailure, kinds.apiFailure]);
  const failure = (kind) => (message, options) => {
    let retryAfter = "";
    if (options !== undefined) { if (!retryable.has(kind) || !options || !Number.isFinite(Number(options.retryAfterSeconds)) || Number(options.retryAfterSeconds) < 0) throw new TypeError("invalid retry options"); retryAfter = String(Number(options.retryAfterSeconds)); }
    return new Error("__CODEXBAR_FAILURE_V2__:" + kind + ":" + retryAfter + ":" + String(message));
  };
  ctx.fail = Object.freeze(Object.fromEntries(Object.entries(kinds).map(([name, kind]) => [name, failure(kind)])));
  ctx.browser = Object.freeze({ cookieHeader(domain) { return host.cookieHeader(String(domain)).then((value) => value === "" ? null : value); } });
  ctx.html = Object.freeze({
    metaContent(html, name) { const target = String(name).toLowerCase(); const tags = String(html).match(/<meta\b[^>]*>/gi) || []; for (const tag of tags) { const n = tag.match(/\b(?:name|property)\s*=\s*["']([^"']*)["']/i); const c = tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i); if (n && n[1].toLowerCase() === target && c) return c[1]; } return null; },
    matchFirst(html, regexSource, flags) { const match = new RegExp(String(regexSource), flags === undefined ? "" : String(flags)).exec(String(html)); return match ? (match.length > 1 ? match[1] : match[0]) : null; },
  });
  ctx.log = (...args) => host.log(args.map((value) => { try { return typeof value === "string" ? value : JSON.stringify(value); } catch { return String(value); } }).join(" "));
  ctx.cache = Object.freeze({ get(key) { const value = host.cacheGet(String(key)); return value === null ? null : JSON.parse(value); }, set(key, value, ttlSeconds) { host.cacheSet(String(key), value, Number(ttlSeconds)); } });
  const number = (value, options) => { const n = Number(value); if (!Number.isFinite(n)) return String(n); const o = options || {}; const max = o.maximumFractionDigits === undefined ? 3 : Number(o.maximumFractionDigits); const min = o.minimumFractionDigits === undefined ? 0 : Number(o.minimumFractionDigits); if (!Number.isInteger(max) || !Number.isInteger(min) || min < 0 || max < min || max > 20) throw new RangeError("invalid fraction digit range"); let [whole, fraction = ""] = Math.abs(n).toFixed(max).split("."); while (fraction.length > min && fraction.endsWith("0")) fraction = fraction.slice(0, -1); return (n < 0 ? "-" : "") + whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (fraction ? "." + fraction : ""); };
  ctx.format = Object.freeze({ number, usd(value) { const n = Number(value); return (n < 0 ? "-$" : "$") + number(Math.abs(n), { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }, monthDay(value) { const d = new Date(value); if (!Number.isFinite(d.getTime())) throw new TypeError("invalid date"); return ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()] + " " + d.getDate(); } });
  const parseDate = (value) => { const d = new Date(value); if (!Number.isFinite(d.getTime())) throw new TypeError("invalid date"); return d; };
  const now = Number(ctx.__codexbarNowMillis); delete ctx.__codexbarNowMillis;
  ctx.date = Object.freeze({ now() { return parseDate(now); }, nowMillis() { return now; }, iso(value) { return parseDate(String(value)); }, unixSeconds(value) { return parseDate(Number(value) * 1000); }, unixMillis(value) { return parseDate(Number(value)); }, nextDailyReset(timeZone, hour) { return new Date(host.nextDailyReset(String(timeZone), Number(hour))); } });
  ctx.jwt = Object.freeze({ decode(token) { const parts = String(token).split("."); if (parts.length < 2) throw new TypeError("JWT must contain a payload segment"); const encoded = parts[1].replace(/-/g, "+").replace(/_/g, "/"); const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"; let bits = 0, count = 0, out = ""; for (const ch of encoded.replace(/=+$/, "")) { const value = chars.indexOf(ch); if (value < 0) throw new TypeError("invalid base64url data"); bits = (bits << 6) | value; count += 6; if (count >= 8) { count -= 8; out += String.fromCharCode((bits >> count) & 255); } } return JSON.parse(decodeURIComponent(Array.from(out, (c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0")).join(""))); } });
  ctx.pct = (used, limit) => host.pct(Number(used), Number(limit));
  ctx.amountFromPercent = (percent, limit) => Number(percent) / 100 * Number(limit);
  return ctx;
}
`;

type BrokerSink = (message: PluginBrokerRequestMessage | PluginSandboxCapabilityRequest) => void;
interface PendingBrokerRequest {
  readonly deferred: QuickJSDeferredPromise;
}

function messageFrom(value: unknown): string {
  if (typeof value === "object" && value !== null && "message" in value)
    return String(value.message);
  return String(value);
}

function pluginError(value: unknown): PluginRuntimeError {
  const message = messageFrom(value);
  if (/interrupted/i.test(message))
    return new PluginRuntimeError("timed-out", "Provider plugin timed out");
  return new PluginRuntimeError("script", message);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new PluginRuntimeError("invalid-snapshot", "fetchUsage must resolve to an object");
  return value as Record<string, unknown>;
}

function normalizedTimeZone(value: string | undefined): string {
  const candidate = value?.trim() || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(0);
    return candidate;
  } catch {
    return "UTC";
  }
}

/** One serial QuickJS execution. It has no direct host capabilities. */
export class QuickJsPluginExecution {
  private nextBrokerId = 0;
  private readonly brokerRequests = new Map<string, PendingBrokerRequest>();
  private readonly capabilityRequests = new Map<string, PendingBrokerRequest>();
  private wake: (() => void) | undefined;
  private stopped = false;
  private readonly executionId: string;
  private readonly sendBrokerRequest: BrokerSink;
  private readonly cache: PluginExecutionCache;
  private readonly pluginId: string;

  constructor(
    executionId: string,
    sendBrokerRequest: BrokerSink,
    options: { readonly pluginId?: string; readonly cache?: PluginExecutionCache } = {},
  ) {
    this.executionId = executionId;
    this.sendBrokerRequest = sendBrokerRequest;
    this.pluginId = options.pluginId ?? executionId;
    this.cache = options.cache ?? new PluginExecutionCache();
  }

  receive(message: PluginSandboxBrokerResponse | PluginSandboxCapabilityResponse): void {
    if (message.executionId !== this.executionId) return;
    if (message.type === "capability-response") {
      const pending = this.capabilityRequests.get(message.id);
      if (pending === undefined) return;
      this.capabilityRequests.delete(message.id);
      try {
        if (message.ok) {
          const value = pending.deferred.context.newString(message.value ?? "");
          pending.deferred.resolve(value);
          value.dispose();
        } else {
          const error = pending.deferred.context.newError({
            name: "PluginCapabilityError",
            message: message.error?.message ?? "plugin capability request was denied",
          });
          pending.deferred.reject(error);
          error.dispose();
        }
      } finally {
        pending.deferred.dispose();
        this.signal();
      }
      return;
    }
    const response = message.message;
    const pending = this.brokerRequests.get(response.id);
    if (pending === undefined) return;
    this.brokerRequests.delete(response.id);
    try {
      if (response.ok) {
        const body = decoder.decode(response.response.body);
        const payload = JSON.stringify({
          body,
          headers: response.response.headers,
          ...(response.response.status === undefined ? {} : { status: response.response.status }),
        });
        const value = pending.deferred.context.newString(payload);
        pending.deferred.resolve(value);
        value.dispose();
      } else {
        const error = pending.deferred.context.newError({
          name: "PluginBrokerError",
          message: response.error.message,
        });
        pending.deferred.reject(error);
        error.dispose();
      }
    } finally {
      pending.deferred.dispose();
      this.signal();
    }
  }

  terminate(): void {
    this.stopped = true;
    this.signal();
  }

  async execute(
    source: string,
    executionContext: PluginSandboxExecutionContext & {
      readonly settings?: {
        readonly plain: Readonly<Record<string, string>>;
        readonly secure: Readonly<Record<string, string>>;
      };
      readonly settingKinds?: Readonly<Record<string, "plain" | "secure">>;
    } = {},
  ): Promise<Record<string, unknown>> {
    if (this.stopped) throw new PluginRuntimeError("cancelled", "plugin execution was cancelled");
    const quickJs = await getQuickJS();
    if (this.stopped) throw new PluginRuntimeError("cancelled", "plugin execution was cancelled");
    let runtime: QuickJSRuntime | undefined;
    let context: QuickJSContext | undefined;
    let definition: QuickJSHandle | undefined;
    try {
      runtime = quickJs.newRuntime();
      runtime.setMemoryLimit(PluginRuntimeLimits.memoryBytes);
      runtime.setMaxStackSize(PluginRuntimeLimits.stackBytes);
      const deadline = Date.now() + PluginRuntimeLimits.executionTimeoutMs;
      runtime.setInterruptHandler(() => this.stopped || Date.now() >= deadline);
      context = runtime.newContext();
      const defineProvider = context.newFunction("defineProvider", (value) => {
        definition?.dispose();
        definition = value.dup();
        return context!.undefined;
      });
      context.setProp(context.global, "defineProvider", defineProvider);
      defineProvider.dispose();
      const load = context.evalCode(`"use strict";\n${source}`, "provider-plugin.js");
      if (load.error !== undefined) {
        const dumped = context.dump(load.error);
        load.error.dispose();
        throw pluginError(dumped);
      }
      load.value.dispose();
      if (definition === undefined)
        throw new PluginRuntimeError("invalid-manifest", "plugin did not call defineProvider(...)");
      const fetchUsage = context.getProp(definition, "fetchUsage");
      if (context.typeof(fetchUsage) !== "function") {
        fetchUsage.dispose();
        throw new PluginRuntimeError("invalid-manifest", "'fetchUsage' must be a function");
      }
      const ctx = context.newObject();
      const host = context.newObject();
      try {
        this.installHostFunctions(context, host, executionContext);
        const now = context.newNumber(executionContext.nowMillis ?? Date.now());
        context.setProp(ctx, "__codexbarNowMillis", now);
        now.dispose();
        const env = context.newObject();
        const timeZone = context.newString(normalizedTimeZone(executionContext.timeZone));
        context.setProp(env, "timeZone", timeZone);
        timeZone.dispose();
        const freeze = context.getProp(context.global, "Object");
        const freezeMethod = context.getProp(freeze, "freeze");
        const frozen = context.callFunction(freezeMethod, freeze, env);
        freezeMethod.dispose();
        freeze.dispose();
        if (frozen.error !== undefined) {
          const dumped = context.dump(frozen.error);
          frozen.error.dispose();
          throw pluginError(dumped);
        }
        frozen.value.dispose();
        context.setProp(ctx, "env", env);
        env.dispose();
        const apply = context.evalCode(prelude, "provider-plugin-prelude.js");
        if (apply.error !== undefined) {
          const dumped = context.dump(apply.error);
          apply.error.dispose();
          throw pluginError(dumped);
        }
        apply.value.dispose();
        const preludeFunction = context.getProp(context.global, "__codexbarApplyPluginPrelude");
        const prepared = context.callFunction(preludeFunction, context.undefined, ctx, host);
        preludeFunction.dispose();
        if (prepared.error !== undefined) {
          const dumped = context.dump(prepared.error);
          prepared.error.dispose();
          throw pluginError(dumped);
        }
        prepared.value.dispose();
        const result = context.callFunction(fetchUsage, context.undefined, ctx);
        if (result.error !== undefined) {
          const dumped = context.dump(result.error);
          result.error.dispose();
          throw pluginError(dumped);
        }
        const value = await this.awaitResult(runtime, context, result.value, deadline);
        try {
          // Serialize inside QuickJS: Date.toJSON and other guest JSON semantics must
          // be applied before crossing the boundary, exactly like the Swift mapper.
          const json = context.getProp(context.global, "JSON");
          const stringify = context.getProp(json, "stringify");
          const serializedResult = context.callFunction(stringify, json, value);
          stringify.dispose();
          json.dispose();
          if (serializedResult.error !== undefined) {
            const dumped = context.dump(serializedResult.error);
            serializedResult.error.dispose();
            throw pluginError(dumped);
          }
          const serialized = context.getString(serializedResult.value);
          serializedResult.value.dispose();
          if (encoder.encode(serialized).byteLength > PluginRuntimeLimits.maximumResponseBytes)
            throw new PluginRuntimeError(
              "response-too-large",
              "plugin output exceeds the 1 MiB limit",
            );
          return asRecord(JSON.parse(serialized));
        } finally {
          value.dispose();
        }
      } finally {
        fetchUsage.dispose();
        ctx.dispose();
        host.dispose();
      }
    } finally {
      definition?.dispose();
      for (const pending of this.brokerRequests.values()) pending.deferred.dispose();
      this.brokerRequests.clear();
      for (const pending of this.capabilityRequests.values()) pending.deferred.dispose();
      this.capabilityRequests.clear();
      context?.dispose();
      runtime?.dispose();
    }
  }

  private installHostFunctions(
    context: QuickJSContext,
    host: QuickJSHandle,
    executionContext: PluginSandboxExecutionContext & {
      readonly settings?: {
        readonly plain: Readonly<Record<string, string>>;
        readonly secure: Readonly<Record<string, string>>;
      };
      readonly settingKinds?: Readonly<Record<string, "plain" | "secure">>;
    },
  ): void {
    const http = context.newFunction("http", (...args) => {
      const rawUrl = context.getString(args[0]!);
      const options = args[1] === undefined ? {} : context.dump(args[1]);
      const requestMethod = args[2] === undefined ? "GET" : context.getString(args[2]);
      const wantsJson = args[3] === undefined ? false : context.getNumber(args[3]) !== 0;
      const optionsRecord =
        typeof options === "object" && options !== null && !Array.isArray(options)
          ? (options as Record<string, unknown>)
          : {};
      const requestId = `guest-${++this.nextBrokerId}`;
      const deferred = context.newPromise();
      this.brokerRequests.set(requestId, { deferred });
      const headers: Record<string, string> = {};
      if (
        typeof optionsRecord.headers === "object" &&
        optionsRecord.headers !== null &&
        !Array.isArray(optionsRecord.headers)
      ) {
        for (const [key, value] of Object.entries(optionsRecord.headers))
          if (typeof value === "string") headers[key] = value;
      }
      this.sendBrokerRequest({
        version: PluginBrokerProtocolVersion,
        type: "http",
        id: requestId,
        request: {
          url: rawUrl,
          method: requestMethod,
          ...(Object.keys(headers).length === 0 ? {} : { headers }),
          ...(typeof optionsRecord.bodyJSON === "string" ? { body: optionsRecord.bodyJSON } : {}),
          ...(optionsRecord.browserCookies === true ? { includeBrowserCookies: true } : {}),
          includeStatus: true,
        },
      });
      // wantsJson is deliberately consumed in the prelude, not passed to the host broker.
      void wantsJson;
      return deferred.handle;
    });
    const capability = (capabilityName: "cookie" | "log", key: string): QuickJSHandle => {
      const id = `capability-${++this.nextBrokerId}`;
      const deferred = context.newPromise();
      this.capabilityRequests.set(id, { deferred });
      this.sendBrokerRequest({
        version: PluginSandboxProtocolVersion,
        type: "capability-request",
        executionId: this.executionId,
        id,
        capability: capabilityName,
        key,
      });
      return deferred.handle;
    };
    const settingGet = context.newFunction("settingGet", (key, secure) => {
      const name = context.getString(key);
      const isSecure = context.getNumber(secure) !== 0;
      const kind = executionContext.settingKinds?.[name];
      if (kind === undefined || (kind === "secure") !== isSecure)
        throw new PluginRuntimeError(
          "secret-access",
          `plugin setting '${name}' is not declared with this security type`,
        );
      const value = (
        isSecure ? executionContext.settings?.secure : executionContext.settings?.plain
      )?.[name];
      return value === undefined ? context.null : context.newString(value);
    });
    const cookieHeader = context.newFunction("cookieHeader", (domain) =>
      capability("cookie", context.getString(domain)),
    );
    const cacheNow = executionContext.nowMillis ?? Date.now();
    const cacheGet = context.newFunction("cacheGet", (key) => {
      const value = this.cache.get(this.pluginId, context.getString(key), cacheNow);
      return value === undefined ? context.null : context.newString(value);
    });
    const cacheSet = context.newFunction("cacheSet", (key, value, ttl) => {
      this.cache.set(
        this.pluginId,
        context.getString(key),
        context.dump(value),
        context.getNumber(ttl),
        cacheNow,
      );
      return context.undefined;
    });
    const log = context.newFunction("log", (value) => {
      // Logs are fire-and-forget. They deliberately do not create a QuickJS Promise
      // or an entry in capabilityRequests, so a host that ignores log acknowledgements
      // cannot retain guest handles for the lifetime of an execution.
      this.sendBrokerRequest({
        version: PluginSandboxProtocolVersion,
        type: "capability-request",
        executionId: this.executionId,
        id: `log-${++this.nextBrokerId}`,
        capability: "log",
        key: context.getString(value),
      });
      return context.undefined;
    });
    const nextDailyReset = context.newFunction("nextDailyReset", (timeZone, hour) => {
      const resetHour = context.getNumber(hour);
      return context.newNumber(
        nextDailyResetMillis(
          executionContext.nowMillis ?? Date.now(),
          context.getString(timeZone),
          resetHour,
        ),
      );
    });
    const pct = context.newFunction("pct", (used, limit) => {
      const maximum = context.getNumber(limit);
      return context.newNumber(
        !Number.isFinite(maximum) || maximum <= 0
          ? 100
          : Math.max(0, Math.min(100, (context.getNumber(used) / maximum) * 100)),
      );
    });
    const amountFromPercent = context.newFunction("amountFromPercent", (percent, limit) =>
      context.newNumber((context.getNumber(percent) / 100) * context.getNumber(limit)),
    );
    for (const [name, value] of [
      ["http", http],
      ["settingGet", settingGet],
      ["cookieHeader", cookieHeader],
      ["cacheGet", cacheGet],
      ["cacheSet", cacheSet],
      ["log", log],
      ["nextDailyReset", nextDailyReset],
      ["pct", pct],
      ["amountFromPercent", amountFromPercent],
    ] as const) {
      context.setProp(host, name, value);
      value.dispose();
    }
  }

  private async awaitResult(
    runtime: QuickJSRuntime,
    context: QuickJSContext,
    result: QuickJSHandle,
    deadline: number,
  ): Promise<QuickJSHandle> {
    try {
      while (true) {
        if (this.stopped)
          throw new PluginRuntimeError("cancelled", "plugin execution was cancelled");
        if (Date.now() >= deadline)
          throw new PluginRuntimeError("timed-out", "Provider plugin timed out");
        const pendingJobs = runtime.executePendingJobs();
        if (pendingJobs.error !== undefined) {
          const dumped = context.dump(pendingJobs.error);
          pendingJobs.error.dispose();
          throw pluginError(dumped);
        }
        const state = context.getPromiseState(result);
        if (state.type === "fulfilled") {
          const value = state.value.dup();
          // For a non-Promise QuickJS returns the original `result` handle; its
          // lifetime is owned by this method's finally block below.
          if (state.notAPromise !== true) state.value.dispose();
          return value;
        }
        if (state.type === "rejected") {
          const dumped = context.dump(state.error);
          throw pluginError(dumped);
        }
        await this.waitForBrokerResponse(deadline);
      }
    } finally {
      result.dispose();
    }
  }

  private waitForBrokerResponse(deadline: number): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => {
          if (this.wake === wake) this.wake = undefined;
          resolve();
        },
        Math.max(0, deadline - Date.now()),
      );
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      this.wake = wake;
    });
  }

  private signal(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }
}
