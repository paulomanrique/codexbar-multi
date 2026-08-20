import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  serializeUsageSnapshot,
  type DashboardSnapshotDTO,
  type ProviderIdentity,
} from "@codexbar/contracts";
import type { UsageSnapshot } from "@codexbar/contracts";
import { runCost } from "./cost.ts";
import type { CLICommandResult, CLIIO, CLIProviderRuntime } from "./runner.ts";

const maximumRequestBodyBytes = 4_096;
const maximumResponseBodyBytes = 1_048_576;
const maximumConcurrentRequests = 16;
const maximumRequestTimeoutSeconds = 86_400;
const defaultRequestTimeoutSeconds = 30;
const defaultRefreshIntervalSeconds = 60;

type IdentityMode = "full" | "redacted";

export interface ServeOptions {
  readonly host: string;
  readonly port: number;
  readonly refreshIntervalSeconds: number;
  readonly requestTimeoutSeconds: number;
  readonly dashboardToken?: string;
  readonly allowPlainHttp: boolean;
  readonly identity: IdentityMode;
}

export interface ServeRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly host?: string;
  readonly authorization?: string;
  readonly hasDuplicateAuthorization: boolean;
  readonly hasDuplicateHost: boolean;
  readonly bodyBytes: number;
  readonly signal: AbortSignal;
}

export interface ServeResponse {
  readonly status: number;
  readonly contentType?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface ServeRuntime extends Pick<
  CLIProviderRuntime,
  "providers" | "fetch" | "costs" | "now"
> {
  readonly version?: string;
}

export interface StartedServeServer {
  readonly server: Server;
  readonly host: string;
  readonly port: number;
  readonly close: () => Promise<void>;
}

type ParseResult =
  | { readonly ok: true; readonly value: ServeOptions }
  | { readonly ok: false; readonly message: string };

const errorResponse = (status: number, error: string, noStore = true): ServeResponse => ({
  status,
  contentType: "application/json; charset=utf-8",
  ...(noStore ? { headers: { "Cache-Control": "no-store" } } : {}),
  body: JSON.stringify({ error }),
});

const jsonResponse = (
  value: unknown,
  headers: Readonly<Record<string, string>> = {},
): ServeResponse => {
  const body = JSON.stringify(value);
  return body.length > maximumResponseBodyBytes
    ? errorResponse(500, "response exceeds size limit")
    : {
        status: 200,
        contentType: "application/json; charset=utf-8",
        ...(Object.keys(headers).length === 0 ? {} : { headers }),
        body,
      };
};

const noStore = (response: ServeResponse): ServeResponse => ({
  ...response,
  headers: { ...response.headers, "Cache-Control": "no-store" },
});

const isIPv4 = (value: string): boolean => {
  const parts = value.split(".");
  return (
    parts.length === 4 &&
    parts.every((part) => /^(?:0|[1-9][0-9]{0,2})$/u.test(part) && Number(part) <= 255)
  );
};

export const normalizeServeHost = (value: string): string | undefined => {
  const host = value.trim();
  if (host.toLowerCase() === "localhost") return "127.0.0.1";
  return isIPv4(host) ? host : undefined;
};

export const isLoopbackServeHost = (host: string): boolean =>
  host === "127.0.0.1" || host.startsWith("127.");

const numeric = (
  value: string,
  name: string,
  minimum: number,
  maximum: number,
): number | string => {
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(value)) return `${name} must be a finite number`;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : `${name} must be between ${minimum} and ${maximum}`;
};

/** Strict, side-effect-free parser so the CLI and tests share the startup policy. */
export const parseServeArguments = (
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ParseResult => {
  let host = "127.0.0.1";
  let port = 8080;
  let refreshIntervalSeconds = defaultRefreshIntervalSeconds;
  let requestTimeoutSeconds = defaultRequestTimeoutSeconds;
  let dashboardTokenFromFlag: string | undefined;
  let allowPlainHttp = false;
  let identity: IdentityMode = "full";
  const seen = new Set<string>();
  const valueOptions = new Map<string, (value: string) => string | undefined>([
    [
      "--host",
      (value) => {
        const normalized = normalizeServeHost(value);
        if (normalized === undefined) return "--host must be 'localhost' or an IPv4 address";
        host = normalized;
        return undefined;
      },
    ],
    [
      "--port",
      (value) => {
        const parsed = numeric(value, "--port", 1, 65_535);
        if (typeof parsed === "string" || !Number.isInteger(parsed))
          return "--port must be between 1 and 65535";
        port = parsed;
        return undefined;
      },
    ],
    [
      "--refresh-interval",
      (value) => {
        const parsed = numeric(value, "--refresh-interval", 0, Number.MAX_VALUE);
        if (typeof parsed === "string") return "--refresh-interval must be zero or greater";
        refreshIntervalSeconds = parsed;
        return undefined;
      },
    ],
    [
      "--request-timeout",
      (value) => {
        const parsed = numeric(value, "--request-timeout", 0, Number.MAX_VALUE);
        if (typeof parsed === "string") return "--request-timeout must be zero or greater";
        requestTimeoutSeconds = parsed;
        return undefined;
      },
    ],
    [
      "--dashboard-token",
      (value) => {
        dashboardTokenFromFlag = value.trim();
        return dashboardTokenFromFlag === ""
          ? "--dashboard-token must not be empty or whitespace"
          : undefined;
      },
    ],
    [
      "--identity",
      (value) => {
        if (value !== "full" && value !== "redacted") return "--identity must be redacted or full";
        identity = value;
        return undefined;
      },
    ],
    // Retained for upstream CLI compatibility. Logging remains deliberately redacted.
    [
      "--log-level",
      (value) =>
        /^(trace|verbose|debug|info|warning|error|critical)$/u.test(value)
          ? undefined
          : "--log-level is invalid",
    ],
  ]);
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === undefined) continue;
    if (argument === "--allow-plain-http") {
      if (seen.has(argument))
        return { ok: false, message: "Option --allow-plain-http may only be specified once" };
      seen.add(argument);
      allowPlainHttp = true;
      continue;
    }
    if (argument === "--verbose" || argument === "-v" || argument === "--json-output") continue;
    const option = [...valueOptions.keys()].find(
      (name) => argument === name || argument.startsWith(`${name}=`),
    );
    if (option === undefined)
      return {
        ok: false,
        message: argument.startsWith("-")
          ? `Unknown option ${argument}`
          : "serve does not accept positional arguments",
      };
    if (seen.has(option))
      return { ok: false, message: `Option ${option} may only be specified once` };
    seen.add(option);
    const value = argument === option ? arguments_[index + 1] : argument.slice(option.length + 1);
    if (value === undefined || value === "" || value.startsWith("-"))
      return { ok: false, message: `Missing value for ${option}` };
    if (argument === option) index += 1;
    const problem = valueOptions.get(option)?.(value);
    if (problem !== undefined) return { ok: false, message: problem };
  }
  const envToken = environment.CODEXBAR_DASHBOARD_TOKEN;
  const dashboardToken = envToken === undefined ? dashboardTokenFromFlag : envToken.trim();
  if (envToken !== undefined && dashboardToken === "")
    return { ok: false, message: "CODEXBAR_DASHBOARD_TOKEN must not be empty or whitespace" };
  if (!isLoopbackServeHost(host) && dashboardToken === undefined)
    return {
      ok: false,
      message: `--dashboard-token (or CODEXBAR_DASHBOARD_TOKEN) is required for non-loopback --host '${host}'`,
    };
  if (!isLoopbackServeHost(host) && !allowPlainHttp)
    return {
      ok: false,
      message: `Refusing to serve the dashboard token over cleartext HTTP on non-loopback --host '${host}'. Pass --allow-plain-http to accept this.`,
    };
  return {
    ok: true,
    value: {
      host,
      port,
      refreshIntervalSeconds,
      requestTimeoutSeconds,
      ...(dashboardToken === undefined ? {} : { dashboardToken }),
      allowPlainHttp,
      identity,
    },
  };
};

const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();
const bearerToken = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const match = /^\s*Bearer\s+(.+?)\s*$/iu.exec(value);
  return match?.[1] === "" ? undefined : match?.[1];
};

export const authorizeServeBearer = (
  authorization: string | undefined,
  expected: string | undefined,
): boolean => {
  if (expected === undefined) return false;
  const presented = bearerToken(authorization);
  if (presented === undefined) return false;
  return timingSafeEqual(digest(presented), digest(expected));
};

const allowedHostHeader = (host: string | undefined, bindHost: string): boolean => {
  if (host === undefined || host.includes(",")) return false;
  const normalized = host.trim().replace(/:\d+$/u, "").toLowerCase();
  if (normalized === "localhost" || normalized === "localhost." || normalized.startsWith("127."))
    return true;
  return bindHost === "0.0.0.0" || normalized === bindHost;
};

const source = (value: string): "auto" | "api" | "cli" | "oauth" | "web" => {
  if (value === "api-token") return "api";
  if (value === "local-probe") return "cli";
  if (value === "web-dashboard") return "web";
  if (value === "oauth") return "oauth";
  return "auto";
};

const redactIdentity = (
  identity: ProviderIdentity | undefined,
  mode: IdentityMode,
): ProviderIdentity | undefined => {
  if (identity === undefined || mode === "full") return identity;
  return {
    ...(identity.providerId === undefined ? {} : { providerId: identity.providerId }),
    ...(identity.accountEmail === undefined ? {} : { accountEmail: "<redacted>" }),
    ...(identity.accountOrganization === undefined ? {} : { accountOrganization: "<redacted>" }),
    ...(identity.loginMethod === undefined ? {} : { loginMethod: identity.loginMethod }),
    ...(identity.accountId === undefined ? {} : { accountId: "<redacted>" }),
  };
};

const windows = (snapshot: UsageSnapshot): DashboardSnapshotDTO["providers"][number]["windows"] => {
  const entries = [
    ["primary", "Primary", snapshot.primary],
    ["secondary", "Secondary", snapshot.secondary],
    ["tertiary", "Tertiary", snapshot.tertiary],
  ] as const;
  return [
    ...entries.flatMap(([kind, label, value]) =>
      value === undefined
        ? []
        : [
            {
              kind,
              label,
              usedPercent: value.usedPercent,
              remainingPercent: Math.max(0, 100 - value.usedPercent),
              ...(value.resetsAt === undefined ? {} : { resetAt: value.resetsAt }),
            },
          ],
    ),
    ...(snapshot.extraRateWindows ?? []).map(({ id, title, window }) => ({
      kind: id,
      label: title,
      usedPercent: window.usedPercent,
      remainingPercent: Math.max(0, 100 - window.usedPercent),
      ...(window.resetsAt === undefined ? {} : { resetAt: window.resetsAt }),
    })),
  ];
};

const timeoutRace = async <T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number | undefined,
  parent: AbortSignal,
): Promise<T> => {
  if (parent.aborted) throw parent.reason ?? new Error("request cancelled");
  const controller = new AbortController();
  const abort = () => controller.abort(parent.reason ?? new Error("request cancelled"));
  parent.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    if (timeoutMs === undefined) return;
    timer = setTimeout(() => {
      const error = new Error("request timed out");
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    parent.removeEventListener("abort", abort);
    if (timer !== undefined) clearTimeout(timer);
  }
};

const selectedProviders = (
  runtime: ServeRuntime,
  provider: string | undefined,
): readonly (typeof runtime.providers)[number][] | string => {
  if (provider === undefined || provider === "" || provider === "all") return runtime.providers;
  const match = runtime.providers.find((candidate) => candidate.id === provider.toLowerCase());
  return match === undefined ? `Unknown provider '${provider}'` : [match];
};

const cacheable = (value: unknown): boolean =>
  Array.isArray(value)
    ? !value.some((row) => typeof row === "object" && row !== null && "error" in row)
    : true;

class ServeCache {
  readonly #entries = new Map<string, { readonly expiresAt: number; readonly value: unknown }>();
  get(key: string, now: number): unknown | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined || entry.expiresAt <= now) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry.value;
  }
  set(key: string, value: unknown, ttlSeconds: number, now: number): void {
    if (ttlSeconds > 0 && cacheable(value))
      this.#entries.set(key, { expiresAt: now + ttlSeconds * 1_000, value });
  }
}

const usagePayload = async (
  runtime: ServeRuntime,
  provider: string | undefined,
  signal: AbortSignal,
): Promise<unknown> => {
  const selected = selectedProviders(runtime, provider);
  if (typeof selected === "string") throw new Error(selected);
  const rows = await Promise.all(
    selected.map(async (descriptor) => {
      if (descriptor.status !== "partial")
        return {
          provider: descriptor.id,
          source: "auto",
          error: { code: 1, message: "Provider is mapped but not ported yet", kind: "provider" },
        };
      try {
        const outcome = await timeoutRace(
          (providerSignal) =>
            runtime.fetch(
              descriptor.id,
              { sourceMode: "auto", includeCredits: true },
              providerSignal,
            ),
          undefined,
          signal,
        );
        return {
          provider: descriptor.id,
          source: outcome.source,
          usage: serializeUsageSnapshot(outcome.snapshot),
        };
      } catch {
        return {
          provider: descriptor.id,
          source: "auto",
          error: {
            code: 1,
            message: "Provider request failed",
            kind: "provider",
          },
        };
      }
    }),
  );
  return rows;
};

const dashboardPayload = async (
  runtime: ServeRuntime,
  provider: string | undefined,
  identity: IdentityMode,
  signal: AbortSignal,
): Promise<DashboardSnapshotDTO> => {
  const selected = selectedProviders(runtime, provider);
  if (typeof selected === "string") throw new Error(selected);
  const now = runtime.now?.() ?? Date.now();
  const generatedAt = new Date(now).toISOString();
  const providers = await Promise.all(
    selected.map(async (descriptor) => {
      if (descriptor.status !== "partial")
        return {
          id: descriptor.id,
          name: descriptor.name,
          enabled: false,
          implementationStatus: descriptor.status,
          source: "auto" as const,
          windows: [],
          updatedAt: generatedAt,
          error: {
            code: 1,
            kind: "provider" as const,
            message: "Provider is mapped but not ported yet",
          },
        };
      try {
        const outcome = await timeoutRace(
          (providerSignal) =>
            runtime.fetch(
              descriptor.id,
              { sourceMode: "auto", includeCredits: true },
              providerSignal,
            ),
          undefined,
          signal,
        );
        return {
          id: descriptor.id,
          name: descriptor.name,
          enabled: true,
          implementationStatus: descriptor.status,
          source: source(outcome.source),
          ...(redactIdentity(outcome.snapshot.identity, identity) === undefined
            ? {}
            : { identity: redactIdentity(outcome.snapshot.identity, identity) }),
          windows: windows(outcome.snapshot),
          ...(outcome.snapshot.providerCost === undefined
            ? {}
            : { cost: outcome.snapshot.providerCost }),
          updatedAt: outcome.snapshot.updatedAt,
        };
      } catch {
        return {
          id: descriptor.id,
          name: descriptor.name,
          enabled: true,
          implementationStatus: descriptor.status,
          source: "auto" as const,
          windows: [],
          updatedAt: generatedAt,
          error: {
            code: 1,
            kind: "provider" as const,
            message: "Provider request failed",
          },
        };
      }
    }),
  );
  return { schemaVersion: 1, generatedAt, staleAfterSeconds: 0, providers };
};

const costPayload = async (
  runtime: ServeRuntime,
  provider: string | undefined,
): Promise<unknown> => {
  if (runtime.costs === undefined) throw new Error("Cost store is unavailable");
  const stdout: string[] = [];
  const stderr: string[] = [];
  await runCost(
    ["--format", "json", ...(provider === undefined ? [] : ["--provider", provider])],
    { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
    {
      costs: runtime.costs,
      providers: runtime.providers,
      ...(runtime.now === undefined ? {} : { now: runtime.now }),
    },
  );
  const text = stdout[0];
  if (text === undefined) throw new Error(stderr[0] ?? "cost request failed");
  return JSON.parse(text) as unknown;
};

const webUi =
  '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>CodexBar Multi</title><main><h1>CodexBar Multi</h1><p>Use the authenticated JSON endpoints to retrieve usage.</p></main></html>';

// URLComponents in the Swift oracle resolves duplicate keys by retaining the
// last value; keep that small compatibility detail without ever looking for
// credentials in the query string.
const lastQueryValue = (query: URLSearchParams, name: string): string | undefined =>
  query.getAll(name).at(-1)?.trim() || undefined;

/** Creates a pure-ish router handler. Network integration only adapts Node HTTP to this surface. */
export const makeServeHandler = (
  options: ServeOptions,
  runtime: ServeRuntime,
): ((request: ServeRequest) => Promise<ServeResponse>) => {
  const cache = new ServeCache();
  const dataRoutesRequireAuth = !isLoopbackServeHost(options.host);
  return async (request) => {
    if (request.bodyBytes > maximumRequestBodyBytes)
      return errorResponse(413, "request body too large");
    if (
      request.hasDuplicateAuthorization ||
      request.hasDuplicateHost ||
      !allowedHostHeader(request.host, options.host)
    )
      return errorResponse(400, "invalid request");
    if (request.method.toUpperCase() !== "GET")
      return noStore(errorResponse(405, "method not allowed"));
    if (request.path === "/")
      return {
        status: 200,
        contentType: "text/html; charset=utf-8",
        headers: {
          "Content-Security-Policy":
            "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
        },
        body: webUi,
      };
    if (request.path === "/health")
      return jsonResponse({
        status: "ok",
        ...(runtime.version === undefined ? {} : { version: runtime.version }),
      });
    const isDashboard = request.path === "/dashboard/v1/snapshot";
    const isData = request.path === "/usage" || request.path === "/cost" || isDashboard;
    if (!isData) return errorResponse(404, "not found", isDashboard);
    const authorized = authorizeServeBearer(request.authorization, options.dashboardToken);
    if ((isDashboard || dataRoutesRequireAuth) && !authorized)
      return {
        status: 401,
        contentType: "application/json; charset=utf-8",
        headers: { "WWW-Authenticate": "Bearer", "Cache-Control": "no-store" },
        body: JSON.stringify({ error: "unauthorized" }),
      };
    const provider = lastQueryValue(request.query, "provider");
    const cacheKey = `${request.path}:${provider ?? "all"}:${isDashboard ? options.identity : ""}`;
    const now = runtime.now?.() ?? Date.now();
    const cached = cache.get(cacheKey, now);
    if (cached !== undefined) return noStore(jsonResponse(cached));
    const outerMs =
      options.requestTimeoutSeconds === 0
        ? undefined
        : Math.min(options.requestTimeoutSeconds, maximumRequestTimeoutSeconds) * 1_000;
    const providerMs = outerMs === undefined ? undefined : outerMs * 0.8;
    try {
      const value = await timeoutRace(
        async (signal) => {
          if (request.path === "/usage") return usagePayload(runtime, provider, signal);
          if (request.path === "/cost") return costPayload(runtime, provider);
          const detail = lastQueryValue(request.query, "detail");
          if (detail !== undefined && detail !== "shell" && detail !== "full")
            throw new Error(`Unknown dashboard detail '${detail}'`);
          return dashboardPayload(runtime, provider, options.identity, signal);
        },
        providerMs,
        request.signal,
      );
      cache.set(cacheKey, value, options.refreshIntervalSeconds, now);
      return noStore(jsonResponse(value));
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : "request failed";
      const isInputError = rawMessage.startsWith("Unknown ");
      const isTimeout = rawMessage === "request timed out";
      const message = isInputError ? rawMessage : isTimeout ? rawMessage : "Request failed";
      return noStore(errorResponse(isTimeout ? 504 : isInputError ? 400 : 500, message));
    }
  };
};

const duplicates = (rawHeaders: readonly string[], name: string): number =>
  rawHeaders.reduce(
    (count, value, index) => (index % 2 === 0 && value.toLowerCase() === name ? count + 1 : count),
    0,
  );

const nodeRequest = (request: IncomingMessage, signal: AbortSignal): ServeRequest => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const length = request.headers["content-length"];
  const hasTransferEncoding = request.headers["transfer-encoding"] !== undefined;
  const bodyBytes = hasTransferEncoding
    ? maximumRequestBodyBytes + 1
    : typeof length === "string" && /^[0-9]+$/u.test(length)
      ? Number(length)
      : 0;
  return {
    method: request.method ?? "",
    path: url.pathname,
    query: url.searchParams,
    ...(typeof request.headers.host === "string" ? { host: request.headers.host } : {}),
    ...(typeof request.headers.authorization === "string"
      ? { authorization: request.headers.authorization }
      : {}),
    hasDuplicateAuthorization: duplicates(request.rawHeaders, "authorization") > 1,
    hasDuplicateHost: duplicates(request.rawHeaders, "host") > 1,
    bodyBytes,
    signal,
  };
};

const writeNodeResponse = (response: ServerResponse, value: ServeResponse): void => {
  const body = Buffer.from(value.body, "utf8");
  if (body.byteLength > maximumResponseBodyBytes) {
    const errorBody = '{"error":"response exceeds size limit"}';
    response.writeHead(500, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Length": String(Buffer.byteLength(errorBody)),
    });
    response.end(errorBody);
    return;
  }
  response.writeHead(value.status, {
    "Content-Type": value.contentType ?? "application/json; charset=utf-8",
    "Content-Length": String(body.byteLength),
    Connection: "close",
    "X-Content-Type-Options": "nosniff",
    ...value.headers,
  });
  response.end(body);
};

/** Starts the Node adapter; the route/auth/cache implementation remains testable above it. */
export const startServeServer = async (
  options: ServeOptions,
  runtime: ServeRuntime,
): Promise<StartedServeServer> => {
  const handler = makeServeHandler(options, runtime);
  let active = 0;
  const server = createServer(
    { maxHeaderSize: 16 * 1024, joinDuplicateHeaders: false },
    (request, response) => {
      if (active >= maximumConcurrentRequests) {
        request.resume();
        writeNodeResponse(response, errorResponse(503, "server busy"));
        return;
      }
      active += 1;
      const controller = new AbortController();
      const abort = () => controller.abort(new Error("client disconnected"));
      request.once("aborted", abort);
      response.once("close", abort);
      void handler(nodeRequest(request, controller.signal))
        .then((value) => !response.writableEnded && writeNodeResponse(response, value))
        .catch(
          () =>
            !response.writableEnded &&
            writeNodeResponse(response, errorResponse(500, "request failed")),
        )
        .finally(() => {
          active -= 1;
          request.removeListener("aborted", abort);
          response.removeListener("close", abort);
        });
    },
  );
  server.maxConnections = maximumConcurrentRequests;
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 1;
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("server did not expose a TCP address");
  }
  return {
    server,
    host: options.host,
    port: address.port,
    close: () =>
      server.listening
        ? new Promise((resolve, reject) =>
            server.close((error) => (error === undefined ? resolve() : reject(error))),
          )
        : Promise.resolve(),
  };
};

export const runServe = async (
  arguments_: readonly string[],
  io: CLIIO,
  runtime: ServeRuntime,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<CLICommandResult> => {
  const parsed = parseServeArguments(arguments_, environment);
  if (!parsed.ok) {
    io.stderr(`Error: ${parsed.message}`);
    return { exitCode: 64 };
  }
  let started: StartedServeServer | undefined;
  const stop = () => {
    void started?.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.once("SIGHUP", stop);
  try {
    started = await startServeServer(parsed.value, runtime);
    io.stderr(`CodexBar Multi server listening on http://${parsed.value.host}:${started.port}`);
    await new Promise<void>((resolve) => started?.server.once("close", resolve));
    return { exitCode: 0 };
  } catch (error) {
    io.stderr(`Error: ${error instanceof Error ? error.message : "failed to start server"}`);
    return { exitCode: 1 };
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGHUP", stop);
    if (started !== undefined && started.server.listening) await started.close();
  }
};
