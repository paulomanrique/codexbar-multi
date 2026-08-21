import {
  decodeUsageSnapshot,
  type NamedRateWindow,
  type RateWindow,
  type UsageSnapshot,
} from "@codexbar/contracts";

/**
 * Portable Claude Swap account projection.
 *
 * `cswap` remains a host-owned executable integration.  Once its schema-v1
 * JSON has been parsed, however, its account cards and the small retained
 * at-limit cache are pure data.  Keeping that policy here lets desktop and
 * CLI share it without giving either the other platform's process APIs.
 */
export const CLAUDE_SWAP_SOURCE = "claude-swap" as const;
export const CLAUDE_SWAP_DEFERRED_POLLING_NOTE = "Polling deferred until a limit resets.";

const FIVE_HOUR_MINUTES = 5 * 60;
const SEVEN_DAY_MINUTES = 7 * 24 * 60;
const EXHAUSTED_PERCENT = 100;
const FINGERPRINT_PREFIX = "fp:";

export type ClaudeSwapUsageStatus =
  | "ok"
  | "token_expired"
  | "relogin_required"
  | "api_key"
  | "keychain_unavailable"
  | "no_credentials"
  | "unavailable"
  | { readonly unknown: string };

export type ClaudeSwapUsageWindow = {
  readonly usedPercent: number;
  readonly resetsAt?: string;
};

export type ClaudeSwapScopedUsageWindow = ClaudeSwapUsageWindow & {
  readonly name: string;
};

export type ClaudeSwapAccountRow = {
  /** Source-issued numeric slot. It is deliberately not derived from email. */
  readonly number: number;
  /** Display-only sensitive information. Never written to retained records. */
  readonly email: string;
  readonly isActive: boolean;
  readonly usageStatus: ClaudeSwapUsageStatus;
  readonly fiveHour?: ClaudeSwapUsageWindow;
  readonly sevenDay?: ClaudeSwapUsageWindow;
  readonly scoped?: readonly ClaudeSwapScopedUsageWindow[];
};

export type ClaudeSwapAccountList = {
  readonly activeAccountNumber?: number;
  readonly accounts: readonly ClaudeSwapAccountRow[];
};

export type ClaudeSwapAccountIdentity = {
  readonly source: typeof CLAUDE_SWAP_SOURCE;
  readonly opaqueId: string;
};

/** Provider-neutral account card DTO, intentionally kept serializable. */
export type ClaudeSwapAccountSnapshot = {
  readonly id: ClaudeSwapAccountIdentity;
  readonly provider: "claude";
  readonly displayLabel: string;
  readonly isActive: boolean;
  readonly canActivate: boolean;
  readonly snapshot?: UsageSnapshot;
  readonly error?: string;
  readonly sourceLabel: typeof CLAUDE_SWAP_SOURCE;
};

/**
 * On-disk cache shape. It purposely excludes email/displayLabel and stores a
 * SHA-256 discriminator instead, so a reused slot cannot inherit old bars.
 */
export type ClaudeSwapRetainedUsageRecord = {
  /** Swift Codable key; preserve its capital-D spelling for upstream cache compatibility. */
  readonly opaqueID: string;
  readonly accountFingerprint: string;
  readonly primary?: RateWindow;
  readonly secondary?: RateWindow;
  readonly extraRateWindows?: readonly NamedRateWindow[];
  readonly updatedAt: string;
};

export type ClaudeSwapProjectionOptions = {
  readonly previousAccounts?: readonly ClaudeSwapAccountSnapshot[];
  readonly now?: Date;
};

const clampPercent = (value: number) => Math.max(0, Math.min(100, value));

const isFutureDate = (value: string | undefined, now: Date): value is string =>
  value !== undefined && Number.isFinite(Date.parse(value)) && Date.parse(value) > now.getTime();

const displayLabel = (row: ClaudeSwapAccountRow) =>
  row.email.trim() === "" ? `Account ${row.number}` : row.email.trim();

const accountIdentity = (row: ClaudeSwapAccountRow) => ({
  providerId: "claude" as const,
  accountEmail: displayLabel(row),
  loginMethod: CLAUDE_SWAP_SOURCE,
});

const rateWindow = (window: ClaudeSwapUsageWindow, windowMinutes: number): RateWindow => ({
  usedPercent: clampPercent(window.usedPercent),
  windowMinutes,
  ...(window.resetsAt !== undefined ? { resetsAt: window.resetsAt } : {}),
});

const scopedWindowSlug = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/gu, "");

/** Mirrors ClaudeScopedWeeklyLimitMapper for `cswap`'s name-only scopes. */
const scopedRateWindows = (row: ClaudeSwapAccountRow): readonly NamedRateWindow[] => {
  const seen = new Set<string>();
  return (row.scoped ?? []).flatMap((item) => {
    const name = item.name.trim();
    const slug = scopedWindowSlug(name);
    if (name === "" || slug === "" || slug === "all-models") return [];
    const id = `claude-weekly-scoped-${slug}`;
    if (seen.has(id)) return [];
    seen.add(id);
    return [{ id, title: `${name} only`, window: rateWindow(item, SEVEN_DAY_MINUTES) }];
  });
};

const projectedUsageSnapshot = (
  row: ClaudeSwapAccountRow,
  now: Date,
): UsageSnapshot | undefined => {
  const primary =
    row.fiveHour === undefined ? undefined : rateWindow(row.fiveHour, FIVE_HOUR_MINUTES);
  const secondary =
    row.sevenDay === undefined ? undefined : rateWindow(row.sevenDay, SEVEN_DAY_MINUTES);
  const extraRateWindows = scopedRateWindows(row);
  if (primary === undefined && secondary === undefined && extraRateWindows.length === 0)
    return undefined;
  return {
    ...(primary === undefined ? {} : { primary }),
    ...(secondary === undefined ? {} : { secondary }),
    ...(extraRateWindows.length === 0 ? {} : { extraRateWindows }),
    details: [],
    updatedAt: now.toISOString(),
    identity: accountIdentity(row),
  };
};

/** Keeps only future lanes and only while at least one lane is still exhausted. */
export const pruneClaudeSwapAtLimitSnapshot = (
  snapshot: UsageSnapshot,
  identity: UsageSnapshot["identity"],
  now: Date,
): UsageSnapshot | undefined => {
  const keep = (window: RateWindow | undefined) =>
    window !== undefined && isFutureDate(window.resetsAt, now) ? window : undefined;
  const primary = keep(snapshot.primary);
  const secondary = keep(snapshot.secondary);
  const extraRateWindows = (snapshot.extraRateWindows ?? []).flatMap((named) => {
    const window = keep(named.window);
    return window === undefined ? [] : [{ ...named, window }];
  });
  const windows = [primary, secondary, ...extraRateWindows.map((named) => named.window)];
  if (!windows.some((window) => (window?.usedPercent ?? 0) >= EXHAUSTED_PERCENT)) return undefined;
  return {
    ...(primary === undefined ? {} : { primary }),
    ...(secondary === undefined ? {} : { secondary }),
    ...(extraRateWindows.length === 0 ? {} : { extraRateWindows }),
    details: [],
    updatedAt: snapshot.updatedAt,
    ...(identity === undefined ? {} : { identity }),
    ...(snapshot.dataConfidence === undefined ? {} : { dataConfidence: snapshot.dataConfidence }),
  };
};

/** SHA-256 implemented over Uint8Array so the domain has no Node/WebCrypto dependency. */
const sha256Hex = (input: string): string => {
  const bytes = [...new TextEncoder().encode(input)];
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const high = Math.floor(bitLength / 2 ** 32);
  const low = bitLength >>> 0;
  for (const value of [high, low]) {
    bytes.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
  }

  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const state: [number, number, number, number, number, number, number, number] = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const rotate = (value: number, count: number) => (value >>> count) | (value << (32 - count));

  for (let offset = 0; offset < bytes.length; offset += 64) {
    const words = Array.from<number>({ length: 64 }).fill(0);
    for (let index = 0; index < 16; index += 1) {
      const start = offset + index * 4;
      words[index] =
        ((bytes[start] ?? 0) << 24) |
        ((bytes[start + 1] ?? 0) << 16) |
        ((bytes[start + 2] ?? 0) << 8) |
        (bytes[start + 3] ?? 0);
    }
    for (let index = 16; index < 64; index += 1) {
      const previous15 = words[index - 15] ?? 0;
      const previous2 = words[index - 2] ?? 0;
      const s0 = rotate(previous15, 7) ^ rotate(previous15, 18) ^ (previous15 >>> 3);
      const s1 = rotate(previous2, 17) ^ rotate(previous2, 19) ^ (previous2 >>> 10);
      words[index] = ((words[index - 16] ?? 0) + s0 + (words[index - 7] ?? 0) + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + choice + (constants[index] ?? 0) + (words[index] ?? 0)) >>> 0;
      const s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0;
    state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0;
    state[7] = (state[7] + h) >>> 0;
  }
  return state.map((value) => value.toString(16).padStart(8, "0")).join("");
};

export const claudeSwapAccountFingerprint = (
  email: string,
  opaqueId: string,
): string | undefined => {
  const normalized = email.trim().toLowerCase();
  return normalized.includes("@") ? sha256Hex(`${opaqueId}\0${normalized}`) : undefined;
};

const fingerprintFromAccount = (account: ClaudeSwapAccountSnapshot): string | undefined => {
  const stored = account.snapshot?.identity?.accountId;
  if (stored?.startsWith(FINGERPRINT_PREFIX) === true)
    return stored.slice(FINGERPRINT_PREFIX.length);
  return claudeSwapAccountFingerprint(
    account.snapshot?.identity?.accountEmail ?? account.displayLabel,
    account.id.opaqueId,
  );
};

const retainedAtLimitSnapshot = (
  previous: ClaudeSwapAccountSnapshot | undefined,
  row: ClaudeSwapAccountRow,
  now: Date,
): UsageSnapshot | undefined => {
  if (previous?.snapshot === undefined) return undefined;
  const previousFingerprint = fingerprintFromAccount(previous);
  const currentFingerprint = claudeSwapAccountFingerprint(row.email, String(row.number));
  if (
    previousFingerprint === undefined ||
    currentFingerprint === undefined ||
    previousFingerprint !== currentFingerprint
  ) {
    return undefined;
  }
  return pruneClaudeSwapAtLimitSnapshot(previous.snapshot, accountIdentity(row), now);
};

const canActivate = (status: ClaudeSwapUsageStatus) =>
  status === "ok" || status === "api_key" || status === "unavailable";

const statusError = (
  status: ClaudeSwapUsageStatus,
  snapshot: UsageSnapshot | undefined,
  now: Date,
) => {
  if (status === "ok") return snapshot === undefined ? "No usage windows reported." : undefined;
  if (status === "token_expired")
    return "Token expired. Switch to this account in claude-swap to refresh it.";
  if (status === "relogin_required")
    return "Re-login required. Re-authenticate this account in claude-swap.";
  if (status === "api_key") return "API-key account; subscription usage is unavailable.";
  if (status === "keychain_unavailable")
    return "claude-swap could not read the active account's Keychain entry.";
  if (status === "no_credentials") return "No stored credentials for this account slot.";
  if (status !== "unavailable") return `Unrecognized claude-swap status: ${status.unknown}`;
  const names: Array<readonly [string, RateWindow]> = [];
  if (snapshot?.primary !== undefined) names.push(["Session", snapshot.primary]);
  if (snapshot?.secondary !== undefined) names.push(["Weekly", snapshot.secondary]);
  for (const extra of snapshot?.extraRateWindows ?? []) {
    names.push([
      extra.title.endsWith(" only") ? extra.title.slice(0, -" only".length) : extra.title,
      extra.window,
    ]);
  }
  const notes = names.flatMap(([name, window]) => {
    if ((window.usedPercent ?? 0) < EXHAUSTED_PERCENT) return [];
    const reset = window.resetsAt === undefined ? undefined : resetLine(window.resetsAt, now);
    return [`${name} limit reached.${reset === undefined ? "" : ` ${reset}`}`];
  });
  return notes.length === 0 ? CLAUDE_SWAP_DEFERRED_POLLING_NOTE : notes.join(" ");
};

const resetLine = (reset: string, now: Date): string | undefined => {
  const milliseconds = Date.parse(reset) - now.getTime();
  if (!Number.isFinite(milliseconds)) return undefined;
  if (milliseconds < 1_000) return "Resets now.";
  const totalMinutes = Math.max(1, Math.ceil(milliseconds / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor(totalMinutes / 60) % 24;
  const minutes = totalMinutes % 60;
  const countdown =
    days > 0
      ? `${days}d${hours > 0 ? ` ${hours}h` : minutes > 0 ? ` ${minutes}m` : ""}`
      : hours > 0
        ? `${hours}h${minutes > 0 ? ` ${minutes}m` : ""}`
        : `${totalMinutes}m`;
  return `Resets in ${countdown}.`;
};

/** Direct port of `ClaudeSwapAccountProjection.accountSnapshots`. */
export const projectClaudeSwapAccounts = (
  list: ClaudeSwapAccountList,
  options: ClaudeSwapProjectionOptions = {},
): readonly ClaudeSwapAccountSnapshot[] => {
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime()))
    throw new TypeError("Claude Swap projection requires a valid now date");
  const previousById = new Map<string, ClaudeSwapAccountSnapshot>();
  for (const account of options.previousAccounts ?? []) {
    if (account.id.source === CLAUDE_SWAP_SOURCE && !previousById.has(account.id.opaqueId)) {
      previousById.set(account.id.opaqueId, account);
    }
  }
  return [...list.accounts]
    .sort(
      (left, right) => Number(right.isActive) - Number(left.isActive) || left.number - right.number,
    )
    .map((row) => {
      const previous = previousById.get(String(row.number));
      const projected = projectedUsageSnapshot(row, now);
      const snapshot =
        row.usageStatus === "ok"
          ? projected
          : row.usageStatus === "unavailable"
            ? projected === undefined
              ? retainedAtLimitSnapshot(previous, row, now)
              : pruneClaudeSwapAtLimitSnapshot(projected, projected.identity, now)
            : undefined;
      const error = statusError(row.usageStatus, snapshot, now);
      return {
        id: { source: CLAUDE_SWAP_SOURCE, opaqueId: String(row.number) },
        provider: "claude",
        displayLabel: displayLabel(row),
        isActive: row.isActive,
        canActivate: !row.isActive && canActivate(row.usageStatus),
        ...(snapshot === undefined ? {} : { snapshot }),
        ...(error === undefined ? {} : { error }),
        sourceLabel: CLAUDE_SWAP_SOURCE,
      };
    });
};

/** Creates privacy-preserving records; callers persist them with their PrivateFileStore. */
export const retainClaudeSwapUsage = (
  accounts: readonly ClaudeSwapAccountSnapshot[],
): readonly ClaudeSwapRetainedUsageRecord[] =>
  accounts.flatMap((account) => {
    if (account.id.source !== CLAUDE_SWAP_SOURCE || account.snapshot === undefined) return [];
    const accountFingerprint = claudeSwapAccountFingerprint(
      account.snapshot.identity?.accountEmail ?? account.displayLabel,
      account.id.opaqueId,
    );
    if (accountFingerprint === undefined) return [];
    return [
      {
        opaqueID: account.id.opaqueId,
        accountFingerprint,
        ...(account.snapshot.primary === undefined ? {} : { primary: account.snapshot.primary }),
        ...(account.snapshot.secondary === undefined
          ? {}
          : { secondary: account.snapshot.secondary }),
        ...(account.snapshot.extraRateWindows === undefined
          ? {}
          : { extraRateWindows: account.snapshot.extraRateWindows }),
        updatedAt: account.snapshot.updatedAt,
      },
    ];
  });

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Validates cache JSON through the public UsageSnapshot decoder before turning
 * it into inert previous accounts. Invalid records are ignored independently.
 */
export const restoreClaudeSwapRetainedUsage = (
  value: unknown,
): readonly ClaudeSwapAccountSnapshot[] => {
  if (!Array.isArray(value) || value.length > 256) return [];
  return value.flatMap((candidate) => {
    if (!isObject(candidate)) return [];
    // `opaqueId` was used by an early TS-only prototype. Read it defensively,
    // but always write Swift's `opaqueID` key above.
    const opaqueId = candidate.opaqueID ?? candidate.opaqueId;
    const accountFingerprint = candidate.accountFingerprint;
    const updatedAt = candidate.updatedAt;
    if (
      typeof opaqueId !== "string" ||
      opaqueId.length === 0 ||
      opaqueId.length > 64 ||
      typeof accountFingerprint !== "string" ||
      !/^[a-f0-9]{64}$/u.test(accountFingerprint) ||
      typeof updatedAt !== "string"
    ) {
      return [];
    }
    try {
      const snapshot = decodeUsageSnapshot({
        primary: candidate.primary ?? null,
        secondary: candidate.secondary ?? null,
        tertiary: null,
        extraRateWindows: candidate.extraRateWindows,
        updatedAt,
        identity: {
          providerID: "claude",
          loginMethod: CLAUDE_SWAP_SOURCE,
          accountID: `${FINGERPRINT_PREFIX}${accountFingerprint}`,
        },
      });
      return [
        {
          id: { source: CLAUDE_SWAP_SOURCE, opaqueId },
          provider: "claude" as const,
          displayLabel: "",
          isActive: false,
          canActivate: false,
          snapshot,
          sourceLabel: CLAUDE_SWAP_SOURCE,
        },
      ];
    } catch {
      return [];
    }
  });
};

export const serializeClaudeSwapRetainedUsage = (
  accounts: readonly ClaudeSwapAccountSnapshot[],
): string => JSON.stringify(retainClaudeSwapUsage(accounts));

export const deserializeClaudeSwapRetainedUsage = (
  text: string,
): readonly ClaudeSwapAccountSnapshot[] => {
  try {
    return restoreClaudeSwapRetainedUsage(JSON.parse(text) as unknown);
  } catch {
    return [];
  }
};
