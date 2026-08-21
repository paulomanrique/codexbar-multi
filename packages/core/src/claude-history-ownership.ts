import type { UsageSnapshot } from "@codexbar/contracts";
import { sha256Hex } from "./sha256.ts";

const CLAUDE_OAUTH_PREFIX = "__claude_oauth__:";

export type ClaudePlan = "max" | "pro" | "team" | "enterprise" | "ultra";

export const claudePlanFromCompatibilityLoginMethod = (
  loginMethod: string | null | undefined,
): ClaudePlan | undefined => {
  const words = normalizedWords(loginMethod);
  if (words.length === 0) return undefined;
  if (words.includes("max")) return "max";
  if (words.includes("pro")) return "pro";
  if (words.includes("team")) return "team";
  if (words.includes("enterprise")) return "enterprise";
  if (words.includes("ultra")) return "ultra";
  return undefined;
};

export const claudeOAuthPlanUtilizationAccountKey = (
  historyOwnerIdentifier: string | null | undefined,
): string | undefined => {
  const normalized = historyOwnerIdentifier?.trim().toLowerCase();
  if (normalized === undefined || !/^[0-9a-f]{64}$/u.test(normalized)) return undefined;
  return `${CLAUDE_OAUTH_PREFIX}${sha256Hex(`claude:oauth-history-owner:v2:${normalized}`)}`;
};

export const isClaudeOAuthPlanUtilizationAccountKey = (
  accountKey: string | null | undefined,
): boolean => accountKey?.startsWith(CLAUDE_OAUTH_PREFIX) === true;

export const claudePlanUtilizationIdentityAccountKey = (
  snapshot: UsageSnapshot,
): string | undefined => {
  const identity = snapshot.identity;
  if (identity?.providerId !== "claude") return undefined;
  const normalizedEmail = normalizeLower(identity.accountEmail);
  if (normalizedEmail === undefined) return undefined;

  const normalizedOrganization = normalizeLower(identity.accountOrganization);
  const normalizedLoginMethod = normalizeLower(identity.loginMethod);
  const normalizedPlan = claudePlanFromCompatibilityLoginMethod(identity.loginMethod);
  const discriminator =
    normalizedOrganization === undefined
      ? normalizedPlan === undefined
        ? normalizedLoginMethod === undefined
          ? undefined
          : `plan:${normalizedLoginMethod}`
        : `plan:${normalizedPlan}`
      : `org:${normalizedOrganization}`;

  return discriminator === undefined
    ? claudePlanUtilizationLegacyEmailAccountKey(snapshot)
    : sha256Hex(`claude:email:${normalizedEmail}:${discriminator}`);
};

export const claudePlanUtilizationLegacyEmailAccountKey = (
  snapshot: UsageSnapshot,
): string | undefined => {
  const identity = snapshot.identity;
  if (identity?.providerId !== "claude") return undefined;
  const normalizedEmail = normalizeLower(identity.accountEmail);
  return normalizedEmail === undefined ? undefined : sha256Hex(`claude:email:${normalizedEmail}`);
};

const normalizeLower = (value: string | null | undefined): string | undefined => {
  const normalized = value?.trim().toLowerCase();
  return normalized === undefined || normalized === "" ? undefined : normalized;
};

const normalizedWords = (value: string | null | undefined): readonly string[] =>
  normalizeLower(value)
    ?.split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean) ?? [];
