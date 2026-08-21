import { sha256Hex } from "./sha256.ts";

const PROVIDER_ACCOUNT_PREFIX = "codex:v1:provider-account:";
const EMAIL_HASH_PREFIX = "codex:v1:email-hash:";

export type CodexHistoryIdentity =
  | { readonly kind: "provider-account"; readonly id: string }
  | { readonly kind: "email-only"; readonly normalizedEmail: string }
  | { readonly kind: "unresolved" };

export type CodexHistoryPersistedOwner =
  | { readonly kind: "canonical"; readonly key: string }
  | { readonly kind: "legacy-email-hash"; readonly key: string }
  | { readonly kind: "legacy-opaque-scoped"; readonly key: string }
  | { readonly kind: "legacy-unscoped" };

export const resolveCodexHistoryIdentity = (input: {
  readonly accountId?: string;
  readonly email?: string;
}): CodexHistoryIdentity => {
  const accountId = normalizeScopedValue(input.accountId);
  if (accountId !== undefined) return { kind: "provider-account", id: accountId };
  const email = normalizeEmail(input.email);
  return email === undefined
    ? { kind: "unresolved" }
    : { kind: "email-only", normalizedEmail: email };
};

export const codexHistoryCanonicalKey = (identity: CodexHistoryIdentity): string | undefined => {
  switch (identity.kind) {
    case "provider-account": {
      const normalized = normalizeScopedValue(identity.id);
      return normalized === undefined ? undefined : `${PROVIDER_ACCOUNT_PREFIX}${normalized}`;
    }
    case "email-only": {
      const normalized = normalizeEmail(identity.normalizedEmail);
      return normalized === undefined ? undefined : codexHistoryCanonicalEmailHashKey(normalized);
    }
    case "unresolved":
      return undefined;
  }
};

export const codexHistoryCanonicalEmailHashKey = (email: string): string =>
  `${EMAIL_HASH_PREFIX}${codexHistoryLegacyEmailHash(email)}`;

export const codexHistoryLegacyEmailHash = (email: string): string => {
  const normalized = normalizeEmail(email);
  return normalized === undefined ? "" : sha256Hex(normalized);
};

export const classifyCodexHistoryPersistedKey = (
  rawKey: string | null | undefined,
  legacyEmailHash?: string,
): CodexHistoryPersistedOwner => {
  const normalized = normalizeScopedValue(rawKey);
  if (normalized === undefined) return { kind: "legacy-unscoped" };
  if (isCodexHistoryCanonicalKey(normalized)) return { kind: "canonical", key: normalized };
  if (legacyEmailHash !== undefined && normalized === legacyEmailHash)
    return { kind: "legacy-email-hash", key: normalized };
  return { kind: "legacy-opaque-scoped", key: normalized };
};

export const codexHistoryBelongsToTargetContinuity = (input: {
  readonly owner: CodexHistoryPersistedOwner;
  readonly targetCanonicalKey: string;
  readonly canonicalEmailHashKey?: string;
}): boolean => {
  switch (input.owner.kind) {
    case "canonical":
      if (input.owner.key === input.targetCanonicalKey) return true;
      return (
        input.canonicalEmailHashKey !== undefined &&
        isCodexHistoryCanonicalEmailHashKey(input.canonicalEmailHashKey) &&
        input.owner.key === input.canonicalEmailHashKey
      );
    case "legacy-email-hash":
      return (
        input.canonicalEmailHashKey !== undefined &&
        isCodexHistoryCanonicalEmailHashKey(input.canonicalEmailHashKey) &&
        (input.canonicalEmailHashKey === input.targetCanonicalKey ||
          input.targetCanonicalKey.startsWith(PROVIDER_ACCOUNT_PREFIX))
      );
    case "legacy-opaque-scoped":
    case "legacy-unscoped":
      return false;
  }
};

export const hasStrictSingleCodexHistoryContinuity = (input: {
  readonly scopedRawKeys: readonly string[];
  readonly targetCanonicalKey: string;
  readonly canonicalEmailHashKey?: string;
  readonly legacyEmailHash?: string;
  readonly hasAdjacentMultiAccountVeto: boolean;
}): boolean => {
  if (input.hasAdjacentMultiAccountVeto) return false;
  const candidates = new Set(
    input.scopedRawKeys.flatMap((rawKey) => {
      const owner = classifyCodexHistoryPersistedKey(rawKey, input.legacyEmailHash);
      if (
        codexHistoryBelongsToTargetContinuity({
          owner,
          targetCanonicalKey: input.targetCanonicalKey,
          ...(input.canonicalEmailHashKey === undefined
            ? {}
            : { canonicalEmailHashKey: input.canonicalEmailHashKey }),
        })
      )
        return [input.targetCanonicalKey];
      switch (owner.kind) {
        case "legacy-unscoped":
          return [];
        case "legacy-opaque-scoped":
          return [`legacy-opaque:${owner.key}`];
        case "legacy-email-hash":
          return [`legacy-email-hash:${owner.key}`];
        case "canonical":
          return [owner.key];
      }
    }),
  );
  return candidates.size === 1 && candidates.has(input.targetCanonicalKey);
};

export const isCodexHistoryCanonicalProviderAccountKey = (key: string): boolean =>
  key.startsWith(PROVIDER_ACCOUNT_PREFIX) && key.length > PROVIDER_ACCOUNT_PREFIX.length;

export const isCodexHistoryCanonicalEmailHashKey = (key: string): boolean =>
  key.startsWith(EMAIL_HASH_PREFIX) && key.length > EMAIL_HASH_PREFIX.length;

const isCodexHistoryCanonicalKey = (key: string): boolean =>
  isCodexHistoryCanonicalProviderAccountKey(key) || isCodexHistoryCanonicalEmailHashKey(key);

const normalizeEmail = (value: string | null | undefined): string | undefined => {
  const normalized = normalizeScopedValue(value)?.toLowerCase();
  return normalized === "" ? undefined : normalized;
};

const normalizeScopedValue = (value: string | null | undefined): string | undefined => {
  const normalized = value?.trim();
  return normalized === undefined || normalized === "" ? undefined : normalized;
};
