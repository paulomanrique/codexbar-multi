import * as Schema from "effect/Schema";
import { ProviderInstanceId } from "./provider.ts";

const OptionalString = Schema.optional(Schema.String);
const OptionalNumber = Schema.optional(Schema.Finite);
const OptionalBoolean = Schema.optional(Schema.Boolean);
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
export const ISODateString = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) =>
      ISO_DATE_PATTERN.test(value) && Number.isFinite(Date.parse(value))
        ? undefined
        : "must be an ISO-8601 timestamp",
    ),
  ),
);
const OptionalDate = Schema.optional(ISODateString);

export const RateWindow = Schema.Struct({
  usedPercent: Schema.Finite,
  windowMinutes: Schema.optional(Schema.Int),
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
  used: Schema.Finite,
  limit: Schema.Finite,
  currencyCode: Schema.String,
  period: OptionalString,
  resetsAt: OptionalDate,
  nextRegenAmount: OptionalNumber,
  personalUsed: OptionalNumber,
  balance: OptionalNumber,
  updatedAt: ISODateString,
});
export type ProviderCost = Schema.Schema.Type<typeof ProviderCost>;
export const ProviderCostSnapshot = ProviderCost;
export type ProviderCostSnapshot = ProviderCost;

const RequiredDetailString = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) return "must not be empty";
      return trimmed.length <= 120 ? undefined : "must not exceed 120 characters";
    }),
  ),
);
const OptionalDetailString = Schema.optional(
  Schema.String.pipe(
    Schema.check(
      Schema.makeFilter((value) =>
        value.trim().length <= 120 ? undefined : "must not exceed 120 characters",
      ),
    ),
  ),
);
export const DetailRow = Schema.Struct({
  label: RequiredDetailString,
  value: RequiredDetailString,
  secondaryValue: OptionalDetailString,
});
export const DetailChartPoint = Schema.Struct({
  label: RequiredDetailString,
  value: Schema.Finite,
});
export const DetailChart = Schema.Struct({
  kind: Schema.Literals(["bars", "line"]),
  title: OptionalDetailString,
  unit: OptionalDetailString,
  points: Schema.Array(DetailChartPoint).pipe(Schema.check(Schema.isMaxLength(120))),
});
export const ProviderDetailSection = Schema.Struct({
  title: OptionalDetailString,
  rows: Schema.Array(DetailRow).pipe(Schema.check(Schema.isMaxLength(24))),
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
  /**
   * These enrichments are intentionally opaque at the provider-neutral boundary. Swift persists
   * their Codable payloads under these exact keys, so dropping them while reading a cache would
   * make a TS round-trip destructive. Provider packages own their concrete schemas.
   */
  openAIAPIUsage: Schema.optional(Schema.Json),
  codexResetCredits: Schema.optional(Schema.Json),
  mistralUsage: Schema.optional(Schema.Json),
  details: Schema.Array(ProviderDetailSection).pipe(Schema.check(Schema.isMaxLength(8))),
  subscriptionExpiresAt: OptionalDate,
  subscriptionRenewsAt: OptionalDate,
  updatedAt: ISODateString,
  identity: Schema.optional(ProviderIdentity),
  dataConfidence: Schema.optional(UsageDataConfidence),
});
export type UsageSnapshot = Schema.Schema.Type<typeof UsageSnapshot>;
type JsonValue = Schema.Schema.Type<typeof Schema.Json>;

/** The wire shape emitted by Swift's custom `UsageSnapshot.encode(to:)`. */
export type UsageSnapshotJson = {
  readonly primary: RateWindow | null;
  readonly secondary: RateWindow | null;
  readonly tertiary: RateWindow | null;
  readonly extraRateWindows?: readonly NamedRateWindow[];
  readonly providerCost?: ProviderCost;
  readonly openAIAPIUsage?: JsonValue;
  readonly codexResetCredits?: JsonValue;
  readonly mistralUsage?: JsonValue;
  readonly details?: readonly ProviderDetailSection[];
  readonly subscriptionExpiresAt?: string;
  readonly subscriptionRenewsAt?: string;
  readonly updatedAt: string;
  readonly identity?: ProviderIdentityJson;
  readonly dataConfidence?: UsageDataConfidence;
  /** Legacy denormalized identity keys retained by Swift for compatibility. */
  readonly accountEmail?: string;
  readonly accountOrganization?: string;
  readonly loginMethod?: string;
};

export type ProviderIdentityJson = {
  readonly providerID?: ProviderInstanceId;
  readonly accountEmail?: string;
  readonly accountOrganization?: string;
  readonly loginMethod?: string;
  readonly accountID?: string;
};

type UsageSnapshotObject = Record<string, unknown>;

const isObject = (value: unknown): value is UsageSnapshotObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const omitNullish = <T extends UsageSnapshotObject>(value: T): T =>
  Object.fromEntries(
    Object.entries(value).filter(([, child]) => child !== undefined && child !== null),
  ) as T;

const omitUndefined = <T extends UsageSnapshotObject>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined)) as T;

const swiftISODate = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  // Foundation's ISO8601 encoder omits the fractional part for whole seconds.
  return new Date(timestamp).toISOString().replace(".000Z", "Z");
};

const decodeOptionalISODate = (value: unknown, path: string): string | undefined => {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${path} must be an ISO-8601 date`);
  }
  return swiftISODate(value);
};

const decodeRequiredISODate = (value: unknown, path: string): string => {
  const result = decodeOptionalISODate(value, path);
  if (result === undefined) throw new TypeError(`${path} is required`);
  return result;
};

const encodeRateWindow = (value: RateWindow): RateWindow => {
  const source = value as RateWindow & UsageSnapshotObject;
  return omitNullish({
    usedPercent: source.usedPercent,
    windowMinutes: source.windowMinutes,
    resetsAt: swiftISODate(source.resetsAt),
    resetDescription: source.resetDescription,
    nextRegenPercent: source.nextRegenPercent,
    ...(source.isSyntheticPlaceholder === true ? { isSyntheticPlaceholder: true } : {}),
  });
};

const encodeNamedRateWindow = (value: NamedRateWindow): NamedRateWindow => {
  const source = value as NamedRateWindow & UsageSnapshotObject;
  return omitNullish({
    id: source.id,
    title: source.title,
    window: encodeRateWindow(source.window),
    ...(source.usageKnown === false ? { usageKnown: false } : {}),
  });
};

const encodeProviderCost = (value: ProviderCost): ProviderCost => {
  const source = value as ProviderCost & UsageSnapshotObject;
  return omitNullish({
    used: source.used,
    limit: source.limit,
    currencyCode: source.currencyCode,
    period: source.period,
    resetsAt: swiftISODate(source.resetsAt),
    nextRegenAmount: source.nextRegenAmount,
    personalUsed: source.personalUsed,
    balance: source.balance,
    updatedAt: swiftISODate(source.updatedAt),
  }) as ProviderCost;
};

const normalizeRateWindowInput = (value: unknown): unknown => {
  if (value === null || value === undefined) return undefined;
  if (!isObject(value)) return value;
  return omitNullish({
    ...value,
    windowMinutes: value.windowMinutes,
    resetsAt: decodeOptionalISODate(value.resetsAt, "rateWindow.resetsAt"),
    resetDescription: value.resetDescription,
    nextRegenPercent: value.nextRegenPercent,
    isSyntheticPlaceholder: value.isSyntheticPlaceholder,
  });
};

const normalizeExtraWindowsInput = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map((entry) => {
        if (!isObject(entry)) return entry;
        return omitNullish({
          ...entry,
          window: normalizeRateWindowInput(entry.window),
          usageKnown: entry.usageKnown,
        });
      })
    : value;

const normalizeProviderCostInput = (value: unknown): unknown => {
  if (!isObject(value)) return value;
  return omitNullish({
    ...value,
    period: value.period,
    resetsAt: decodeOptionalISODate(value.resetsAt, "providerCost.resetsAt"),
    nextRegenAmount: value.nextRegenAmount,
    personalUsed: value.personalUsed,
    balance: value.balance,
  });
};

const normalizeDetailsInput = (value: unknown): unknown => {
  if (!Array.isArray(value)) return value;
  if (value.length > 8) throw new TypeError("snapshot.details exceeds 8 sections");
  const boundedRequired = (child: unknown, path: string): string => {
    if (typeof child !== "string") throw new TypeError(`${path} must be a string`);
    const trimmed = child.trim();
    if (trimmed.length === 0) throw new TypeError(`${path} must not be empty`);
    if (trimmed.length > 120) throw new TypeError(`${path} exceeds 120 characters`);
    return trimmed;
  };
  const boundedOptional = (child: unknown, path: string): string | undefined => {
    if (child === null || child === undefined) return undefined;
    if (typeof child !== "string") throw new TypeError(`${path} must be a string`);
    const trimmed = child.trim();
    if (trimmed.length > 120) throw new TypeError(`${path} exceeds 120 characters`);
    return trimmed.length === 0 ? undefined : trimmed;
  };
  return value.map((section) => {
    if (!isObject(section)) return section;
    if (!Array.isArray(section.rows)) throw new TypeError("detail section rows must be an array");
    if (section.rows.length > 24) throw new TypeError("detail section rows exceeds 24 entries");
    const chart = isObject(section.chart)
      ? omitNullish({
          ...section.chart,
          kind: section.chart.kind,
          title: boundedOptional(section.chart.title, "detail chart.title"),
          unit: boundedOptional(section.chart.unit, "detail chart.unit"),
          points: Array.isArray(section.chart.points)
            ? section.chart.points.map((point, index) => {
                if (!isObject(point))
                  throw new TypeError(`detail chart point ${index} must be an object`);
                if (typeof point.value !== "number" || !Number.isFinite(point.value)) {
                  throw new TypeError(`detail chart point ${index}.value must be finite`);
                }
                return {
                  label: boundedRequired(point.label, `detail chart point ${index}.label`),
                  value: point.value,
                };
              })
            : section.chart.points,
        })
      : section.chart;
    if (
      chart !== undefined &&
      (!isObject(chart) || (chart.kind !== "bars" && chart.kind !== "line"))
    ) {
      throw new TypeError("detail chart.kind must be bars or line");
    }
    if (isObject(chart) && Array.isArray(chart.points) && chart.points.length > 120) {
      throw new TypeError("detail chart.points exceeds 120 entries");
    }
    return omitNullish({
      ...section,
      title: boundedOptional(section.title, "detail section.title"),
      chart,
      rows: section.rows.map((row, index) => {
        if (!isObject(row)) throw new TypeError(`detail row ${index} must be an object`);
        return omitNullish({
          ...row,
          label: boundedRequired(row.label, `detail row ${index}.label`),
          value: boundedRequired(row.value, `detail row ${index}.value`),
          secondaryValue: boundedOptional(row.secondaryValue, `detail row ${index}.secondaryValue`),
        });
      }),
    });
  });
};

const encodeDetails = (
  details: readonly ProviderDetailSection[],
): readonly ProviderDetailSection[] =>
  details.map((section) => {
    const source = section as ProviderDetailSection & UsageSnapshotObject;
    return omitNullish({
      title: source.title,
      rows: source.rows.map((row) => {
        const rowSource = row as ProviderDetailSection["rows"][number] & UsageSnapshotObject;
        return omitNullish({
          label: rowSource.label,
          value: rowSource.value,
          secondaryValue: rowSource.secondaryValue,
        });
      }),
      chart:
        source.chart === undefined || source.chart === null
          ? undefined
          : omitNullish({
              kind: source.chart.kind,
              title: source.chart.title,
              unit: source.chart.unit,
              points: source.chart.points.map((point) =>
                omitNullish({ label: point.label, value: point.value }),
              ),
            }),
    });
  });

/**
 * Encodes a domain snapshot using the same omission/default rules as Swift's Codable model.
 * In particular, the three primary lanes are always present (`null` when absent), while nested
 * optionals and an unknown confidence are omitted. Do not replace this with `JSON.stringify` on
 * the DTO: that would silently change the persisted Swift wire format.
 */
export function encodeUsageSnapshot(snapshot: UsageSnapshot): UsageSnapshotJson {
  const source = snapshot as UsageSnapshot & UsageSnapshotObject;
  const identity = isObject(source.identity) ? source.identity : undefined;
  const identityRecord = identity as
    | (UsageSnapshotObject & {
        readonly providerID?: string;
        readonly providerId?: string;
        readonly accountEmail?: string;
        readonly accountOrganization?: string;
        readonly loginMethod?: string;
        readonly accountID?: string;
        readonly accountId?: string;
      })
    | undefined;
  const providerID = identityRecord?.providerID ?? identityRecord?.providerId;
  const encodedIdentity = identityRecord
    ? omitNullish({
        ...(providerID === undefined ? {} : { providerID }),
        accountEmail: identityRecord.accountEmail,
        accountOrganization: identityRecord.accountOrganization,
        loginMethod: identityRecord.loginMethod,
        accountID: identityRecord.accountID ?? identityRecord.accountId,
      })
    : undefined;
  return omitUndefined({
    primary: source.primary == null ? null : encodeRateWindow(source.primary),
    secondary: source.secondary == null ? null : encodeRateWindow(source.secondary),
    tertiary: source.tertiary == null ? null : encodeRateWindow(source.tertiary),
    extraRateWindows:
      source.extraRateWindows === undefined
        ? undefined
        : source.extraRateWindows.map(encodeNamedRateWindow),
    providerCost:
      source.providerCost === undefined ? undefined : encodeProviderCost(source.providerCost),
    openAIAPIUsage: source.openAIAPIUsage,
    codexResetCredits: source.codexResetCredits,
    mistralUsage: source.mistralUsage,
    details: source.details.length === 0 ? undefined : encodeDetails(source.details),
    subscriptionExpiresAt: swiftISODate(source.subscriptionExpiresAt),
    subscriptionRenewsAt: swiftISODate(source.subscriptionRenewsAt),
    updatedAt: swiftISODate(source.updatedAt) ?? source.updatedAt,
    identity: encodedIdentity,
    ...(source.dataConfidence !== undefined && source.dataConfidence !== "unknown"
      ? { dataConfidence: source.dataConfidence }
      : {}),
    accountEmail: identityRecord?.accountEmail,
    accountOrganization: identityRecord?.accountOrganization,
    loginMethod: identityRecord?.loginMethod,
  }) as UsageSnapshotJson;
}

/**
 * Decodes Swift/current and legacy snapshot payloads into the shared TS domain shape. Swift's
 * `decodeIfPresent` treats both a missing key and `null` as absent; the normalizer mirrors that
 * behavior before handing the value to Effect Schema.
 */
export function decodeUsageSnapshot(input: unknown): UsageSnapshot {
  if (!isObject(input)) throw new TypeError("UsageSnapshot must be a JSON object");
  const identitySource = isObject(input.identity) ? input.identity : undefined;
  const legacyIdentity =
    input.accountEmail !== undefined ||
    input.accountOrganization !== undefined ||
    input.loginMethod !== undefined;
  const identity = identitySource
    ? omitNullish({
        providerId: identitySource.providerId ?? identitySource.providerID,
        accountEmail: identitySource.accountEmail,
        accountOrganization: identitySource.accountOrganization,
        loginMethod: identitySource.loginMethod,
        accountId: identitySource.accountId ?? identitySource.accountID,
      })
    : legacyIdentity
      ? omitNullish({
          accountEmail: input.accountEmail,
          accountOrganization: input.accountOrganization,
          loginMethod: input.loginMethod,
        })
      : undefined;
  const normalized = {
    ...input,
    primary: normalizeRateWindowInput(input.primary),
    secondary: normalizeRateWindowInput(input.secondary),
    tertiary: normalizeRateWindowInput(input.tertiary),
    extraRateWindows: normalizeExtraWindowsInput(input.extraRateWindows),
    providerCost: normalizeProviderCostInput(input.providerCost),
    openAIAPIUsage: input.openAIAPIUsage ?? undefined,
    codexResetCredits: input.codexResetCredits ?? undefined,
    mistralUsage: input.mistralUsage ?? undefined,
    details: normalizeDetailsInput(input.details) ?? [],
    subscriptionExpiresAt: decodeOptionalISODate(
      input.subscriptionExpiresAt,
      "subscriptionExpiresAt",
    ),
    subscriptionRenewsAt: decodeOptionalISODate(input.subscriptionRenewsAt, "subscriptionRenewsAt"),
    updatedAt: decodeRequiredISODate(input.updatedAt, "updatedAt"),
    identity,
    dataConfidence:
      input.dataConfidence === "exact" ||
      input.dataConfidence === "estimated" ||
      input.dataConfidence === "percentOnly"
        ? input.dataConfidence
        : undefined,
  };
  return Schema.decodeUnknownSync(UsageSnapshot)(normalized);
}

export const serializeUsageSnapshot = encodeUsageSnapshot;
export const deserializeUsageSnapshot = decodeUsageSnapshot;

export const Pace = Schema.Struct({
  stage: Schema.Literals([
    "onTrack",
    "slightlyAhead",
    "ahead",
    "farAhead",
    "slightlyBehind",
    "behind",
    "farBehind",
  ]),
  deltaPercent: Schema.Number,
  expectedUsedPercent: Schema.Number,
  actualUsedPercent: Schema.Number,
  willLastToReset: Schema.Boolean,
  etaSeconds: OptionalNumber,
  runOutProbability: OptionalNumber,
  speedMultiplierToReset: OptionalNumber,
});
export type Pace = Schema.Schema.Type<typeof Pace>;
