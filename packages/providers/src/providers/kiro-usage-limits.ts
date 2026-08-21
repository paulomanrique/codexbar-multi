import type { ProviderContext } from "../types.ts";

const creditResource = "CREDIT";
const resetMinimumSeconds = 1_000_000_000;
const resetMaximumSeconds = 4_102_444_800;

export type KiroUsageLimits = {
  readonly planLimit: number;
  readonly planUsed: number;
  readonly overageUsed: number;
  readonly overageCap: number | undefined;
  readonly overageEnabled: boolean | undefined;
  readonly overageCharges: number | undefined;
  readonly overageRate: number | undefined;
  readonly currencyCode: string;
  readonly resetsAt: string;
  readonly hasUnseparatedBonus: boolean;
};

type JsonObject = Record<string, unknown>;

const object = (value: unknown): JsonObject | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;

const usableCredits = (value: unknown, field: string, ctx: ProviderContext): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw ctx.fail.parseFailure(`Kiro usage API has no usable ${field}.`);
  return value;
};

const optionalFinite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const resetAt = (value: unknown, ctx: ProviderContext): string => {
  const seconds = optionalFinite(value);
  if (seconds === undefined || seconds < resetMinimumSeconds || seconds > resetMaximumSeconds)
    throw ctx.fail.parseFailure("Kiro usage API reported no plausible reset date.");
  return ctx.date.unixSeconds(seconds);
};

const overageAvailability = (value: unknown): boolean | undefined => {
  if (typeof value !== "string") return undefined;
  if (value.toUpperCase() === "ENABLED") return true;
  if (value.toUpperCase() === "DISABLED") return false;
  return undefined;
};

export const overageChargeLimit = (limits: KiroUsageLimits): number | undefined =>
  limits.overageCap !== undefined &&
  limits.overageRate !== undefined &&
  limits.overageCap > 0 &&
  limits.overageRate > 0
    ? limits.overageCap * limits.overageRate
    : undefined;

/** Pure parser for the service response made by the official Kiro CLI. */
export const parseKiroUsageLimits = (value: unknown, ctx: ProviderContext): KiroUsageLimits => {
  const response = object(value);
  if (response === undefined || !Array.isArray(response.usageBreakdownList))
    throw ctx.fail.parseFailure("Kiro usage API response has no credit balance.");
  const credits = response.usageBreakdownList.filter(
    (entry) => object(entry)?.resourceType === creditResource,
  );
  if (credits.length !== 1)
    throw ctx.fail.parseFailure(
      credits.length === 0
        ? "Kiro usage API response has no credit balance."
        : "Kiro usage API response has several credit balances.",
    );
  const credit = object(credits[0]);
  if (credit === undefined)
    throw ctx.fail.parseFailure("Kiro usage API credit balance is invalid.");

  const planLimit = usableCredits(credit.usageLimitWithPrecision, "plan limit", ctx);
  const totalUsed = usableCredits(credit.currentUsageWithPrecision, "usage", ctx);
  const overageUsed = usableCredits(credit.currentOveragesWithPrecision ?? 0, "overage usage", ctx);
  if (overageUsed > totalUsed)
    throw ctx.fail.parseFailure("Kiro usage API overage exceeds total usage.");
  const planUsed = totalUsed - overageUsed;
  const hasUnseparatedBonus = Array.isArray(credit.bonuses) && credit.bonuses.length > 0;
  if (!hasUnseparatedBonus && planUsed > planLimit)
    throw ctx.fail.parseFailure("Kiro usage API plan usage exceeds its plan limit.");

  const configuration = object(response.overageConfiguration);
  const availability = overageAvailability(configuration?.overageStatus);
  const overageCap =
    availability === true && credit.overageCapWithPrecision !== undefined
      ? usableCredits(credit.overageCapWithPrecision, "overage cap", ctx)
      : undefined;
  // ENABLED without a cap is incomplete enrichment, not a disabled account.
  const overageEnabled =
    availability === true && overageCap === undefined ? undefined : availability;

  return {
    planLimit,
    planUsed,
    overageUsed,
    overageCap,
    overageEnabled,
    overageCharges: (() => {
      const charges = optionalFinite(credit.overageCharges);
      return charges !== undefined && charges >= 0 ? charges : undefined;
    })(),
    overageRate: (() => {
      const rate = optionalFinite(credit.overageRate);
      return rate !== undefined && rate > 0 ? rate : undefined;
    })(),
    currencyCode: typeof credit.currency === "string" ? credit.currency : "USD",
    resetsAt: resetAt(credit.nextDateReset ?? response.nextDateReset, ctx),
    hasUnseparatedBonus,
  };
};
