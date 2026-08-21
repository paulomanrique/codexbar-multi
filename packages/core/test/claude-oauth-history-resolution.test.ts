import { describe, expect, it } from "vite-plus/test";
import {
  claudeOAuthActiveAccountObservation,
  resolveClaudeOAuthHistoryOwner,
  stableClaudeKeychainPersistentRefHash,
  type ClaudeOAuthActiveAccountObservation,
  type ClaudeOAuthHistoryBindingState,
} from "../src/index.ts";

const observedAt = (seconds: number): Date => new Date(seconds * 1_000);
const accountIdentity = (value: string): string => `claude:${value}`;
const stable = (identity?: string): ClaudeOAuthActiveAccountObservation => ({
  kind: "stable",
  ...(identity === undefined ? {} : { identity }),
});
const state = (
  bindings: ClaudeOAuthHistoryBindingState["bindings"] = {},
  candidates: ClaudeOAuthHistoryBindingState["candidates"] = {},
): ClaudeOAuthHistoryBindingState => ({ bindings, candidates });

describe("Claude OAuth history owner resolution", () => {
  it("quarantines the first mismatched keychain sighting", () => {
    const result = resolveClaudeOAuthHistoryOwner(
      {
        owner: "s".repeat(64),
        keychainCredentialMismatch: true,
        keychainCredentialAbsent: false,
        keychainCredentialUnavailable: false,
        activeAccountObservation: stable(accountIdentity("current")),
        observedAt: observedAt(1_700_000_000),
      },
      state(),
    );
    expect(result.owner).toBeUndefined();
    expect(result.bindings).toEqual({});
    expect(result.candidates).toEqual({});
  });

  it("records file-backed owners when keychain comparison is unavailable or absent", () => {
    const unavailable = resolveClaudeOAuthHistoryOwner(
      {
        owner: "e".repeat(64),
        keychainCredentialMismatch: false,
        keychainCredentialAbsent: false,
        keychainCredentialUnavailable: true,
        activeAccountObservation: stable(accountIdentity("current")),
        observedAt: observedAt(1_700_000_000),
      },
      state(),
    );
    expect(unavailable.owner).toBe("e".repeat(64));
    expect(unavailable.bindings).toEqual({});

    const absent = resolveClaudeOAuthHistoryOwner(
      {
        owner: "b".repeat(64),
        keychainCredentialMismatch: false,
        keychainCredentialAbsent: true,
        keychainCredentialUnavailable: false,
        activeAccountObservation: stable(accountIdentity("current")),
        observedAt: observedAt(1_700_000_000),
      },
      state(),
    );
    expect(absent.owner).toBe("b".repeat(64));
    expect(absent.bindings).toEqual({});
  });

  it("quarantines bound owners that no longer match the active account", () => {
    const owner = "f".repeat(64);
    const result = resolveClaudeOAuthHistoryOwner(
      {
        owner,
        keychainCredentialMismatch: false,
        keychainCredentialAbsent: true,
        keychainCredentialUnavailable: false,
        activeAccountObservation: stable(accountIdentity("B")),
        observedAt: observedAt(1_700_000_000),
      },
      state({ [owner]: accountIdentity("A") }),
    );
    expect(result.owner).toBeUndefined();
    expect(result.bindings[owner]).toBe(accountIdentity("A"));
  });

  it("requires two stable exact-keychain observations before first binding becomes authoritative", () => {
    const owner = "a".repeat(64);
    const first = resolveClaudeOAuthHistoryOwner(
      {
        owner,
        persistentRefHash: "account-a-ref",
        keychainCredentialMismatch: false,
        keychainCredentialAbsent: false,
        keychainCredentialUnavailable: false,
        activeAccountObservation: stable(accountIdentity("A")),
        observedAt: observedAt(1_700_000_000),
      },
      state(),
    );
    expect(first.owner).toBe(owner);
    expect(first.bindings[owner]).toBeUndefined();
    expect(first.candidates[owner]).toMatchObject({ identity: accountIdentity("A") });

    const second = resolveClaudeOAuthHistoryOwner(
      {
        owner,
        persistentRefHash: "account-a-ref",
        keychainCredentialMismatch: false,
        keychainCredentialAbsent: false,
        keychainCredentialUnavailable: false,
        activeAccountObservation: stable(accountIdentity("A")),
        observedAt: observedAt(1_700_000_000 + 30 * 60),
      },
      first,
    );
    expect(second.owner).toBe(owner);
    expect(second.bindings[owner]).toBe(accountIdentity("A"));
    expect(second.candidates[owner]).toBeUndefined();
  });

  it("repairs a poisoned binding only after two exact-keychain confirmations", () => {
    const owner = "a".repeat(64);
    const initial = state({ [owner]: accountIdentity("A") });
    const first = resolveClaudeOAuthHistoryOwner(
      {
        owner,
        persistentRefHash: "account-b-ref",
        keychainCredentialMismatch: false,
        keychainCredentialAbsent: false,
        keychainCredentialUnavailable: false,
        activeAccountObservation: stable(accountIdentity("B")),
        observedAt: observedAt(1_700_000_000),
      },
      initial,
    );
    expect(first.owner).toBeUndefined();
    expect(first.bindings[owner]).toBe(accountIdentity("A"));
    expect(first.candidates[owner]).toMatchObject({ identity: accountIdentity("B") });

    const second = resolveClaudeOAuthHistoryOwner(
      {
        owner,
        persistentRefHash: "account-b-ref",
        keychainCredentialMismatch: false,
        keychainCredentialAbsent: false,
        keychainCredentialUnavailable: false,
        activeAccountObservation: stable(accountIdentity("B")),
        observedAt: observedAt(1_700_000_000 + 30 * 60),
      },
      first,
    );
    expect(second.owner).toBe(owner);
    expect(second.bindings[owner]).toBe(accountIdentity("B"));
    expect(second.candidates[owner]).toBeUndefined();
  });

  it("accepts established owners after access-token rotation when account identity is still stable", () => {
    const owner = "a".repeat(64);
    const result = resolveClaudeOAuthHistoryOwner(
      {
        owner,
        keychainCredentialMismatch: true,
        keychainCredentialAbsent: false,
        keychainCredentialUnavailable: false,
        activeAccountObservation: stable(accountIdentity("A")),
        observedAt: observedAt(1_700_000_000 + 2 * 60 * 60),
      },
      state({ [owner]: accountIdentity("A") }),
    );
    expect(result.owner).toBe(owner);
    expect(result.bindings[owner]).toBe(accountIdentity("A"));
  });

  it("preserves explicit OAuth owners that do not belong to Claude Code account lifecycle", () => {
    const owner = "d".repeat(64);
    const result = resolveClaudeOAuthHistoryOwner(
      {
        owner,
        keychainCredentialMismatch: false,
        keychainCredentialAbsent: false,
        keychainCredentialUnavailable: false,
        activeAccountObservation: { kind: "changed" },
        observedAt: observedAt(1_700_000_000),
      },
      state(),
    );
    expect(result.owner).toBe(owner);
    expect(result.bindings).toEqual({});
  });

  it("fails closed when the active account changed during identity capture", () => {
    const result = resolveClaudeOAuthHistoryOwner(
      {
        owner: "r".repeat(64),
        persistentRefHash: "account-a-ref",
        keychainCredentialMismatch: false,
        keychainCredentialAbsent: false,
        keychainCredentialUnavailable: false,
        activeAccountObservation: { kind: "changed" },
        observedAt: observedAt(1_700_000_000),
      },
      state(),
    );
    expect(result.owner).toBeUndefined();
    expect(result.bindings).toEqual({});
  });
});

describe("Claude OAuth auth-state stability", () => {
  it("requires full auth fingerprint stability before reusing a keychain persistent ref", () => {
    expect(
      stableClaudeKeychainPersistentRefHash(
        {
          fingerprintToken: "stable-fingerprint",
          keychainPersistentRefHash: "stable-ref",
          accountStateWasStable: true,
        },
        "stable-fingerprint",
        "stable-ref",
        true,
      ),
    ).toBe("stable-ref");
    expect(
      stableClaudeKeychainPersistentRefHash(
        {
          fingerprintToken: "before-fingerprint",
          keychainPersistentRefHash: "stable-ref",
          accountStateWasStable: true,
        },
        "after-fingerprint",
        "stable-ref",
        true,
      ),
    ).toBeUndefined();
  });

  it("invalidates active-account observations when either side is unstable or changed", () => {
    expect(
      claudeOAuthActiveAccountObservation(
        {
          fingerprintToken: "before",
          keychainPersistentRefHash: "before-ref",
          activeAccountIdentity: accountIdentity("B"),
          accountStateWasStable: true,
        },
        {
          fingerprintToken: "after",
          keychainPersistentRefHash: "after-ref",
          activeAccountIdentity: accountIdentity("B"),
          wasStable: true,
        },
      ),
    ).toEqual(stable(accountIdentity("B")));
    expect(
      claudeOAuthActiveAccountObservation(
        {
          fingerprintToken: "before",
          keychainPersistentRefHash: "before-ref",
          activeAccountIdentity: accountIdentity("A"),
          accountStateWasStable: true,
        },
        {
          fingerprintToken: "after",
          keychainPersistentRefHash: "after-ref",
          activeAccountIdentity: accountIdentity("B"),
          wasStable: true,
        },
      ),
    ).toEqual({ kind: "changed" });
    expect(
      claudeOAuthActiveAccountObservation(
        {
          fingerprintToken: "before",
          keychainPersistentRefHash: "before-ref",
          activeAccountIdentity: accountIdentity("B"),
          accountStateWasStable: false,
        },
        {
          fingerprintToken: "after",
          keychainPersistentRefHash: "after-ref",
          activeAccountIdentity: accountIdentity("B"),
          wasStable: true,
        },
      ),
    ).toEqual({ kind: "changed" });
  });
});
