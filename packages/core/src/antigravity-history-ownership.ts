import type { UsageSnapshot } from "@codexbar/contracts";
import { sha256Hex } from "./sha256.ts";

/** Swift-compatible account ownership for Antigravity plan history. */
export const antigravityPlanUtilizationIdentityAccountKey = (
  snapshot: UsageSnapshot,
): string | undefined => {
  const identity = snapshot.identity;
  if (identity?.providerId !== "antigravity") return undefined;

  const email = normalizeLower(identity.accountEmail);
  if (email !== undefined) return sha256Hex(`antigravity:email:${email}`);

  const organization = normalizeLower(identity.accountOrganization);
  return organization === undefined
    ? undefined
    : sha256Hex(`antigravity:organization:${organization}`);
};

const normalizeLower = (value: string | null | undefined): string | undefined => {
  const normalized = value?.trim().toLowerCase();
  return normalized === undefined || normalized === "" ? undefined : normalized;
};
