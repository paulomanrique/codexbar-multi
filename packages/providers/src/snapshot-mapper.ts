import type { ProviderInstanceId, UsageSnapshot } from "@codexbar/contracts";

const MAXIMUM_STRING_BYTES = 256;
const MAXIMUM_EXTRA_WINDOWS = 64;
const MAXIMUM_DETAIL_SECTIONS = 16;
const MAXIMUM_DETAIL_ROWS = 64;
const MAXIMUM_CHART_POINTS = 128;

export class InvalidProviderSnapshot extends Error {
  readonly _tag = "InvalidProviderSnapshot";

  constructor(message: string) {
    super(message);
    this.name = "InvalidProviderSnapshot";
  }
}

type JsonObject = Record<string, unknown>;

const object = (value: unknown, path: string): JsonObject => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidProviderSnapshot(`${path} must be an object`);
  }
  return value as JsonObject;
};

const optionalObject = (value: unknown, path: string): JsonObject | undefined =>
  value == null ? undefined : object(value, path);

const finite = (value: unknown, path: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new InvalidProviderSnapshot(`${path} must be a finite number`);
  }
  return value;
};

const optionalFinite = (value: unknown, path: string): number | undefined =>
  value == null ? undefined : finite(value, path);

const optionalString = (value: unknown, path: string): string | undefined => {
  if (value == null) return undefined;
  if (typeof value !== "string") throw new InvalidProviderSnapshot(`${path} must be a string`);
  const trimmed = value.trim();
  if (new TextEncoder().encode(trimmed).byteLength > MAXIMUM_STRING_BYTES) {
    throw new InvalidProviderSnapshot(`${path} exceeds ${MAXIMUM_STRING_BYTES} UTF-8 bytes`);
  }
  return trimmed === "" ? undefined : trimmed;
};

const requiredString = (value: unknown, path: string): string => {
  const result = optionalString(value, path);
  if (result === undefined) throw new InvalidProviderSnapshot(`${path} is required`);
  return result;
};

const optionalDate = (value: unknown, path: string): string | undefined => {
  if (value == null) return undefined;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  const text = optionalString(value, path);
  if (text === undefined || !Number.isFinite(Date.parse(text))) {
    throw new InvalidProviderSnapshot(`${path} must be a valid ISO-8601 date`);
  }
  return new Date(text).toISOString();
};

function mapWindow(value: unknown, path: string) {
  const source = object(value, path);
  const rawPercent = finite(source.usedPercent, `${path}.usedPercent`);
  const windowMinutes = optionalFinite(source.windowMinutes, `${path}.windowMinutes`);
  if (windowMinutes !== undefined && (!Number.isSafeInteger(windowMinutes) || windowMinutes <= 0)) {
    throw new InvalidProviderSnapshot(`${path}.windowMinutes must be a positive integer`);
  }
  const nextRegenPercent = optionalFinite(source.nextRegenPercent, `${path}.nextRegenPercent`);
  return {
    usedPercent: Math.max(0, Math.min(100, rawPercent)),
    ...(windowMinutes === undefined ? {} : { windowMinutes }),
    ...(optionalDate(source.resetsAt, `${path}.resetsAt`) === undefined
      ? {}
      : { resetsAt: optionalDate(source.resetsAt, `${path}.resetsAt`) }),
    ...(optionalString(source.resetDescription, `${path}.resetDescription`) === undefined
      ? {}
      : {
          resetDescription: optionalString(source.resetDescription, `${path}.resetDescription`),
        }),
    ...(nextRegenPercent === undefined
      ? {}
      : { nextRegenPercent: Math.max(0, Math.min(100, nextRegenPercent)) }),
    ...(typeof source.isSyntheticPlaceholder === "boolean"
      ? { isSyntheticPlaceholder: source.isSyntheticPlaceholder }
      : {}),
  };
}

function mapExtraWindows(root: JsonObject) {
  const value = root.extraWindows ?? root.extraRateWindows;
  if (value == null) return undefined;
  if (!Array.isArray(value)) throw new InvalidProviderSnapshot("extraWindows must be an array");
  if (value.length > MAXIMUM_EXTRA_WINDOWS) {
    throw new InvalidProviderSnapshot(`extraWindows exceeds ${MAXIMUM_EXTRA_WINDOWS} entries`);
  }
  return value.map((entry, index) => {
    const path = `extraWindows[${index}]`;
    const item = object(entry, path);
    return {
      id: requiredString(item.id, `${path}.id`),
      title: requiredString(item.title, `${path}.title`),
      window: mapWindow(item.window ?? item, `${path}.window`),
      ...(typeof item.usageKnown === "boolean" ? { usageKnown: item.usageKnown } : {}),
    };
  });
}

function mapCost(root: JsonObject, updatedAt: string) {
  const source = optionalObject(root.cost ?? root.providerCost, "cost");
  if (source === undefined) return undefined;
  const currencyCode = requiredString(source.currency ?? source.currencyCode, "cost.currency");
  if (!/^[A-Z]{3}$/.test(currencyCode)) {
    throw new InvalidProviderSnapshot(
      "cost.currency must be a three-letter uppercase currency literal",
    );
  }
  const mapped = {
    used: finite(source.used, "cost.used"),
    limit: optionalFinite(source.limit, "cost.limit") ?? 0,
    currencyCode,
    ...(optionalString(source.period, "cost.period") === undefined
      ? {}
      : { period: optionalString(source.period, "cost.period") }),
    ...(optionalDate(source.resetsAt, "cost.resetsAt") === undefined
      ? {}
      : { resetsAt: optionalDate(source.resetsAt, "cost.resetsAt") }),
    ...(optionalFinite(source.nextRegenAmount, "cost.nextRegenAmount") === undefined
      ? {}
      : { nextRegenAmount: finite(source.nextRegenAmount, "cost.nextRegenAmount") }),
    ...(optionalFinite(source.personalUsed, "cost.personalUsed") === undefined
      ? {}
      : { personalUsed: finite(source.personalUsed, "cost.personalUsed") }),
    ...(optionalFinite(source.balance, "cost.balance") === undefined
      ? {}
      : { balance: finite(source.balance, "cost.balance") }),
    updatedAt,
  };
  return mapped;
}

function mapDetails(root: JsonObject) {
  if (root.details == null) return [];
  if (!Array.isArray(root.details)) throw new InvalidProviderSnapshot("details must be an array");
  if (root.details.length > MAXIMUM_DETAIL_SECTIONS) {
    throw new InvalidProviderSnapshot(`details exceeds ${MAXIMUM_DETAIL_SECTIONS} sections`);
  }
  return root.details.map((entry, sectionIndex) => {
    const path = `details[${sectionIndex}]`;
    const section = object(entry, path);
    if (!Array.isArray(section.rows)) {
      throw new InvalidProviderSnapshot(`${path}.rows must be an array`);
    }
    if (section.rows.length > MAXIMUM_DETAIL_ROWS) {
      throw new InvalidProviderSnapshot(`${path}.rows exceeds ${MAXIMUM_DETAIL_ROWS} entries`);
    }
    const rows = section.rows.map((entry, rowIndex) => {
      const rowPath = `${path}.rows[${rowIndex}]`;
      const row = object(entry, rowPath);
      return {
        label: requiredString(row.label, `${rowPath}.label`),
        value: requiredString(row.value, `${rowPath}.value`),
        ...(optionalString(row.secondaryValue, `${rowPath}.secondaryValue`) === undefined
          ? {}
          : {
              secondaryValue: optionalString(row.secondaryValue, `${rowPath}.secondaryValue`),
            }),
      };
    });
    const chartSource = optionalObject(section.chart, `${path}.chart`);
    const chart =
      chartSource === undefined
        ? undefined
        : (() => {
            const kind = requiredString(chartSource.kind, `${path}.chart.kind`);
            if (kind !== "bars" && kind !== "line") {
              throw new InvalidProviderSnapshot(`${path}.chart.kind must be 'bars' or 'line'`);
            }
            const chartKind: "bars" | "line" = kind;
            if (!Array.isArray(chartSource.points)) {
              throw new InvalidProviderSnapshot(`${path}.chart.points must be an array`);
            }
            if (chartSource.points.length > MAXIMUM_CHART_POINTS) {
              throw new InvalidProviderSnapshot(
                `${path}.chart.points exceeds ${MAXIMUM_CHART_POINTS} entries`,
              );
            }
            return {
              kind: chartKind,
              ...(optionalString(chartSource.title, `${path}.chart.title`) === undefined
                ? {}
                : { title: optionalString(chartSource.title, `${path}.chart.title`) }),
              ...(optionalString(chartSource.unit, `${path}.chart.unit`) === undefined
                ? {}
                : { unit: optionalString(chartSource.unit, `${path}.chart.unit`) }),
              points: chartSource.points.map((entry, pointIndex) => {
                const pointPath = `${path}.chart.points[${pointIndex}]`;
                const point = object(entry, pointPath);
                return {
                  label: requiredString(point.label, `${pointPath}.label`),
                  value: finite(point.value, `${pointPath}.value`),
                };
              }),
            };
          })();
    return {
      ...(optionalString(section.title, `${path}.title`) === undefined
        ? {}
        : { title: optionalString(section.title, `${path}.title`) }),
      rows,
      ...(chart === undefined ? {} : { chart }),
    };
  });
}

function mapIdentity(root: JsonObject, providerId: ProviderInstanceId) {
  const source = optionalObject(root.identity, "identity");
  if (source === undefined) return undefined;
  return {
    providerId,
    ...(optionalString(source.email ?? source.accountEmail, "identity.email") === undefined
      ? {}
      : {
          accountEmail: optionalString(source.email ?? source.accountEmail, "identity.email"),
        }),
    ...(optionalString(
      source.organization ?? source.accountOrganization,
      "identity.organization",
    ) === undefined
      ? {}
      : {
          accountOrganization: optionalString(
            source.organization ?? source.accountOrganization,
            "identity.organization",
          ),
        }),
    ...(optionalString(source.loginMethod, "identity.loginMethod") === undefined
      ? {}
      : { loginMethod: optionalString(source.loginMethod, "identity.loginMethod") }),
    ...(optionalString(source.accountID ?? source.accountId, "identity.accountID") === undefined
      ? {}
      : {
          accountId: optionalString(source.accountID ?? source.accountId, "identity.accountID"),
        }),
  };
}

/**
 * Maps the upstream first-party JS/plugin snapshot shape into the public DTO.
 * This is a direct TS port of the bounded portions of ProviderPluginSnapshotMapper.swift.
 */
export function mapProviderSnapshot(
  value: unknown,
  providerId: ProviderInstanceId,
  now: Date,
): UsageSnapshot {
  const root = object(value, "fetchUsage result");
  if (!Number.isFinite(now.getTime())) throw new InvalidProviderSnapshot("now must be valid");
  const updatedAt = now.toISOString();
  const primary = root.primary == null ? undefined : mapWindow(root.primary, "primary");
  const secondary = root.secondary == null ? undefined : mapWindow(root.secondary, "secondary");
  const tertiary = root.tertiary == null ? undefined : mapWindow(root.tertiary, "tertiary");
  const extraRateWindows = mapExtraWindows(root);
  const providerCost = mapCost(root, updatedAt);
  const details = mapDetails(root);
  const identity = mapIdentity(root, providerId);
  const dataConfidence = root.dataConfidence ?? "unknown";
  if (
    !(["exact", "estimated", "percentOnly", "unknown"] as const).includes(dataConfidence as never)
  ) {
    throw new InvalidProviderSnapshot("dataConfidence is invalid");
  }
  const hasIdentity =
    identity !== undefined &&
    (identity.accountEmail !== undefined ||
      identity.accountOrganization !== undefined ||
      identity.loginMethod !== undefined ||
      identity.accountId !== undefined);
  if (
    primary === undefined &&
    secondary === undefined &&
    tertiary === undefined &&
    (extraRateWindows === undefined || extraRateWindows.length === 0) &&
    providerCost === undefined &&
    details.length === 0 &&
    !hasIdentity
  ) {
    throw new InvalidProviderSnapshot(
      "snapshot must contain at least one rate window, cost, detail section, or identity field",
    );
  }
  return {
    ...(primary === undefined ? {} : { primary }),
    ...(secondary === undefined ? {} : { secondary }),
    ...(tertiary === undefined ? {} : { tertiary }),
    ...(extraRateWindows === undefined ? {} : { extraRateWindows }),
    ...(providerCost === undefined ? {} : { providerCost }),
    details,
    ...(optionalDate(root.subscriptionExpiresAt, "subscriptionExpiresAt") === undefined
      ? {}
      : {
          subscriptionExpiresAt: optionalDate(root.subscriptionExpiresAt, "subscriptionExpiresAt"),
        }),
    ...(optionalDate(root.subscriptionRenewsAt, "subscriptionRenewsAt") === undefined
      ? {}
      : {
          subscriptionRenewsAt: optionalDate(root.subscriptionRenewsAt, "subscriptionRenewsAt"),
        }),
    updatedAt,
    ...(identity === undefined ? {} : { identity }),
    dataConfidence: dataConfidence as UsageSnapshot["dataConfidence"],
  };
}
