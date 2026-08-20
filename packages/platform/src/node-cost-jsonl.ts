/** Node file adapter for the portable cost JSONL scanner. */
import { createHash } from "node:crypto";
import { lstat, open, type FileHandle } from "node:fs/promises";
import {
  parseClaudeCostJsonl,
  parseCodexCostJsonl,
  type ClaudeJsonlParseResult,
  type ClaudeJsonlState,
  type CodexJsonlParseResult,
  type CodexJsonlState,
  type CostJsonlCursor,
  type PricingCatalog,
} from "@codexbar/core";

const streamChunkBytes = 64 * 1024;

export interface NodeCostJsonlFingerprint {
  readonly device: string;
  readonly inode: string;
  readonly size: number;
  readonly mtimeMs: number;
  /** A bounded append-safe anchor. Rewrites cannot reuse a cursor silently. */
  readonly prefixBytes: number;
  readonly prefixSha256: string;
}

export interface NodeCodexCostJsonlState {
  readonly version: 1;
  readonly fingerprint: NodeCostJsonlFingerprint;
  readonly cursor: CostJsonlCursor;
  readonly parser: CodexJsonlState;
}

export interface NodeClaudeCostJsonlState {
  readonly version: 1;
  readonly fingerprint: NodeCostJsonlFingerprint;
  readonly cursor: CostJsonlCursor;
  readonly parser: ClaudeJsonlState;
}

interface NodeCostJsonlOptions<ParserState> {
  readonly path: string;
  readonly state?: {
    readonly fingerprint: NodeCostJsonlFingerprint;
    readonly cursor: CostJsonlCursor;
    readonly parser: ParserState;
  };
  /** Bounded bytes newly read in this refresh; zero means no cap. */
  readonly maxBytes?: number;
  readonly maxLineBytes?: number;
  readonly catalog?: PricingCatalog;
  readonly signal?: AbortSignal;
  /** Host-owned hook used to coordinate a source mutation immediately before revalidation. */
  readonly beforeSourceRevalidation?: () => void | Promise<void>;
}

export interface NodeCodexCostJsonlOptions extends NodeCostJsonlOptions<CodexJsonlState> {}
export interface NodeClaudeCostJsonlOptions extends NodeCostJsonlOptions<ClaudeJsonlState> {}

export interface NodeCostJsonlResult<Result, State> {
  readonly result: Result;
  /** Persist this only after the caller persists all rows atomically. */
  readonly state: State;
  readonly resumed: boolean;
}

/** The file changed while being read, so callers must discard rows and retry from a fresh stat. */
export class CostJsonlSourceChangedError extends Error {
  constructor(path: string) {
    super(`Cost JSONL source changed while scanning: ${path}`);
    this.name = "CostJsonlSourceChangedError";
  }
}

/** The source is a symlink, directory, device, or has unsafe metadata. */
export class CostJsonlInvalidSourceError extends Error {
  constructor(path: string, reason: string) {
    super(`Invalid cost JSONL source (${reason}): ${path}`);
    this.name = "CostJsonlInvalidSourceError";
  }
}

export const scanNodeCodexCostJsonl = async (
  options: NodeCodexCostJsonlOptions,
): Promise<NodeCostJsonlResult<CodexJsonlParseResult, NodeCodexCostJsonlState>> => {
  const initial = await openSource(options);
  try {
    const result = await parseCodexCostJsonl(
      readChunks(initial.handle, initial.startOffset, options.signal, readBudget(options.maxBytes)),
      {
        ...(initial.parser === undefined ? {} : { state: initial.parser }),
        ...(options.catalog === undefined ? {} : { catalog: options.catalog }),
        scan: scanOptions(initial.cursor, options),
      },
    );
    await options.beforeSourceRevalidation?.();
    await verifyUnchangedSource(options.path, initial.handle, initial.fingerprint);
    return {
      result,
      state: {
        version: 1,
        fingerprint: initial.fingerprint,
        cursor: result.cursor,
        parser: result.state,
      },
      resumed: initial.resumed,
    };
  } finally {
    await initial.handle.close();
  }
};

export const scanNodeClaudeCostJsonl = async (
  options: NodeClaudeCostJsonlOptions,
): Promise<NodeCostJsonlResult<ClaudeJsonlParseResult, NodeClaudeCostJsonlState>> => {
  const initial = await openSource(options);
  try {
    const result = await parseClaudeCostJsonl(
      readChunks(initial.handle, initial.startOffset, options.signal, readBudget(options.maxBytes)),
      {
        ...(initial.parser === undefined ? {} : { state: initial.parser }),
        ...(options.catalog === undefined ? {} : { catalog: options.catalog }),
        scan: scanOptions(initial.cursor, options),
      },
    );
    await options.beforeSourceRevalidation?.();
    await verifyUnchangedSource(options.path, initial.handle, initial.fingerprint);
    return {
      result,
      state: {
        version: 1,
        fingerprint: initial.fingerprint,
        cursor: result.cursor,
        parser: result.state,
      },
      resumed: initial.resumed,
    };
  } finally {
    await initial.handle.close();
  }
};

async function openSource<ParserState>(options: NodeCostJsonlOptions<ParserState>): Promise<{
  readonly fingerprint: NodeCostJsonlFingerprint;
  readonly handle: FileHandle;
  readonly parser: ParserState | undefined;
  readonly resumed: boolean;
  readonly cursor: CostJsonlCursor;
  readonly startOffset: number;
}> {
  throwIfAborted(options.signal);
  await assertRegularPath(options.path);
  const handle = await open(options.path, "r");
  try {
    const fingerprint = await fingerprintForHandle(handle, options.path);
    await assertPathStillReferences(options.path, fingerprint);
    const state = options.state;
    const resumed =
      state !== undefined &&
      (await sameResumeSource(handle, state.fingerprint, fingerprint, options.path));
    const cursor = resumed
      ? validatedCursor(state!.cursor, fingerprint.size, options.path)
      : { committedOffset: 0 };
    return {
      fingerprint,
      handle,
      parser: resumed ? state!.parser : undefined,
      resumed,
      cursor,
      startOffset: cursor.discardOffset ?? cursor.committedOffset,
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function scanOptions<ParserState>(
  cursor: CostJsonlCursor,
  options: NodeCostJsonlOptions<ParserState>,
): Omit<import("@codexbar/core").CostJsonlChunkScanOptions, "onLine"> {
  return {
    cursor,
    ...(options.maxBytes === undefined || options.maxBytes === 0
      ? {}
      : { maxBytes: nonNegativeSafeInteger(options.maxBytes, "maxBytes") }),
    ...(options.maxLineBytes === undefined
      ? {}
      : { maxLineBytes: nonNegativeSafeInteger(options.maxLineBytes, "maxLineBytes") }),
    checkCancelled: () => throwIfAborted(options.signal),
  };
}

async function* readChunks(
  handle: FileHandle,
  startOffset: number,
  signal: AbortSignal | undefined,
  maxBytes: number | undefined,
): AsyncIterable<Uint8Array> {
  throwIfAborted(signal);
  let position = startOffset;
  let remaining = maxBytes;
  while (remaining === undefined || remaining > 0) {
    throwIfAborted(signal);
    const requested = Math.min(streamChunkBytes, remaining ?? streamChunkBytes);
    const bytes = new Uint8Array(requested);
    const { bytesRead } = await handle.read(bytes, 0, requested, position);
    if (bytesRead === 0) return;
    position += bytesRead;
    if (remaining !== undefined) remaining -= bytesRead;
    yield bytes.subarray(0, bytesRead);
  }
}

async function verifyUnchangedSource(
  path: string,
  handle: FileHandle,
  expected: NodeCostJsonlFingerprint,
): Promise<void> {
  if (!sameFingerprint(expected, await fingerprintForHandle(handle, path))) {
    throw new CostJsonlSourceChangedError(path);
  }
  await assertPathStillReferences(path, expected);
}

async function fingerprintForHandle(
  handle: FileHandle,
  path: string,
): Promise<NodeCostJsonlFingerprint> {
  const info = await handle.stat({ bigint: true });
  if (!info.isFile()) throw new CostJsonlInvalidSourceError(path, "not a regular file");
  const size = safeNumber(info.size, path, "size");
  const mtimeMs = safeNumber(info.mtimeMs, path, "mtime");
  const prefixBytes = Math.min(size, 4096);
  const prefixSha256 = await hashPrefix(handle, prefixBytes);
  return {
    device: info.dev.toString(),
    inode: info.ino.toString(),
    size,
    mtimeMs,
    prefixBytes,
    prefixSha256,
  };
}

async function hashPrefix(handle: FileHandle, length: number): Promise<string> {
  const bytes = new Uint8Array(length);
  const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength, 0);
  return createHash("sha256").update(bytes.subarray(0, bytesRead)).digest("hex");
}

function sameFile(left: NodeCostJsonlFingerprint, right: NodeCostJsonlFingerprint): boolean {
  return left.device === right.device && left.inode === right.inode;
}

async function sameResumeSource(
  handle: FileHandle,
  left: NodeCostJsonlFingerprint,
  right: NodeCostJsonlFingerprint,
  path: string,
): Promise<boolean> {
  assertFingerprint(left, path);
  return (
    sameFile(left, right) &&
    right.size >= left.size &&
    left.prefixSha256 === (await hashPrefix(handle, left.prefixBytes))
  );
}

function sameFingerprint(left: NodeCostJsonlFingerprint, right: NodeCostJsonlFingerprint): boolean {
  return (
    sameFile(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.prefixSha256 === right.prefixSha256
  );
}

async function assertRegularPath(path: string): Promise<void> {
  const info = await lstat(path, { bigint: true });
  if (info.isSymbolicLink()) throw new CostJsonlInvalidSourceError(path, "symbolic link");
  if (!info.isFile()) throw new CostJsonlInvalidSourceError(path, "not a regular file");
  safeNumber(info.size, path, "size");
}

async function assertPathStillReferences(
  path: string,
  expected: NodeCostJsonlFingerprint,
): Promise<void> {
  const info = await lstat(path, { bigint: true });
  if (info.isSymbolicLink()) throw new CostJsonlSourceChangedError(path);
  if (!info.isFile()) throw new CostJsonlSourceChangedError(path);
  safeNumber(info.size, path, "size");
  if (info.dev.toString() !== expected.device || info.ino.toString() !== expected.inode) {
    throw new CostJsonlSourceChangedError(path);
  }
}

function validatedCursor(cursor: CostJsonlCursor, size: number, path: string): CostJsonlCursor {
  if (!isNonNegativeSafeInteger(cursor.committedOffset)) {
    throw new CostJsonlInvalidSourceError(path, "invalid persisted cursor");
  }
  const committedOffset = cursor.committedOffset;
  if (cursor.discardOffset !== undefined && !isNonNegativeSafeInteger(cursor.discardOffset)) {
    throw new CostJsonlInvalidSourceError(path, "invalid persisted cursor");
  }
  const discardOffset = cursor.discardOffset;
  if (
    committedOffset > size ||
    (discardOffset !== undefined && (discardOffset < committedOffset || discardOffset > size))
  ) {
    throw new CostJsonlInvalidSourceError(path, "invalid persisted cursor");
  }
  return { committedOffset, ...(discardOffset === undefined ? {} : { discardOffset }) };
}

function assertFingerprint(fingerprint: NodeCostJsonlFingerprint, path: string): void {
  if (
    !Number.isSafeInteger(fingerprint.size) ||
    fingerprint.size < 0 ||
    !Number.isSafeInteger(fingerprint.mtimeMs) ||
    !Number.isSafeInteger(fingerprint.prefixBytes) ||
    fingerprint.prefixBytes < 0 ||
    fingerprint.prefixBytes > Math.min(fingerprint.size, 4096) ||
    typeof fingerprint.prefixSha256 !== "string"
  ) {
    throw new CostJsonlInvalidSourceError(path, "invalid persisted fingerprint");
  }
}

function safeNumber(value: bigint, path: string, field: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new CostJsonlInvalidSourceError(path, `${field} exceeds JavaScript safe integer range`);
  }
  return Number(value);
}

function nonNegativeSafeInteger(value: number, field: string): number {
  if (!isNonNegativeSafeInteger(value))
    throw new Error(`${field} must be a non-negative safe integer`);
  return value;
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function readBudget(maxBytes: number | undefined): number | undefined {
  return maxBytes === undefined || maxBytes === 0
    ? undefined
    : nonNegativeSafeInteger(maxBytes, "maxBytes");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

function abortError(): Error {
  const error = new Error("Cost JSONL scan cancelled");
  error.name = "AbortError";
  return error;
}
