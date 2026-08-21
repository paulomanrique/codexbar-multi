import type { ProviderInstanceId } from "@codexbar/contracts";

export type PlanUtilizationHistoryProviders = Readonly<
  Partial<Record<ProviderInstanceId, PlanUtilizationHistoryBuckets>>
>;

/** The on-disk format used by CodexBar's plan-utilization history. */
export const PLAN_UTILIZATION_HISTORY_SCHEMA_VERSION = 1;

const UNSCOPED_IDENTITY_KEY = "__codexbar_unscoped__";
const INVALIDATED_IDENTITY = "__codexbar_invalidated__";
const PROVIDER_INSTANCE_ID = /^[a-z0-9-]{1,64}$/;
const ISO8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export class PlanUtilizationSeriesName {
  readonly rawValue: string;

  constructor(rawValue: string) {
    this.rawValue = rawValue;
  }

  static readonly session = new PlanUtilizationSeriesName("session");
  static readonly weekly = new PlanUtilizationSeriesName("weekly");
  static readonly monthly = new PlanUtilizationSeriesName("monthly");
  static readonly opus = new PlanUtilizationSeriesName("opus");

  canonicalWindowMinutes(windowMinutes: number): number {
    if (this.rawValue === "session" && windowMinutes >= 295 && windowMinutes <= 305) return 300;
    if (this.rawValue === "weekly" && windowMinutes >= 10_070 && windowMinutes <= 10_090)
      return 10_080;
    return windowMinutes;
  }
}

export interface PlanUtilizationHistoryEntryInput {
  readonly capturedAt: Date;
  readonly usedPercent: number;
  readonly resetsAt?: Date | null;
}

export class PlanUtilizationHistoryEntry {
  readonly capturedAt: Date;
  readonly usedPercent: number;
  readonly resetsAt?: Date;

  constructor(input: PlanUtilizationHistoryEntryInput) {
    this.capturedAt = new Date(input.capturedAt.getTime());
    this.usedPercent = input.usedPercent;
    if (input.resetsAt != null) this.resetsAt = new Date(input.resetsAt.getTime());
  }
}

export interface PlanUtilizationSeriesHistoryInput {
  readonly name: PlanUtilizationSeriesName | string;
  readonly windowMinutes: number;
  readonly entries:
    | readonly PlanUtilizationHistoryEntryInput[]
    | readonly PlanUtilizationHistoryEntry[];
}

export class PlanUtilizationSeriesHistory {
  readonly name: PlanUtilizationSeriesName;
  readonly windowMinutes: number;
  readonly entries: readonly PlanUtilizationHistoryEntry[];

  constructor(input: PlanUtilizationSeriesHistoryInput) {
    this.name =
      input.name instanceof PlanUtilizationSeriesName
        ? input.name
        : new PlanUtilizationSeriesName(input.name);
    this.windowMinutes = input.windowMinutes;
    this.entries = [...input.entries]
      .map((entry) =>
        entry instanceof PlanUtilizationHistoryEntry
          ? entry
          : new PlanUtilizationHistoryEntry(entry),
      )
      .sort(compareEntries);
  }

  get latestCapturedAt(): Date | undefined {
    const latest = this.entries[this.entries.length - 1];
    return latest?.capturedAt;
  }
}

export interface PlanUtilizationHistoryBucketsInput {
  readonly preferredAccountKey?: string | null;
  readonly unscoped?:
    | readonly PlanUtilizationSeriesHistoryInput[]
    | readonly PlanUtilizationSeriesHistory[];
  readonly accounts?: Readonly<
    Record<
      string,
      readonly PlanUtilizationSeriesHistoryInput[] | readonly PlanUtilizationSeriesHistory[]
    >
  >;
  readonly sessionEquivalentWindowPairIdentities?: Readonly<Record<string, string>>;
}

export class PlanUtilizationHistoryBuckets {
  preferredAccountKey?: string;
  unscoped: PlanUtilizationSeriesHistory[];
  accounts: Record<string, PlanUtilizationSeriesHistory[]>;
  sessionEquivalentWindowPairIdentities: Record<string, string>;

  constructor(input: PlanUtilizationHistoryBucketsInput = {}) {
    if (input.preferredAccountKey != null) this.preferredAccountKey = input.preferredAccountKey;
    this.unscoped = sortHistories(input.unscoped ?? []);
    this.accounts = Object.fromEntries(
      Object.entries(input.accounts ?? [])
        .map(([key, histories]) => [key, sortHistories(histories)] as const)
        .filter(([, histories]) => histories.length > 0),
    );
    this.sessionEquivalentWindowPairIdentities = {
      ...input.sessionEquivalentWindowPairIdentities,
    };
  }

  historiesFor(accountKey: string | null | undefined): readonly PlanUtilizationSeriesHistory[] {
    if (accountKey == null || accountKey.length === 0) return this.unscoped;
    return this.accounts[accountKey] ?? [];
  }

  setHistories(
    histories:
      | readonly PlanUtilizationSeriesHistoryInput[]
      | readonly PlanUtilizationSeriesHistory[],
    accountKey?: string | null,
  ): void {
    const sorted = sortHistories(histories);
    if (accountKey == null || accountKey.length === 0) {
      this.unscoped = sorted;
    } else if (sorted.length === 0) {
      delete this.accounts[accountKey];
    } else {
      this.accounts[accountKey] = sorted;
    }
  }

  sessionEquivalentWindowPairIdentityFor(accountKey?: string | null): string | undefined {
    return this.sessionEquivalentWindowPairIdentities[identityKey(accountKey)];
  }

  setSessionEquivalentWindowPairIdentity(
    identity: string | null | undefined,
    accountKey?: string | null,
  ): void {
    const key = identityKey(accountKey);
    if (identity != null) this.sessionEquivalentWindowPairIdentities[key] = identity;
    else delete this.sessionEquivalentWindowPairIdentities[key];
  }

  invalidateSessionEquivalentWindowPairIdentity(accountKey?: string | null): void {
    this.sessionEquivalentWindowPairIdentities[identityKey(accountKey)] = INVALIDATED_IDENTITY;
  }

  moveSessionEquivalentWindowPairIdentity(
    sourceAccountKey?: string | null,
    targetAccountKey?: string | null,
  ): void {
    const sourceKey = identityKey(sourceAccountKey);
    const targetKey = identityKey(targetAccountKey);
    if (sourceKey === targetKey) return;
    const sourceIdentity = this.sessionEquivalentWindowPairIdentities[sourceKey];
    if (sourceIdentity == null) return;
    const targetIdentity = this.sessionEquivalentWindowPairIdentities[targetKey];
    this.sessionEquivalentWindowPairIdentities[targetKey] =
      targetIdentity != null && targetIdentity !== sourceIdentity
        ? INVALIDATED_IDENTITY
        : sourceIdentity;
    delete this.sessionEquivalentWindowPairIdentities[sourceKey];
  }

  get isEmpty(): boolean {
    return (
      this.unscoped.length === 0 &&
      Object.values(this.accounts).every((histories) => histories.length === 0)
    );
  }
}

export class PlanUtilizationHistorySelection {
  readonly accountKey?: string;
  readonly histories: readonly PlanUtilizationSeriesHistory[];
  readonly cacheIdentity: string;

  constructor(
    accountKey: string | null | undefined,
    histories: readonly PlanUtilizationSeriesHistory[],
    cacheIdentity?: string,
  ) {
    if (accountKey != null) this.accountKey = accountKey;
    this.histories = histories;
    this.cacheIdentity = cacheIdentity ?? `account:${accountKey ?? "__unscoped__"}`;
  }

  static readonly unavailable = new PlanUtilizationHistorySelection(null, [], "unavailable");
}

export interface PlanUtilizationHistoryDocument {
  readonly version: 1;
  readonly preferredAccountKey?: string;
  readonly unscoped: readonly PlanUtilizationSeriesDocument[];
  readonly accounts: Readonly<Record<string, readonly PlanUtilizationSeriesDocument[]>>;
  readonly sessionEquivalentWindowPairIdentities: Readonly<Record<string, string>>;
}

export interface PlanUtilizationSeriesDocument {
  readonly name: string;
  readonly windowMinutes: number;
  readonly entries: readonly PlanUtilizationEntryDocument[];
}

export interface PlanUtilizationEntryDocument {
  readonly capturedAt: string;
  readonly usedPercent: number;
  readonly resetsAt?: string;
}

/**
 * Decode one provider JSON file. Invalid files and unsupported versions return
 * undefined, matching the Swift store's fail-soft per-file behavior.
 */
export function decodePlanUtilizationHistoryDocument(
  input: unknown,
): PlanUtilizationHistoryBuckets | undefined {
  if (!isRecord(input) || input.version !== PLAN_UTILIZATION_HISTORY_SCHEMA_VERSION)
    return undefined;
  if (!Array.isArray(input.unscoped) || !isRecord(input.accounts)) return undefined;
  const unscoped = decodeHistories(input.unscoped);
  if (unscoped == null) return undefined;
  const accounts: Record<string, PlanUtilizationSeriesHistory[]> = {};
  for (const [accountKey, rawHistories] of Object.entries(input.accounts)) {
    if (!Array.isArray(rawHistories)) return undefined;
    const histories = decodeHistories(rawHistories);
    if (histories == null) return undefined;
    if (histories.length > 0) accounts[accountKey] = histories;
  }
  const identities = decodeIdentities(input.sessionEquivalentWindowPairIdentities);
  if (identities == null) return undefined;
  const preferredAccountKey =
    input.preferredAccountKey == null
      ? undefined
      : typeof input.preferredAccountKey === "string"
        ? input.preferredAccountKey
        : undefined;
  if (input.preferredAccountKey != null && preferredAccountKey === undefined) return undefined;
  return new PlanUtilizationHistoryBuckets({
    ...(preferredAccountKey === undefined ? {} : { preferredAccountKey }),
    unscoped,
    accounts,
    sessionEquivalentWindowPairIdentities: identities,
  });
}

/** Encode the exact v1 provider document shape used by Swift. */
export function encodePlanUtilizationHistoryDocument(
  buckets: PlanUtilizationHistoryBuckets,
): PlanUtilizationHistoryDocument {
  const document: Record<string, unknown> = {
    accounts: sortedAccounts(buckets.accounts),
    sessionEquivalentWindowPairIdentities: sortStringMap(
      buckets.sessionEquivalentWindowPairIdentities,
    ),
    unscoped: encodeHistories(buckets.unscoped),
    version: PLAN_UTILIZATION_HISTORY_SCHEMA_VERSION,
  };
  if (buckets.preferredAccountKey !== undefined)
    document.preferredAccountKey = buckets.preferredAccountKey;
  return document as unknown as PlanUtilizationHistoryDocument;
}

/** Stable JSON equivalent to JSONEncoder.outputFormatting = [.sortedKeys]. */
export function stringifyPlanUtilizationHistoryDocument(
  buckets: PlanUtilizationHistoryBuckets,
): string {
  return JSON.stringify(sortJsonKeys(encodePlanUtilizationHistoryDocument(buckets)));
}

export function parsePlanUtilizationHistoryDocument(
  json: string,
): PlanUtilizationHistoryBuckets | undefined {
  try {
    return decodePlanUtilizationHistoryDocument(JSON.parse(json) as unknown);
  } catch {
    return undefined;
  }
}

export function decodePlanUtilizationHistoryProviders(
  input: unknown,
): Record<ProviderInstanceId, PlanUtilizationHistoryBuckets> {
  if (!isRecord(input)) return {};
  const output: Record<string, PlanUtilizationHistoryBuckets> = {};
  for (const [instanceId, document] of Object.entries(input)) {
    if (!PROVIDER_INSTANCE_ID.test(instanceId)) continue;
    const decoded = decodePlanUtilizationHistoryDocument(document);
    if (decoded !== undefined) output[instanceId] = decoded;
  }
  return output as Record<ProviderInstanceId, PlanUtilizationHistoryBuckets>;
}

function decodeHistories(input: readonly unknown[]): PlanUtilizationSeriesHistory[] | undefined {
  const histories: PlanUtilizationSeriesHistory[] = [];
  for (const raw of input) {
    if (
      !isRecord(raw) ||
      typeof raw.name !== "string" ||
      typeof raw.windowMinutes !== "number" ||
      !Number.isSafeInteger(raw.windowMinutes) ||
      !Array.isArray(raw.entries)
    )
      return undefined;
    const name = raw.name;
    const windowMinutes = raw.windowMinutes;
    const rawEntries = raw.entries;
    const entries: PlanUtilizationHistoryEntry[] = [];
    for (const entry of rawEntries) {
      if (
        !isRecord(entry) ||
        typeof entry.capturedAt !== "string" ||
        !validISODate(entry.capturedAt) ||
        typeof entry.usedPercent !== "number" ||
        !Number.isFinite(entry.usedPercent)
      )
        return undefined;
      let resetsAt: Date | undefined;
      if (entry.resetsAt != null) {
        if (typeof entry.resetsAt !== "string" || !validISODate(entry.resetsAt)) return undefined;
        resetsAt = new Date(entry.resetsAt);
      }
      entries.push(
        new PlanUtilizationHistoryEntry({
          capturedAt: new Date(entry.capturedAt),
          usedPercent: entry.usedPercent,
          ...(resetsAt === undefined ? {} : { resetsAt }),
        }),
      );
    }
    histories.push(new PlanUtilizationSeriesHistory({ name, windowMinutes, entries }));
  }
  return sortHistories(histories);
}

function encodeHistories(
  histories: readonly PlanUtilizationSeriesHistory[],
): readonly PlanUtilizationSeriesDocument[] {
  return sortHistories(histories).map((history) => ({
    entries: history.entries.map((entry) => {
      return {
        capturedAt: swiftISODate(entry.capturedAt),
        ...(entry.resetsAt === undefined ? {} : { resetsAt: swiftISODate(entry.resetsAt) }),
        usedPercent: entry.usedPercent,
      } satisfies PlanUtilizationEntryDocument;
    }),
    name: history.name.rawValue,
    windowMinutes: history.windowMinutes,
  }));
}

function sortHistories(
  histories: readonly PlanUtilizationSeriesHistoryInput[] | readonly PlanUtilizationSeriesHistory[],
): PlanUtilizationSeriesHistory[] {
  return [...histories]
    .map((history) =>
      history instanceof PlanUtilizationSeriesHistory
        ? history
        : new PlanUtilizationSeriesHistory(history),
    )
    .filter((history) => history.windowMinutes > 0 && history.entries.length > 0)
    .sort(
      (left, right) =>
        left.windowMinutes - right.windowMinutes ||
        compareSwiftStrings(left.name.rawValue, right.name.rawValue),
    );
}

function sortedAccounts(
  accounts: Readonly<Record<string, readonly PlanUtilizationSeriesHistory[]>>,
): Readonly<Record<string, readonly PlanUtilizationSeriesDocument[]>> {
  return Object.fromEntries(
    Object.entries(accounts)
      .sort(([left], [right]) => compareSwiftStrings(left, right))
      .flatMap(([key, histories]) => {
        const sorted = sortHistories(histories);
        return sorted.length === 0 ? [] : [[key, encodeHistories(sorted)] as const];
      }),
  );
}

function sortStringMap(values: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(values).sort(([left], [right]) => compareSwiftStrings(left, right)),
  );
}

function compareEntries(
  left: PlanUtilizationHistoryEntry,
  right: PlanUtilizationHistoryEntry,
): number {
  return (
    left.capturedAt.getTime() - right.capturedAt.getTime() ||
    left.usedPercent - right.usedPercent ||
    (left.resetsAt?.getTime() ?? Number.NEGATIVE_INFINITY) -
      (right.resetsAt?.getTime() ?? Number.NEGATIVE_INFINITY)
  );
}

function identityKey(accountKey?: string | null): string {
  return accountKey == null || accountKey.length === 0 ? UNSCOPED_IDENTITY_KEY : accountKey;
}

function validISODate(value: string): boolean {
  return ISO8601.test(value) && Number.isFinite(Date.parse(value));
}

function swiftISODate(value: Date): string {
  // Foundation's JSONEncoder `.iso8601` strategy uses ISO8601DateFormatter
  // without `.withFractionalSeconds`; fractional Date precision is dropped.
  return value.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function decodeIdentities(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return {};
  if (!isRecord(value) || Object.values(value).some((identity) => typeof identity !== "string"))
    return undefined;
  return { ...(value as Record<string, string>) };
}

function sortJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareSwiftStrings(left, right))
      .map(([key, child]) => [key, sortJsonKeys(child)]),
  );
}

/** Swift String's Comparable is Unicode-scalar lexical ordering, not locale ordering. */
function compareSwiftStrings(left: string, right: string): number {
  const leftScalars = Array.from(left, (character) => character.codePointAt(0) ?? 0);
  const rightScalars = Array.from(right, (character) => character.codePointAt(0) ?? 0);
  const length = Math.min(leftScalars.length, rightScalars.length);
  for (let index = 0; index < length; index += 1) {
    const leftScalar = leftScalars[index] ?? 0;
    const rightScalar = rightScalars[index] ?? 0;
    if (leftScalar !== rightScalar) return leftScalar - rightScalar;
  }
  return leftScalars.length - rightScalars.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
