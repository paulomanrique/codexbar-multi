import type { UsageSnapshot } from "@codexbar/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  claudeOAuthPlanUtilizationAccountKey,
  claudePlanFromCompatibilityLoginMethod,
  claudePlanUtilizationIdentityAccountKey,
  claudePlanUtilizationLegacyEmailAccountKey,
  isClaudeOAuthPlanUtilizationAccountKey,
  sha256Hex,
  stableClaudeOAuthHistoryOwner,
} from "../src/index.ts";

const snapshot = (identity: NonNullable<UsageSnapshot["identity"]>): UsageSnapshot => ({
  details: [],
  updatedAt: "2026-08-21T12:00:00Z",
  identity,
});

describe("Claude history ownership", () => {
  it("matches Swift OAuth owner key normalization and validation", () => {
    const owner = "a".repeat(64);
    const first = claudeOAuthPlanUtilizationAccountKey(owner);
    const refreshed = claudeOAuthPlanUtilizationAccountKey(` ${owner.toUpperCase()} `);
    const switched = claudeOAuthPlanUtilizationAccountKey("b".repeat(64));

    expect(first).toBe(refreshed);
    expect(first).not.toBe(switched);
    expect(first).not.toBe(owner);
    expect(first?.startsWith("__claude_oauth__:")).toBe(true);
    expect(first?.slice("__claude_oauth__:".length)).toHaveLength(64);
    expect(isClaudeOAuthPlanUtilizationAccountKey(first)).toBe(true);
    expect(claudeOAuthPlanUtilizationAccountKey("not-hex")).toBeUndefined();
  });

  it("accepts only a stable owner around the winning Claude OAuth strategy", () => {
    const owner = "a".repeat(64);
    expect(stableClaudeOAuthHistoryOwner("claude.oauth", ` ${owner} `, owner)).toBe(owner);
    expect(stableClaudeOAuthHistoryOwner("claude.oauth", owner, "b".repeat(64))).toBeUndefined();
    expect(stableClaudeOAuthHistoryOwner("claude.oauth", owner, undefined)).toBeUndefined();
    expect(stableClaudeOAuthHistoryOwner("claude.cli", owner, owner)).toBeUndefined();
  });

  it("parses current compatibility plan labels", () => {
    expect(claudePlanFromCompatibilityLoginMethod("Claude Max")).toBe("max");
    expect(claudePlanFromCompatibilityLoginMethod("Max")).toBe("max");
    expect(claudePlanFromCompatibilityLoginMethod("Claude Pro")).toBe("pro");
    expect(claudePlanFromCompatibilityLoginMethod("Ultra")).toBe("ultra");
    expect(claudePlanFromCompatibilityLoginMethod("Claude Team")).toBe("team");
    expect(claudePlanFromCompatibilityLoginMethod("Claude Enterprise")).toBe("enterprise");
  });

  it("separates the same Claude email by organization or plan", () => {
    const team = snapshot({
      providerId: "claude",
      accountEmail: "person@example.com",
      accountOrganization: "Team Org",
      loginMethod: "Claude Team",
    });
    const max = snapshot({
      providerId: "claude",
      accountEmail: "person@example.com",
      loginMethod: "Claude Max",
    });

    expect(claudePlanUtilizationIdentityAccountKey(team)).toBe(
      sha256Hex("claude:email:person@example.com:org:team org"),
    );
    expect(claudePlanUtilizationIdentityAccountKey(max)).toBe(
      sha256Hex("claude:email:person@example.com:plan:max"),
    );
    expect(claudePlanUtilizationIdentityAccountKey(team)).not.toBe(
      claudePlanUtilizationIdentityAccountKey(max),
    );
  });

  it("keeps email-only identity on the legacy history key", () => {
    const input = snapshot({
      providerId: "claude",
      accountEmail: " Person@Example.com ",
    });
    expect(claudePlanUtilizationIdentityAccountKey(input)).toBe(
      claudePlanUtilizationLegacyEmailAccountKey(input),
    );
    expect(claudePlanUtilizationLegacyEmailAccountKey(input)).toBe(
      sha256Hex("claude:email:person@example.com"),
    );
  });

  it("maps compact and branded plan labels to the same key", () => {
    const compact = snapshot({
      providerId: "claude",
      accountEmail: "person@example.com",
      loginMethod: "Max",
    });
    const branded = snapshot({
      providerId: "claude",
      accountEmail: "person@example.com",
      loginMethod: "Claude Max",
    });

    expect(claudePlanUtilizationIdentityAccountKey(compact)).toBe(
      claudePlanUtilizationIdentityAccountKey(branded),
    );
  });

  it("fails closed for non-Claude or ownerless identity", () => {
    expect(
      claudePlanUtilizationIdentityAccountKey(
        snapshot({ providerId: "openai", accountEmail: "x" }),
      ),
    ).toBeUndefined();
    expect(
      claudePlanUtilizationIdentityAccountKey(snapshot({ providerId: "claude" })),
    ).toBeUndefined();
  });
});
