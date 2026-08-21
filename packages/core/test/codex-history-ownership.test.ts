import { describe, expect, it } from "vite-plus/test";
import {
  classifyCodexHistoryPersistedKey,
  codexHistoryBelongsToTargetContinuity,
  codexHistoryCanonicalKey,
  codexHistoryLegacyEmailHash,
  hasStrictSingleCodexHistoryContinuity,
  resolveCodexHistoryIdentity,
  sha256Hex,
} from "../src/index.ts";

const email = "user@example.com";
const legacyEmailHash = "b4c9a289323b21a01c3e940f150eb9b8c542587f1abfd8f0e1cc1ffc5e475514";
const canonicalEmailHashKey = `codex:v1:email-hash:${legacyEmailHash}`;

describe("Codex history ownership", () => {
  it("matches Swift SHA-256 and canonical identity serialization", () => {
    expect(sha256Hex(email)).toBe(legacyEmailHash);
    expect(codexHistoryLegacyEmailHash(` ${email.toUpperCase()} `)).toBe(legacyEmailHash);
    expect(codexHistoryCanonicalKey({ kind: "provider-account", id: " acct-123 " })).toBe(
      "codex:v1:provider-account:acct-123",
    );
    expect(codexHistoryCanonicalKey({ kind: "email-only", normalizedEmail: email })).toBe(
      canonicalEmailHashKey,
    );
    expect(codexHistoryCanonicalKey({ kind: "unresolved" })).toBeUndefined();
  });

  it("resolves provider account before email and otherwise fails closed", () => {
    expect(resolveCodexHistoryIdentity({ accountId: " acct-123 ", email })).toEqual({
      kind: "provider-account",
      id: "acct-123",
    });
    expect(resolveCodexHistoryIdentity({ email: ` ${email.toUpperCase()} ` })).toEqual({
      kind: "email-only",
      normalizedEmail: email,
    });
    expect(resolveCodexHistoryIdentity({})).toEqual({ kind: "unresolved" });
  });

  it("classifies canonical, legacy, opaque, and unscoped persisted keys", () => {
    expect(classifyCodexHistoryPersistedKey(undefined)).toEqual({ kind: "legacy-unscoped" });
    expect(classifyCodexHistoryPersistedKey(" ")).toEqual({ kind: "legacy-unscoped" });
    expect(classifyCodexHistoryPersistedKey("codex:v1:provider-account:acct-123")).toEqual({
      kind: "canonical",
      key: "codex:v1:provider-account:acct-123",
    });
    expect(classifyCodexHistoryPersistedKey(legacyEmailHash, legacyEmailHash)).toEqual({
      kind: "legacy-email-hash",
      key: legacyEmailHash,
    });
    expect(classifyCodexHistoryPersistedKey("opaque", legacyEmailHash)).toEqual({
      kind: "legacy-opaque-scoped",
      key: "opaque",
    });
  });

  it("requires exactly one continuous owner and respects adjacent-account vetoes", () => {
    expect(
      hasStrictSingleCodexHistoryContinuity({
        scopedRawKeys: [legacyEmailHash],
        targetCanonicalKey: canonicalEmailHashKey,
        canonicalEmailHashKey,
        legacyEmailHash,
        hasAdjacentMultiAccountVeto: false,
      }),
    ).toBe(true);
    expect(
      hasStrictSingleCodexHistoryContinuity({
        scopedRawKeys: [canonicalEmailHashKey, "codex:v1:provider-account:acct-123"],
        targetCanonicalKey: canonicalEmailHashKey,
        canonicalEmailHashKey,
        legacyEmailHash,
        hasAdjacentMultiAccountVeto: false,
      }),
    ).toBe(false);
    expect(
      hasStrictSingleCodexHistoryContinuity({
        scopedRawKeys: [canonicalEmailHashKey],
        targetCanonicalKey: canonicalEmailHashKey,
        canonicalEmailHashKey,
        legacyEmailHash,
        hasAdjacentMultiAccountVeto: true,
      }),
    ).toBe(false);
  });

  it("lets a provider-account owner inherit its canonical and legacy email continuity", () => {
    const targetCanonicalKey = "codex:v1:provider-account:acct-123";
    expect(
      codexHistoryBelongsToTargetContinuity({
        owner: { kind: "legacy-email-hash", key: legacyEmailHash },
        targetCanonicalKey,
        canonicalEmailHashKey,
      }),
    ).toBe(true);
    expect(
      codexHistoryBelongsToTargetContinuity({
        owner: { kind: "canonical", key: canonicalEmailHashKey },
        targetCanonicalKey,
        canonicalEmailHashKey,
      }),
    ).toBe(true);
  });
});
