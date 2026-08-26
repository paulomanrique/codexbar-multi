import { describe, expect, it } from "vite-plus/test";
import {
  attachmentEmail,
  evaluateCodexDashboardAuthority,
  makeCachedCodexDashboardInput,
  makeLiveCodexDashboardInput,
  normalizeCodexKnownOwners,
  resolveCodexIdentity,
  shouldTrustCodexUsageEmail,
  type CodexDashboardAuthorityInput,
  type CodexDashboardKnownOwnerCandidate,
  type CodexIdentity,
} from "../src/providers/codex-dashboard-authority.ts";

const providerIdentity = (id = "acct-1"): CodexIdentity => ({ kind: "providerAccount", id });
const owner = (
  identity: CodexIdentity,
  email = "user@example.com",
  sourceIsolationIdentifier?: string,
): CodexDashboardKnownOwnerCandidate => ({
  identity,
  normalizedEmail: email,
  ...(sourceIsolationIdentifier === undefined ? {} : { sourceIsolationIdentifier }),
});

const live = (
  proof: Partial<Parameters<typeof makeLiveCodexDashboardInput>[0]> = {},
): CodexDashboardAuthorityInput =>
  makeLiveCodexDashboardInput({
    currentIdentity: providerIdentity(),
    expectedScopedEmail: "USER@example.com",
    dashboardSignedInEmail: "user@example.com",
    knownOwners: [owner(providerIdentity())],
    routingTargetEmail: "routing@example.com",
    ...proof,
  });

describe("Codex dashboard authority", () => {
  it.each([
    ["attach", "exactProviderAccountMatch", live(), "liveWeb"],
    [
      "attach",
      "trustedEmailMatchNoCompetingOwner",
      live({ currentIdentity: { kind: "emailOnly", normalizedEmail: "USER@example.com" } }),
      "liveWeb",
    ],
    [
      "attach",
      "trustedContinuityNoCompetingOwner",
      makeCachedCodexDashboardInput({
        currentIdentity: { kind: "unresolved" },
        dashboardSignedInEmail: "user@example.com",
        usageEmail: "USER@example.com",
        sourceLabel: "oauth",
        knownOwners: [],
      }),
      "cachedDashboard",
    ],
  ] as const)("accepts %s/%s", (disposition, reason, input, sourceKind) => {
    const result = evaluateCodexDashboardAuthority(input);
    expect(result.disposition).toBe(disposition);
    expect(result.reason.kind).toBe(reason);
    expect(input.sourceKind).toBe(sourceKind);
  });

  it.each([
    ["missingDashboardSignedInEmail", live({ dashboardSignedInEmail: undefined })],
    ["providerAccountMissingScopedEmail", live({ expectedScopedEmail: undefined })],
    [
      "providerAccountLacksExactOwnershipProof",
      live({ knownOwners: [owner(providerIdentity("other"))] }),
    ],
    ["wrongEmail", live({ dashboardSignedInEmail: "other@example.com" })],
    [
      "unresolvedWithoutTrustedEvidence",
      makeLiveCodexDashboardInput({
        currentIdentity: { kind: "unresolved" },
        dashboardSignedInEmail: "user@example.com",
        knownOwners: [],
      }),
    ],
  ] as const)("fails closed for %s", (reason, input) => {
    const result = evaluateCodexDashboardAuthority(input);
    expect(result.disposition).toBe("failClosed");
    expect(result.reason.kind).toBe(reason);
    expect(result.allowedEffects).toEqual(new Set());
    expect(result.cleanup.size).toBe(5);
  });

  it("uses display-only for ambiguous email owners", () => {
    const result = evaluateCodexDashboardAuthority(
      live({
        knownOwners: [owner(providerIdentity("one")), owner(providerIdentity("two"))],
      }),
    );
    expect(result).toMatchObject({
      disposition: "displayOnly",
      reason: { kind: "sameEmailAmbiguity", email: "user@example.com" },
    });
    expect(result.allowedEffects).toEqual(new Set());
  });

  it("assigns source-specific effects only on attach", () => {
    const liveResult = evaluateCodexDashboardAuthority(live());
    expect(liveResult.allowedEffects).toEqual(
      new Set(["usageBackfill", "creditsAttachment", "refreshGuardSeed", "historicalBackfill"]),
    );
    const cachedResult = evaluateCodexDashboardAuthority(
      makeCachedCodexDashboardInput({
        currentIdentity: providerIdentity(),
        expectedScopedEmail: "user@example.com",
        dashboardSignedInEmail: "user@example.com",
        knownOwners: [owner(providerIdentity())],
        sourceLabel: "oauth",
        usageEmail: "user@example.com",
      }),
    );
    expect(cachedResult.allowedEffects).toEqual(new Set(["cachedDashboardReuse"]));
  });

  it("normalizes identities and deduplicates owners without cross-source merging", () => {
    expect(resolveCodexIdentity("  acct-1 ", "USER@example.com")).toEqual({
      kind: "providerAccount",
      id: "acct-1",
    });
    expect(
      normalizeCodexKnownOwners([
        owner(
          { kind: "emailOnly", normalizedEmail: "USER@example.com" },
          "USER@example.com",
          "one",
        ),
        owner(
          { kind: "emailOnly", normalizedEmail: " user@example.com " },
          " user@example.com ",
          "one",
        ),
        owner(
          { kind: "emailOnly", normalizedEmail: "user@example.com" },
          "user@example.com",
          "two",
        ),
        owner({ kind: "providerAccount", id: " acct-1 " }, "USER@example.com", "ignored"),
      ]),
    ).toEqual([
      {
        identity: { kind: "emailOnly", normalizedEmail: "user@example.com" },
        normalizedEmail: "user@example.com",
        sourceIsolationIdentifier: "one",
      },
      {
        identity: { kind: "emailOnly", normalizedEmail: "user@example.com" },
        normalizedEmail: "user@example.com",
        sourceIsolationIdentifier: "two",
      },
      {
        identity: { kind: "providerAccount", id: "acct-1" },
        normalizedEmail: "user@example.com",
        sourceIsolationIdentifier: undefined,
      },
    ]);
  });

  it("keeps absent, empty and separator-bearing source identities structurally distinct", () => {
    const identity = { kind: "emailOnly", normalizedEmail: "shared@example.com" } as const;
    const owners = normalizeCodexKnownOwners([
      owner(identity, "shared@example.com"),
      owner(identity, "shared@example.com", ""),
      owner(identity, "shared@example.com", "source|one"),
      owner(identity, "shared@example.com", "source|one"),
    ]);
    expect(owners).toHaveLength(3);
    expect(
      evaluateCodexDashboardAuthority(
        live({
          currentIdentity: identity,
          expectedScopedEmail: "shared@example.com",
          dashboardSignedInEmail: "shared@example.com",
          knownOwners: owners,
        }),
      ),
    ).toMatchObject({
      disposition: "displayOnly",
      reason: { kind: "sameEmailAmbiguity", email: "shared@example.com" },
    });
  });

  it("keeps routing hints out of authority and derives attachment email", () => {
    const first = evaluateCodexDashboardAuthority(
      live({ routingTargetEmail: "wrong@example.com" }),
    );
    const second = evaluateCodexDashboardAuthority(
      live({ routingTargetEmail: "user@example.com" }),
    );
    expect(first).toEqual(second);
    expect(attachmentEmail(live())).toBe("user@example.com");
  });

  it.each([
    ["codex-cli", true],
    [" OAuth ", true],
    ["codex-web", false],
    ["", false],
  ] as const)("trusts usage email for %s: %s", (label, expected) => {
    expect(shouldTrustCodexUsageEmail(label)).toBe(expected);
  });
});
