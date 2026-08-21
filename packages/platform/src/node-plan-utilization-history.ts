import { constants } from "node:fs";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  PROVIDER_IDS,
  ProviderInstanceId as ProviderInstanceIdSchema,
  type ProviderInstanceId,
} from "@codexbar/contracts";
import {
  PlanUtilizationHistoryBuckets,
  parsePlanUtilizationHistoryDocument,
  stringifyPlanUtilizationHistoryDocument,
  type PrivateFileStoreService,
} from "@codexbar/core";
import { Effect, Schema } from "effect";
import { makeNodePrivateDirectoryRestriction } from "./node-private-path-security.ts";
import { makeNodePrivateFileStore, type NodePrivateFileStoreOptions } from "./node.ts";

const DEFAULT_MAXIMUM_FILE_BYTES = 16 * 1024 * 1024;

export type PlanUtilizationHistoryProviders = Readonly<
  Partial<Record<ProviderInstanceId, PlanUtilizationHistoryBuckets>>
>;

export interface NodePlanUtilizationHistoryStoreOptions extends NodePrivateFileStoreOptions {
  readonly directoryPath: string;
  /** First-party IDs whose absent histories must remove an older provider file. */
  readonly knownProviderIds?: readonly ProviderInstanceId[];
  /** Mature histories are bounded before allocation. Overrides may only tighten the default. */
  readonly maximumFileBytes?: number;
  readonly files?: Pick<PrivateFileStoreService, "writeAtomic" | "remove">;
}

export interface NodePlanUtilizationHistoryStore {
  /** Invalid, unsupported, unreadable, or unsafe files are skipped independently. */
  readonly load: Effect.Effect<PlanUtilizationHistoryProviders>;
  /** Mirrors Swift's best-effort persistence: failures never replace a valid file partially. */
  readonly save: (providers: PlanUtilizationHistoryProviders) => Effect.Effect<void>;
}

/**
 * Node-only persistence for Swift-compatible per-provider history documents.
 *
 * The directory is supplied by the composition root; core remains unaware of
 * paths and operating systems. Node has no portable openat-style directory
 * handle, so the adapter revalidates the direct directory before mutations
 * and reads each source from one no-follow handle.
 */
export const makeNodePlanUtilizationHistoryStore = (
  options: NodePlanUtilizationHistoryStoreOptions,
): NodePlanUtilizationHistoryStore => {
  const maximumFileBytes = boundedMaximum(options.maximumFileBytes);
  const knownProviderIds = options.knownProviderIds ?? PROVIDER_IDS;
  const files =
    options.files ??
    makeNodePrivateFileStore({
      ...(options.restrictFile === undefined ? {} : { restrictFile: options.restrictFile }),
      ...(options.restrictDirectory === undefined
        ? {}
        : { restrictDirectory: options.restrictDirectory }),
      ...(options.pathRestrictionOptions === undefined
        ? {}
        : { pathRestrictionOptions: options.pathRestrictionOptions }),
    });
  const restrictDirectory =
    options.restrictDirectory ??
    makeNodePrivateDirectoryRestriction(options.pathRestrictionOptions);

  return {
    load: Effect.tryPromise({
      try: (signal) => loadProviderFiles(options.directoryPath, maximumFileBytes, signal),
      catch: () => undefined,
    }).pipe(Effect.orElseSucceed(() => ({}))),
    save: (providers) =>
      Effect.tryPromise({
        try: (signal) =>
          saveProviderFiles({
            directoryPath: options.directoryPath,
            files,
            knownProviderIds,
            maximumFileBytes,
            providers,
            restrictDirectory,
            signal,
          }),
        catch: () => undefined,
      }).pipe(Effect.orElseSucceed(() => undefined)),
  };
};

const loadProviderFiles = async (
  directoryPath: string,
  maximumFileBytes: number,
  signal: AbortSignal,
): Promise<PlanUtilizationHistoryProviders> => {
  let entries;
  try {
    await assertRealDirectory(directoryPath);
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch {
    return {};
  }

  const output: Partial<Record<ProviderInstanceId, PlanUtilizationHistoryBuckets>> = {};
  for (const entry of entries) {
    if (signal.aborted) throw signal.reason;
    if (entry.isSymbolicLink() || entry.isDirectory() || !entry.name.endsWith(".json")) continue;
    const providerId = parseProviderFilename(entry.name);
    if (providerId === undefined) continue;
    try {
      const bytes = await readRegularFileBounded(
        join(directoryPath, entry.name),
        maximumFileBytes,
        signal,
      );
      const decoded = parsePlanUtilizationHistoryDocument(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
      if (decoded !== undefined) output[providerId] = decoded;
    } catch {
      // Swift loads provider files independently; one corrupt file must not
      // discard the remaining providers' history.
    }
  }
  return output;
};

interface SaveProviderFilesOptions {
  readonly directoryPath: string;
  readonly files: Pick<PrivateFileStoreService, "writeAtomic" | "remove">;
  readonly knownProviderIds: readonly ProviderInstanceId[];
  readonly maximumFileBytes: number;
  readonly providers: PlanUtilizationHistoryProviders;
  readonly restrictDirectory: (path: string) => Promise<void>;
  readonly signal: AbortSignal;
}

const saveProviderFiles = async (options: SaveProviderFilesOptions): Promise<void> => {
  await mkdir(options.directoryPath, { recursive: true, mode: 0o700 });
  await assertRealDirectory(options.directoryPath);
  await options.restrictDirectory(options.directoryPath);

  const providerIds = new Set<ProviderInstanceId>();
  for (const rawProviderId of options.knownProviderIds) {
    const providerId = parseProviderId(rawProviderId);
    if (providerId !== undefined) providerIds.add(providerId);
  }
  for (const rawProviderId of Object.keys(options.providers)) {
    const providerId = parseProviderId(rawProviderId);
    if (providerId !== undefined) providerIds.add(providerId);
  }

  for (const providerId of [...providerIds].sort(compareUnicodeScalars)) {
    if (options.signal.aborted) throw options.signal.reason;
    await assertRealDirectory(options.directoryPath);
    const path = join(options.directoryPath, `${providerId}.json`);
    const buckets = options.providers[providerId] ?? new PlanUtilizationHistoryBuckets();
    if (!hasPersistedHistory(buckets)) {
      await Effect.runPromise(options.files.remove(path));
      continue;
    }

    const content = new TextEncoder().encode(stringifyPlanUtilizationHistoryDocument(buckets));
    if (content.byteLength > options.maximumFileBytes)
      throw new Error("Plan-utilization history document exceeds its configured bound");
    let identical = false;
    try {
      const existing = await readRegularFileBounded(
        path,
        Math.min(options.maximumFileBytes, content.byteLength),
        options.signal,
      );
      identical = bytesEqual(existing, content);
    } catch {
      // Missing, oversized, unsafe, or changing targets are atomically
      // replaced by PrivateFileStore rather than trusted as current state.
    }
    if (!identical) await Effect.runPromise(options.files.writeAtomic(path, content));
  }
};

const readRegularFileBounded = async (
  path: string,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> => {
  const before = await lstat(path, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile() || before.size > BigInt(maximumBytes))
    throw new Error("Plan-utilization history source is not a bounded regular file");

  const openFlags =
    process.platform === "win32" || constants.O_NOFOLLOW === undefined
      ? constants.O_RDONLY
      : constants.O_RDONLY | constants.O_NOFOLLOW;
  const handle = await open(path, openFlags);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameFile(before, opened) || opened.size > BigInt(maximumBytes))
      throw new Error("Plan-utilization history source changed before read");

    const output = new Uint8Array(Number(opened.size));
    let offset = 0;
    while (offset < output.byteLength) {
      if (signal.aborted) throw signal.reason;
      const { bytesRead } = await handle.read(output, offset, output.byteLength - offset, offset);
      if (bytesRead === 0) throw new Error("Plan-utilization history source was truncated");
      offset += bytesRead;
    }

    const after = await handle.stat({ bigint: true });
    if (!sameSnapshot(opened, after))
      throw new Error("Plan-utilization history source changed during read");
    return output;
  } finally {
    await handle.close();
  }
};

const assertRealDirectory = async (path: string): Promise<void> => {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new Error("Plan-utilization history directory must be a real directory");
};

const parseProviderFilename = (filename: string): ProviderInstanceId | undefined => {
  if (!filename.endsWith(".json")) return undefined;
  return parseProviderId(filename.slice(0, -".json".length));
};

const parseProviderId = (value: string): ProviderInstanceId | undefined => {
  try {
    return Schema.decodeUnknownSync(ProviderInstanceIdSchema)(value);
  } catch {
    return undefined;
  }
};

const hasPersistedHistory = (buckets: PlanUtilizationHistoryBuckets): boolean =>
  buckets.unscoped.some((history) => history.windowMinutes > 0 && history.entries.length > 0) ||
  Object.values(buckets.accounts).some((histories) =>
    histories.some((history) => history.windowMinutes > 0 && history.entries.length > 0),
  ) ||
  Object.keys(buckets.sessionEquivalentWindowPairIdentities).length > 0;

const boundedMaximum = (value: number | undefined): number => {
  if (value === undefined) return DEFAULT_MAXIMUM_FILE_BYTES;
  if (!Number.isSafeInteger(value) || value <= 0 || value > DEFAULT_MAXIMUM_FILE_BYTES)
    throw new RangeError(
      `maximumFileBytes must be an integer between 1 and ${DEFAULT_MAXIMUM_FILE_BYTES}`,
    );
  return value;
};

const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
};

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

interface FileSnapshot extends FileIdentity {
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

const sameFile = (left: FileIdentity, right: FileIdentity): boolean =>
  left.dev === right.dev && left.ino === right.ino;

const sameSnapshot = (left: FileSnapshot, right: FileSnapshot): boolean =>
  sameFile(left, right) &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs;

const compareUnicodeScalars = (left: string, right: string): number => {
  const leftScalars = Array.from(left, (scalar) => scalar.codePointAt(0)!);
  const rightScalars = Array.from(right, (scalar) => scalar.codePointAt(0)!);
  const count = Math.min(leftScalars.length, rightScalars.length);
  for (let index = 0; index < count; index += 1) {
    const difference = leftScalars[index]! - rightScalars[index]!;
    if (difference !== 0) return difference;
  }
  return leftScalars.length - rightScalars.length;
};
