import * as Schema from "effect/Schema";
import { ProviderId, ProviderInstanceId, ProviderSourceMode, ProviderStatus } from "./provider.ts";
import { ProviderError } from "./errors.ts";
import { ISODateString, ProviderCost, ProviderIdentity, UsageSnapshot } from "./usage.ts";

export const ProviderPayload = Schema.Struct({
  provider: ProviderInstanceId,
  account: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
  source: ProviderSourceMode,
  status: Schema.optional(ProviderStatus),
  usage: Schema.optional(UsageSnapshot),
  error: Schema.optional(ProviderError),
});
export type ProviderPayload = Schema.Schema.Type<typeof ProviderPayload>;
export const ProviderUsageDTO = ProviderPayload;
export type ProviderUsageDTO = ProviderPayload;

export const DashboardWindowDTO = Schema.Struct({
  kind: Schema.String,
  label: Schema.String,
  usedPercent: Schema.Finite,
  remainingPercent: Schema.Finite,
  resetAt: Schema.optional(ISODateString),
});
export type DashboardWindowDTO = Schema.Schema.Type<typeof DashboardWindowDTO>;

export const DashboardProviderDTO = Schema.Struct({
  id: ProviderInstanceId,
  name: Schema.String,
  /** User/config enablement; independent from migration implementation state. */
  enabled: Schema.Boolean,
  implementationStatus: Schema.Literals(["partial", "unported"]),
  source: ProviderSourceMode,
  status: Schema.optional(ProviderStatus),
  identity: Schema.optional(ProviderIdentity),
  windows: Schema.Array(DashboardWindowDTO),
  cost: Schema.optional(ProviderCost),
  error: Schema.optional(ProviderError),
  updatedAt: Schema.optional(ISODateString),
});
export type DashboardProviderDTO = Schema.Schema.Type<typeof DashboardProviderDTO>;

export const DashboardSnapshotDTO = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  generatedAt: ISODateString,
  staleAfterSeconds: Schema.Natural,
  providers: Schema.Array(DashboardProviderDTO),
});
export type DashboardSnapshotDTO = Schema.Schema.Type<typeof DashboardSnapshotDTO>;

const TimestampMilliseconds = Schema.Natural;
const QueryLimit = Schema.Natural.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(10_000)),
);

/** A bounded, provider-scoped history query. Export stays renderer-local; it never writes a file. */
export const HistoryQueryDTO = Schema.Struct({
  provider: ProviderId,
  since: Schema.optional(TimestampMilliseconds),
  limit: Schema.optional(QueryLimit),
});
export type HistoryQueryDTO = Schema.Schema.Type<typeof HistoryQueryDTO>;

export const HistoryRecordDTO = Schema.Struct({
  providerId: ProviderId,
  recordedAt: TimestampMilliseconds,
  snapshot: UsageSnapshot,
});
export type HistoryRecordDTO = Schema.Schema.Type<typeof HistoryRecordDTO>;

export const HistoryQueryResultDTO = Schema.Struct({
  records: Schema.Array(HistoryRecordDTO).pipe(Schema.check(Schema.isMaxLength(10_000))),
  truncated: Schema.Boolean,
});
export type HistoryQueryResultDTO = Schema.Schema.Type<typeof HistoryQueryResultDTO>;

export const HistoryExportDTO = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  exportedAt: ISODateString,
  records: Schema.Array(HistoryRecordDTO).pipe(Schema.check(Schema.isMaxLength(10_000))),
  truncated: Schema.Boolean,
});
export type HistoryExportDTO = Schema.Schema.Type<typeof HistoryExportDTO>;

export const CostUsageRecordDTO = Schema.Struct({
  providerId: ProviderId,
  recordedAt: TimestampMilliseconds,
  inputTokens: Schema.Natural,
  outputTokens: Schema.Natural,
  costUsd: Schema.Finite.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type CostUsageRecordDTO = Schema.Schema.Type<typeof CostUsageRecordDTO>;

export const CostUsageQueryDTO = Schema.Struct({
  provider: ProviderId,
  since: Schema.optional(TimestampMilliseconds),
  limit: Schema.optional(QueryLimit),
});
export type CostUsageQueryDTO = Schema.Schema.Type<typeof CostUsageQueryDTO>;

export const CostUsageQueryResultDTO = Schema.Struct({
  records: Schema.Array(CostUsageRecordDTO).pipe(Schema.check(Schema.isMaxLength(10_000))),
  truncated: Schema.Boolean,
});
export type CostUsageQueryResultDTO = Schema.Schema.Type<typeof CostUsageQueryResultDTO>;

export const CostUsageExportDTO = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  exportedAt: ISODateString,
  records: Schema.Array(CostUsageRecordDTO).pipe(Schema.check(Schema.isMaxLength(10_000))),
  truncated: Schema.Boolean,
});
export type CostUsageExportDTO = Schema.Schema.Type<typeof CostUsageExportDTO>;

export const LoginRequestDTO = Schema.Struct({
  provider: ProviderId,
  accountId: Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/))),
});
export type LoginRequestDTO = Schema.Schema.Type<typeof LoginRequestDTO>;

export const LoginResultDTO = Schema.Struct({
  provider: ProviderId,
  accountId: Schema.String,
  status: Schema.Literals(["connected", "cancelled"]),
});
export type LoginResultDTO = Schema.Schema.Type<typeof LoginResultDTO>;

/** Explicit, provider-scoped refresh request. The renderer cannot supply endpoints, headers, or secrets. */
export const RefreshProviderRequestDTO = Schema.Struct({
  provider: ProviderId,
  source: Schema.optional(ProviderSourceMode),
});
export type RefreshProviderRequestDTO = Schema.Schema.Type<typeof RefreshProviderRequestDTO>;

export const RefreshProviderResultDTO = Schema.Struct({
  provider: ProviderId,
  strategyId: Schema.String,
  source: Schema.Literals(["cli", "web", "oauth", "api-token", "local-probe", "web-dashboard"]),
  snapshot: UsageSnapshot,
});
export type RefreshProviderResultDTO = Schema.Schema.Type<typeof RefreshProviderResultDTO>;

/**
 * The deliberately small settings projection available to the desktop UI.
 * It is first-party only and intentionally omits every provider extension,
 * secret, cookie, endpoint and plugin value from the renderer boundary.
 */
export const ProviderSettingsDTO = Schema.Struct({
  provider: ProviderId,
  enabled: Schema.Boolean,
  source: ProviderSourceMode,
  /** `auto` plus the single runtime-backed explicit mode for this provider. */
  availableSources: Schema.Array(ProviderSourceMode).pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(2)),
  ),
});
export type ProviderSettingsDTO = Schema.Schema.Type<typeof ProviderSettingsDTO>;

export const ProviderSettingsListDTO = Schema.Struct({
  providers: Schema.Array(ProviderSettingsDTO).pipe(Schema.check(Schema.isMaxLength(69))),
});
export type ProviderSettingsListDTO = Schema.Schema.Type<typeof ProviderSettingsListDTO>;

/** A complete replacement prevents an ambiguous partial write in the renderer. */
export const UpdateProviderSettingsRequestDTO = Schema.Struct({
  provider: ProviderId,
  enabled: Schema.Boolean,
  source: ProviderSourceMode,
});
export type UpdateProviderSettingsRequestDTO = Schema.Schema.Type<
  typeof UpdateProviderSettingsRequestDTO
>;

export const IPCRequest = Schema.Union([
  Schema.Struct({ type: Schema.Literal("get-usage"), provider: Schema.optional(ProviderId) }),
  Schema.Struct({ type: Schema.Literal("refresh-provider"), request: RefreshProviderRequestDTO }),
  Schema.Struct({ type: Schema.Literal("get-history"), query: HistoryQueryDTO }),
  Schema.Struct({ type: Schema.Literal("export-history"), query: HistoryQueryDTO }),
  Schema.Struct({ type: Schema.Literal("get-costs"), query: CostUsageQueryDTO }),
  Schema.Struct({ type: Schema.Literal("export-costs"), query: CostUsageQueryDTO }),
  Schema.Struct({ type: Schema.Literal("get-config") }),
  Schema.Struct({ type: Schema.Literal("get-provider-settings") }),
  Schema.Struct({
    type: Schema.Literal("set-provider-enabled"),
    provider: ProviderInstanceId,
    enabled: Schema.Boolean,
  }),
  Schema.Struct({ type: Schema.Literal("start-login"), request: LoginRequestDTO }),
  Schema.Struct({ type: Schema.Literal("cancel-login"), request: LoginRequestDTO }),
  Schema.Struct({ type: Schema.Literal("logout"), request: LoginRequestDTO }),
]);
export type IPCRequest = Schema.Schema.Type<typeof IPCRequest>;

export const IPCResponse = Schema.Union([
  Schema.Struct({ type: Schema.Literal("usage"), payload: ProviderPayload }),
  Schema.Struct({ type: Schema.Literal("refresh-provider"), payload: RefreshProviderResultDTO }),
  Schema.Struct({ type: Schema.Literal("dashboard"), payload: DashboardSnapshotDTO }),
  Schema.Struct({ type: Schema.Literal("history"), payload: HistoryQueryResultDTO }),
  Schema.Struct({ type: Schema.Literal("history-export"), payload: HistoryExportDTO }),
  Schema.Struct({ type: Schema.Literal("costs"), payload: CostUsageQueryResultDTO }),
  Schema.Struct({ type: Schema.Literal("costs-export"), payload: CostUsageExportDTO }),
  Schema.Struct({ type: Schema.Literal("config"), payload: Schema.Unknown }),
  Schema.Struct({ type: Schema.Literal("provider-settings"), payload: ProviderSettingsListDTO }),
  Schema.Struct({ type: Schema.Literal("error"), error: ProviderError }),
]);
export type IPCResponse = Schema.Schema.Type<typeof IPCResponse>;
