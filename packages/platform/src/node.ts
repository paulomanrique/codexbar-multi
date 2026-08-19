import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Entry } from "@napi-rs/keyring";
import { Effect } from "effect";
import type { AppPaths } from "@codexbar/core";
import { InfrastructureError } from "@codexbar/core";

export * from "./node-persistence.ts";
export * from "./node-persistence-worker-client.ts";

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
