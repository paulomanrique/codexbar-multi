/** Pure ownership policy for Codex web-dashboard data. */

export type CodexDashboardSourceKind = "liveWeb" | "cachedDashboard";
export type CodexDashboardDisposition = "attach" | "displayOnly" | "failClosed";

export type CodexDashboardAllowedEffect =
  | "usageBackfill"
  | "creditsAttachment"
  | "refreshGuardSeed"
  | "historicalBackfill"
  | "cachedDashboardReuse";

export type CodexDashboardCleanup =
  | "dashboardSnapshot"
  | "dashboardDerivedUsage"
  | "dashboardDerivedCredits"
  | "dashboardRefreshGuardSeed"
  | "dashboardCache";

export type CodexIdentity =
  | { readonly kind: "providerAccount"; readonly id: string }
  | { readonly kind: "emailOnly"; readonly normalizedEmail: string }
  | { readonly kind: "unresolved" };

export interface CodexDashboardKnownOwnerCandidate {
  readonly identity: CodexIdentity;
  readonly normalizedEmail?: string;
  readonly sourceIsolationIdentifier?: string;
}

export interface CodexDashboardOwnershipProofContext {
  readonly currentIdentity: CodexIdentity;
  readonly expectedScopedEmail?: string;
  readonly trustedCurrentUsageEmail?: string;
  readonly dashboardSignedInEmail?: string;
  readonly knownOwners: readonly CodexDashboardKnownOwnerCandidate[];
}

export interface CodexDashboardRoutingHints {
  readonly targetEmail?: string;
  readonly lastKnownDashboardRoutingEmail?: string;
}

export interface CodexDashboardAuthorityInput {
  readonly sourceKind: CodexDashboardSourceKind;
  readonly proof: CodexDashboardOwnershipProofContext;
  readonly routing: CodexDashboardRoutingHints;
}

export type CodexDashboardDecisionReason =
  | { readonly kind: "exactProviderAccountMatch" }
  | { readonly kind: "trustedEmailMatchNoCompetingOwner" }
  | { readonly kind: "trustedContinuityNoCompetingOwner" }
  | { readonly kind: "wrongEmail"; readonly expected?: string; readonly actual?: string }
  | { readonly kind: "sameEmailAmbiguity"; readonly email: string }
  | { readonly kind: "unresolvedWithoutTrustedEvidence" }
  | { readonly kind: "providerAccountMissingScopedEmail" }
  | { readonly kind: "providerAccountLacksExactOwnershipProof" }
  | { readonly kind: "missingDashboardSignedInEmail" };

export interface CodexDashboardAuthorityDecision {
  readonly disposition: CodexDashboardDisposition;
  readonly reason: CodexDashboardDecisionReason;
  readonly allowedEffects: ReadonlySet<CodexDashboardAllowedEffect>;
  readonly cleanup: ReadonlySet<CodexDashboardCleanup>;
}

export const normalizeCodexEmail = (value: string | undefined): string | undefined => {
  const normalized = value?.trim().toLowerCase();
  return normalized === undefined || normalized === "" ? undefined : normalized;
};

export const normalizeCodexAccountId = (value: string | undefined): string | undefined => {
  const normalized = value?.trim();
  return normalized === undefined || normalized === "" ? undefined : normalized;
};

export const resolveCodexIdentity = (
  accountId: string | undefined,
  email: string | undefined,
): CodexIdentity => {
  const normalizedID = normalizeCodexAccountId(accountId);
  if (normalizedID !== undefined) return { kind: "providerAccount", id: normalizedID };
  const normalizedEmail = normalizeCodexEmail(email);
  if (normalizedEmail !== undefined) return { kind: "emailOnly", normalizedEmail };
  return { kind: "unresolved" };
};

export const normalizeCodexIdentity = (identity: CodexIdentity): CodexIdentity => {
  if (identity.kind === "providerAccount") {
    const id = normalizeCodexAccountId(identity.id);
    return id === undefined ? { kind: "unresolved" } : { kind: "providerAccount", id };
  }
  if (identity.kind === "emailOnly") {
    const email = normalizeCodexEmail(identity.normalizedEmail);
    return email === undefined
      ? { kind: "unresolved" }
      : { kind: "emailOnly", normalizedEmail: email };
  }
  return { kind: "unresolved" };
};

const identityKey = (identity: CodexIdentity): string =>
  identity.kind === "providerAccount"
    ? `providerAccount:${identity.id}`
    : identity.kind === "emailOnly"
      ? `emailOnly:${identity.normalizedEmail}`
      : "unresolved";

export const normalizeCodexKnownOwners = (
  candidates: readonly CodexDashboardKnownOwnerCandidate[],
): ReadonlyArray<CodexDashboardKnownOwnerCandidate> => {
  const seen = new Set<string>();
  const result: CodexDashboardKnownOwnerCandidate[] = [];
  for (const candidate of candidates) {
    const identity = normalizeCodexIdentity(candidate.identity);
    const normalizedEmail = normalizeCodexEmail(candidate.normalizedEmail);
    const sourceIsolationIdentifier =
      identity.kind === "providerAccount" ? undefined : candidate.sourceIsolationIdentifier;
    // Swift's Set hash keeps nil distinct from an empty source identifier and
    // cannot collide on user-controlled separator characters. Preserve that
    // structural identity instead of concatenating fields into a flat string.
    const key = JSON.stringify([
      identityKey(identity),
      normalizedEmail ?? null,
      sourceIsolationIdentifier ?? null,
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      identity,
      ...(normalizedEmail === undefined ? {} : { normalizedEmail }),
      ...(sourceIsolationIdentifier === undefined ? {} : { sourceIsolationIdentifier }),
    });
  }
  return result;
};

const sameIdentity = (left: CodexIdentity, right: CodexIdentity): boolean =>
  left.kind === right.kind &&
  (left.kind === "providerAccount"
    ? right.kind === "providerAccount" && left.id === right.id
    : left.kind === "emailOnly"
      ? right.kind === "emailOnly" && left.normalizedEmail === right.normalizedEmail
      : true);

const allowedEffects = (
  disposition: CodexDashboardDisposition,
  sourceKind: CodexDashboardSourceKind,
): ReadonlySet<CodexDashboardAllowedEffect> => {
  if (disposition !== "attach") return new Set();
  return new Set(
    sourceKind === "liveWeb"
      ? ["usageBackfill", "creditsAttachment", "refreshGuardSeed", "historicalBackfill"]
      : ["cachedDashboardReuse"],
  );
};

const decision = (
  disposition: CodexDashboardDisposition,
  reason: CodexDashboardDecisionReason,
  sourceKind: CodexDashboardSourceKind,
): CodexDashboardAuthorityDecision => ({
  disposition,
  reason,
  allowedEffects: allowedEffects(disposition, sourceKind),
  cleanup:
    disposition === "attach"
      ? new Set()
      : new Set<CodexDashboardCleanup>([
          "dashboardSnapshot",
          "dashboardDerivedUsage",
          "dashboardDerivedCredits",
          "dashboardRefreshGuardSeed",
          "dashboardCache",
        ]),
});

export const evaluateCodexDashboardAuthority = (
  input: CodexDashboardAuthorityInput,
): CodexDashboardAuthorityDecision => {
  const proof = input.proof;
  const currentIdentity = normalizeCodexIdentity(proof.currentIdentity);
  const expectedScopedEmail = normalizeCodexEmail(proof.expectedScopedEmail);
  const trustedCurrentUsageEmail = normalizeCodexEmail(proof.trustedCurrentUsageEmail);
  const dashboardSignedInEmail = normalizeCodexEmail(proof.dashboardSignedInEmail);
  const knownOwners = normalizeCodexKnownOwners(proof.knownOwners);
  // Routing hints are deliberately excluded from ownership proof.
  if (dashboardSignedInEmail === undefined) {
    return decision("failClosed", { kind: "missingDashboardSignedInEmail" }, input.sourceKind);
  }
  if (expectedScopedEmail !== undefined && dashboardSignedInEmail !== expectedScopedEmail) {
    return decision(
      "failClosed",
      { kind: "wrongEmail", expected: expectedScopedEmail, actual: dashboardSignedInEmail },
      input.sourceKind,
    );
  }
  const ownerCount = (email: string): number =>
    knownOwners.filter((owner) => owner.normalizedEmail === email).length;
  if (currentIdentity.kind === "providerAccount") {
    if (expectedScopedEmail === undefined) {
      return decision(
        "failClosed",
        { kind: "providerAccountMissingScopedEmail" },
        input.sourceKind,
      );
    }
    if (ownerCount(dashboardSignedInEmail) > 1) {
      return decision(
        "displayOnly",
        { kind: "sameEmailAmbiguity", email: dashboardSignedInEmail },
        input.sourceKind,
      );
    }
    const exactMatch = knownOwners.some(
      (owner) =>
        sameIdentity(owner.identity, currentIdentity) &&
        owner.normalizedEmail === dashboardSignedInEmail,
    );
    return exactMatch
      ? decision("attach", { kind: "exactProviderAccountMatch" }, input.sourceKind)
      : decision(
          "failClosed",
          { kind: "providerAccountLacksExactOwnershipProof" },
          input.sourceKind,
        );
  }
  if (currentIdentity.kind === "emailOnly") {
    if (dashboardSignedInEmail !== currentIdentity.normalizedEmail) {
      return decision(
        "failClosed",
        {
          kind: "wrongEmail",
          expected: currentIdentity.normalizedEmail,
          actual: dashboardSignedInEmail,
        },
        input.sourceKind,
      );
    }
    return ownerCount(currentIdentity.normalizedEmail) > 1
      ? decision(
          "displayOnly",
          { kind: "sameEmailAmbiguity", email: currentIdentity.normalizedEmail },
          input.sourceKind,
        )
      : decision("attach", { kind: "trustedEmailMatchNoCompetingOwner" }, input.sourceKind);
  }
  if (trustedCurrentUsageEmail === undefined) {
    return decision("failClosed", { kind: "unresolvedWithoutTrustedEvidence" }, input.sourceKind);
  }
  if (dashboardSignedInEmail !== trustedCurrentUsageEmail) {
    return decision(
      "failClosed",
      { kind: "wrongEmail", expected: trustedCurrentUsageEmail, actual: dashboardSignedInEmail },
      input.sourceKind,
    );
  }
  return ownerCount(trustedCurrentUsageEmail) > 1
    ? decision(
        "displayOnly",
        { kind: "sameEmailAmbiguity", email: trustedCurrentUsageEmail },
        input.sourceKind,
      )
    : decision("attach", { kind: "trustedContinuityNoCompetingOwner" }, input.sourceKind);
};

export const attachmentEmail = (input: CodexDashboardAuthorityInput): string | undefined =>
  normalizeCodexEmail(
    input.proof.expectedScopedEmail ??
      input.proof.trustedCurrentUsageEmail ??
      input.proof.dashboardSignedInEmail,
  );

export const shouldTrustCodexUsageEmail = (sourceLabel: string): boolean =>
  ["codex-cli", "oauth"].includes(sourceLabel.trim().toLowerCase());

export const makeLiveCodexDashboardInput = (input: {
  readonly currentIdentity: CodexIdentity;
  readonly expectedScopedEmail?: string | undefined;
  readonly dashboardSignedInEmail?: string | undefined;
  readonly knownOwners: readonly CodexDashboardKnownOwnerCandidate[];
  readonly routingTargetEmail?: string | undefined;
}): CodexDashboardAuthorityInput => {
  const targetEmail = normalizeCodexEmail(input.routingTargetEmail);
  return {
    sourceKind: "liveWeb",
    proof: {
      currentIdentity: input.currentIdentity,
      ...(input.expectedScopedEmail === undefined
        ? {}
        : { expectedScopedEmail: input.expectedScopedEmail }),
      ...(input.dashboardSignedInEmail === undefined
        ? {}
        : { dashboardSignedInEmail: input.dashboardSignedInEmail }),
      knownOwners: input.knownOwners,
    },
    routing: targetEmail === undefined ? {} : { targetEmail },
  };
};

export const makeCachedCodexDashboardInput = (input: {
  readonly currentIdentity: CodexIdentity;
  readonly expectedScopedEmail?: string | undefined;
  readonly dashboardSignedInEmail?: string | undefined;
  readonly knownOwners: readonly CodexDashboardKnownOwnerCandidate[];
  readonly usageEmail?: string | undefined;
  readonly sourceLabel: string;
  readonly cachedDashboardEmail?: string | undefined;
}): CodexDashboardAuthorityInput => {
  const targetEmail = normalizeCodexEmail(input.expectedScopedEmail);
  const lastKnownDashboardRoutingEmail = normalizeCodexEmail(input.cachedDashboardEmail);
  return {
    sourceKind: "cachedDashboard",
    proof: {
      currentIdentity: input.currentIdentity,
      ...(input.expectedScopedEmail === undefined
        ? {}
        : { expectedScopedEmail: input.expectedScopedEmail }),
      ...(shouldTrustCodexUsageEmail(input.sourceLabel) && input.usageEmail !== undefined
        ? { trustedCurrentUsageEmail: input.usageEmail }
        : {}),
      ...(input.dashboardSignedInEmail === undefined
        ? {}
        : { dashboardSignedInEmail: input.dashboardSignedInEmail }),
      knownOwners: input.knownOwners,
    },
    routing: {
      ...(targetEmail === undefined ? {} : { targetEmail }),
      ...(lastKnownDashboardRoutingEmail === undefined ? {} : { lastKnownDashboardRoutingEmail }),
    },
  };
};
