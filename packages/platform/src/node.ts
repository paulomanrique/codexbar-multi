import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Entry } from "@napi-rs/keyring";
import { Effect } from "effect";
import type { AppPaths } from "@codexbar/core";
import {
  type ClockService,
  type CredentialStoreService,
  type HttpRequest,
  type HttpResponse,
  type HttpTransportService,
  InfrastructureError,
} from "@codexbar/core";
import type { ProviderId } from "@codexbar/contracts";
import type { FirstPartyBrowserSessions, FirstPartySettings } from "./first-party-runtime.ts";

export * from "./node-persistence.ts";
export * from "./node-persistence-worker-client.ts";
export * from "./first-party-runtime.ts";
export * from "./legacy-import.ts";

/**
 * Node-only file/path adapter. It is intentionally isolated from core so a
 * renderer or another host can provide the same capabilities without Node.
 */
export const makeNodePrivateFileStore = () => ({
  read: (path: string) =>
    Effect.tryPromise({
      try: async () => {
        try {
          return new Uint8Array(await readFile(path));
        } catch (error: unknown) {
          if (isMissing(error)) return undefined;
          throw error;
        }
      },
      catch: (error) =>
        new InfrastructureError("read private file", `Unable to read private file: ${path}`, error),
    }),
  writeAtomic: (path: string, content: Uint8Array) =>
    Effect.tryPromise({
      try: async () => {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
        try {
          const file = await open(temporary, "w", 0o600);
          try {
            await chmod(temporary, 0o600);
            await file.writeFile(content);
            await file.sync();
          } finally {
            await file.close();
          }
          await rename(temporary, path);
          await syncDirectory(dirname(path));
        } finally {
          await rm(temporary, { force: true });
        }
      },
      catch: (error) =>
        new InfrastructureError(
          "write private file",
          `Unable to atomically write private file: ${path}`,
          error,
        ),
    }),
  /**
   * Publishes a private file only when no entry already exists at `path`.
   *
   * `rename` intentionally is not used here: on the platforms we support it
   * replaces an existing destination and turns a prior `exists` check into a
   * TOCTOU bug. A same-directory hard link is an atomic create-or-exists
   * operation on the local filesystems supported by Node. The staged inode is
   * fsynced before publication, and only the directory entry survives after
   * the staging name is removed.
   */
  writeAtomicIfAbsent: (path: string, content: Uint8Array) =>
    Effect.tryPromise({
      try: async () => {
        const directory = dirname(path);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const temporary = join(directory, `.${randomUUID()}.tmp`);
        try {
          const file = await open(temporary, "wx", 0o600);
          try {
            await chmod(temporary, 0o600);
            await file.writeFile(content);
            await file.sync();
          } finally {
            await file.close();
          }

          try {
            await link(temporary, path);
          } catch (error) {
            if (isAlreadyExists(error)) return false;
            throw error;
          }
          await syncDirectory(directory);
          return true;
        } finally {
          await rm(temporary, { force: true });
        }
      },
      catch: (error) =>
        new InfrastructureError(
          "create private file",
          `Unable to atomically create private file: ${path}`,
          error,
        ),
    }),
  remove: (path: string) =>
    Effect.tryPromise({
      try: async () => {
        await rm(path, { force: true });
      },
      catch: (error) =>
        new InfrastructureError(
          "remove private file",
          `Unable to remove private file: ${path}`,
          error,
        ),
    }),
});

export const makeNodePlatformPaths = (
  root: string,
): { readonly resolve: Effect.Effect<AppPaths> } => ({
  resolve: Effect.succeed({
    appData: join(root, "data"),
    cache: join(root, "cache"),
    config: join(root, "config"),
    logs: join(root, "logs"),
    temporary: join(root, "tmp"),
  }),
});

const isMissing = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

const isAlreadyExists = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";

/** Directory fsync makes the rename durable on filesystems that support it. */
const syncDirectory = async (path: string): Promise<void> => {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } catch (error) {
    // Windows does not permit fsync on directory handles. The rename remains atomic there.
    if (!isUnsupportedDirectorySync(error)) throw error;
  } finally {
    await directory.close();
  }
};

const isUnsupportedDirectorySync = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error.code === "EINVAL" || error.code === "EPERM" || error.code === "ENOTSUP");

interface NativeKeyringEntry {
  readonly getPassword: () => string | null;
  readonly setPassword: (value: string) => void;
  readonly deletePassword: () => unknown;
}

/**
 * Shared desktop/CLI credential store backed by Keychain, Credential Manager,
 * Secret Service, or KWallet through the platform keyring. A missing or locked
 * Linux keyring is reported as an InfrastructureError; plaintext is never used.
 */
export const makeNativeCredentialStore = (
  service = "com.paulomanrique.codexbar-multi",
  makeEntry: (service: string, key: string) => NativeKeyringEntry = (name, key) =>
    new Entry(name, key),
) => ({
  read: (key: string) =>
    Effect.try({
      try: () => makeEntry(service, key).getPassword() ?? undefined,
      catch: (error) =>
        new InfrastructureError(
          "read credential",
          `Native credential storage is unavailable or locked for '${key}'. No plaintext fallback is permitted.`,
          error,
        ),
    }),
  write: (key: string, value: string) =>
    Effect.try({
      try: () => makeEntry(service, key).setPassword(value),
      catch: (error) =>
        new InfrastructureError(
          "write credential",
          `Native credential storage is unavailable or locked for '${key}'. No plaintext fallback is permitted.`,
          error,
        ),
    }),
  remove: (key: string) =>
    Effect.try({
      try: () => {
        makeEntry(service, key).deletePassword();
      },
      catch: (error) =>
        new InfrastructureError(
          "remove credential",
          `Native credential storage is unavailable or locked for '${key}'.`,
          error,
        ),
    }),
});

/** Node 24 fetch adapter. Redirects are rejected and response bodies are bounded before providers see them. */
export const makeFetchHttpTransport = (
  fetchImpl: typeof fetch = globalThis.fetch,
): HttpTransportService => ({
  execute: (request: HttpRequest) =>
    Effect.tryPromise({
      try: async (signal) => {
        const timeout = AbortSignal.timeout(request.timeoutMs ?? 15_000);
        const requestBody = request.body === undefined ? undefined : request.body.slice().buffer;
        const response = await fetchImpl(request.url, {
          method: request.method ?? "GET",
          redirect: "error",
          signal: AbortSignal.any([signal, timeout]),
          ...(request.headers === undefined ? {} : { headers: request.headers }),
          ...(requestBody === undefined ? {} : { body: requestBody }),
        });
        const responseBody = await boundedBody(response);
        return {
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          body: responseBody,
          url: response.url,
        } satisfies HttpResponse;
      },
      catch: (error) =>
        new InfrastructureError("HTTP request", "Provider HTTP request failed", error),
    }),
});

const boundedBody = async (response: Response): Promise<Uint8Array> => {
  const maximum = 1024 * 1024;
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maximum)
    throw new Error("Provider response exceeded 1 MiB");
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximum) {
        await reader.cancel("response limit exceeded");
        throw new Error("Provider response exceeded 1 MiB");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
};

export const makeSystemClock = (): ClockService => ({
  now: Effect.sync(() => Date.now()),
  sleep: (milliseconds) =>
    Effect.promise(() => new Promise((resolve) => setTimeout(resolve, milliseconds))),
});

/** Native provider variables remain supported, while the CodexBar namespace wins when explicitly set. */
export const makeEnvironmentProviderSettings = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): FirstPartySettings => ({
  read: (providerId, setting) =>
    Effect.sync(
      () =>
        environment[`CODEXBAR_MULTI_${providerId.toUpperCase().replaceAll("-", "_")}_${setting}`] ??
        environment[setting],
    ),
});

/** Only an allowlisted, encrypted cookie header is released to a declared provider domain. */
export const makeCredentialBrowserSessions = (
  credentials: CredentialStoreService,
  accountIdFor: (providerId: ProviderId) => string = () => "default",
): FirstPartyBrowserSessions => ({
  cookieHeader: (providerId, domain) =>
    credentials.read(`browser-session/${providerId}/${accountIdFor(providerId)}`).pipe(
      Effect.flatMap((stored) => {
        if (stored === undefined) {
          return Effect.fail(
            new InfrastructureError(
              "browser session",
              "No exported desktop browser credential is available",
            ),
          );
        }
        return Effect.try({
          try: () => {
            const parsed = JSON.parse(stored) as { readonly cookieHeaders?: unknown };
            if (
              typeof parsed.cookieHeaders !== "object" ||
              parsed.cookieHeaders === null ||
              Array.isArray(parsed.cookieHeaders)
            ) {
              throw new Error("Stored browser credential is invalid");
            }
            const normalizedDomain = domain.trim().toLowerCase();
            const cookieHeader = (parsed.cookieHeaders as Record<string, unknown>)[
              normalizedDomain
            ];
            if (typeof cookieHeader !== "string" || cookieHeader.trim() === "") {
              throw new Error("Stored browser credential has no cookies for the requested domain");
            }
            return cookieHeader;
          },
          catch: (error) =>
            new InfrastructureError(
              "browser session",
              "Stored browser credential is invalid",
              error,
            ),
        });
      }),
    ),
});
