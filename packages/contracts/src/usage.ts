import * as Schema from "effect/Schema";
import { ProviderInstanceId } from "./provider.ts";

const OptionalString = Schema.optional(Schema.String);
const OptionalNumber = Schema.optional(Schema.Number);
const OptionalBoolean = Schema.optional(Schema.Boolean);
const OptionalDate = Schema.optional(Schema.String);

export const RateWindow = Schema.Struct({
  usedPercent: Schema.Number,
  windowMinutes: Schema.optional(Schema.Number),
  resetsAt: OptionalDate,
  resetDescription: OptionalString,
  nextRegenPercent: OptionalNumber,
  isSyntheticPlaceholder: OptionalBoolean,
});
export type RateWindow = Schema.Schema.Type<typeof RateWindow>;

export const NamedRateWindow = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  window: RateWindow,
  usageKnown: OptionalBoolean,
});
export type NamedRateWindow = Schema.Schema.Type<typeof NamedRateWindow>;

export const ProviderIdentity = Schema.Struct({
  providerId: Schema.optional(ProviderInstanceId),
  accountEmail: OptionalString,
  accountOrganization: OptionalString,
  loginMethod: OptionalString,
  accountId: OptionalString,
});
export type ProviderIdentity = Schema.Schema.Type<typeof ProviderIdentity>;
export const ProviderIdentitySnapshot = ProviderIdentity;
export type ProviderIdentitySnapshot = ProviderIdentity;

export const ProviderCost = Schema.Struct({
  used: Schema.Number,
  limit: Schema.Number,
  currencyCode: Schema.String,
  period: OptionalString,
  resetsAt: OptionalDate,
  nextRegenAmount: OptionalNumber,
  personalUsed: OptionalNumber,
  balance: OptionalNumber,
  updatedAt: Schema.String,
});
export type ProviderCost = Schema.Schema.Type<typeof ProviderCost>;
export const ProviderCostSnapshot = ProviderCost;
export type ProviderCostSnapshot = ProviderCost;

export const DetailRow = Schema.Struct({
  label: Schema.String,
  value: Schema.String,
  secondaryValue: OptionalString,
});
export const DetailChartPoint = Schema.Struct({ label: Schema.String, value: Schema.Number });
export const DetailChart = Schema.Struct({
  kind: Schema.Literals(["bars", "line"]),
  title: OptionalString,
  unit: OptionalString,
  points: Schema.Array(DetailChartPoint),
});
export const ProviderDetailSection = Schema.Struct({
  title: OptionalString,
  rows: Schema.Array(DetailRow),
  chart: Schema.optional(DetailChart),
});
export type DetailRow = Schema.Schema.Type<typeof DetailRow>;
export type DetailChartPoint = Schema.Schema.Type<typeof DetailChartPoint>;
export type DetailChart = Schema.Schema.Type<typeof DetailChart>;
export type ProviderDetailSection = Schema.Schema.Type<typeof ProviderDetailSection>;

export const UsageDataConfidence = Schema.Literals([
  "exact",
  "estimated",
  "percentOnly",
  "unknown",
]);
export type UsageDataConfidence = Schema.Schema.Type<typeof UsageDataConfidence>;

/** Generic, provider-neutral usage payload. Provider-specific enrichments stay out of the core contract. */
export const UsageSnapshot = Schema.Struct({
  primary: Schema.optional(RateWindow),
  secondary: Schema.optional(RateWindow),
  tertiary: Schema.optional(RateWindow),
  extraRateWindows: Schema.optional(Schema.Array(NamedRateWindow)),
  providerCost: Schema.optional(ProviderCost),
  details: Schema.Array(ProviderDetailSection),
  subscriptionExpiresAt: OptionalDate,
  subscriptionRenewsAt: OptionalDate,
  updatedAt: Schema.String,
  identity: Schema.optional(ProviderIdentity),
  dataConfidence: Schema.optional(UsageDataConfidence),
});
export type UsageSnapshot = Schema.Schema.Type<typeof UsageSnapshot>;

export const Pace = Schema.Struct({
  stage: Schema.String,
  deltaPercent: Schema.Number,
  expectedUsedPercent: Schema.Number,
  willLastToReset: Schema.Boolean,
  etaSeconds: OptionalNumber,
  runOutProbability: OptionalNumber,
  summary: Schema.String,
});
export type Pace = Schema.Schema.Type<typeof Pace>;
