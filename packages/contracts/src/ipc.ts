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

/**
 * A local multi-account entry attached only to its owning provider row.
 * `id` is source-issued and opaque: consumers must neither derive it from nor
 * use it as an account identity such as an email address.
 */
export const DashboardAccountDTO = Schema.Struct({
  id: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(160))),
  label: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
  active: Schema.Boolean,
  /** Host-projected eligibility; it is not a credential slot or command argument. */
  canActivate: Schema.Boolean,
  identity: Schema.optional(ProviderIdentity),
  windows: Schema.Array(DashboardWindowDTO).pipe(Schema.check(Schema.isMaxLength(32))),
  error: Schema.optional(Schema.String.pipe(Schema.check(Schema.isMaxLength(512)))),
  updatedAt: Schema.optional(ISODateString),
});
export type DashboardAccountDTO = Schema.Schema.Type<typeof DashboardAccountDTO>;

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
  /** Additive, provider-siloed local-account data (currently Claude Swap). */
  accounts: Schema.optional(
    Schema.Array(DashboardAccountDTO).pipe(Schema.check(Schema.isMaxLength(64))),
  ),
  /** A local-account adapter failure that does not replace the ambient provider row. */
  accountsError: Schema.optional(Schema.String.pipe(Schema.check(Schema.isMaxLength(512)))),
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
const TokenAccountId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  Schema.check(Schema.isPattern(/^[^\p{Cc}]+$/u)),
);
const TokenAccountMetadataString = Schema.String.pipe(Schema.check(Schema.isMaxLength(256)));
const TokenAccountRenameLabel = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  Schema.check(Schema.isPattern(/^(?=.*\S)[^\p{Cc}]+$/u)),
);
const TokenAccountSeconds = Schema.Finite.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));
const TokenAccountRevision = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/)));

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

/**
 * Spend source identity remains main-process-only. The renderer receives only
 * the human label and provider ownership required to render a card; it never
 * receives account IDs, profile paths, cache identities, or configuration
 * fingerprints.
 */
export const SpendSourceStateDTO = Schema.Literals([
  "loading",
  "available",
  "confirmed-empty",
  "unavailable",
  "stale-last-known",
]);
export type SpendSourceStateDTO = Schema.Schema.Type<typeof SpendSourceStateDTO>;

export const SpendSourceRoleDTO = Schema.Literals(["subscription", "enrichment"]);
export type SpendSourceRoleDTO = Schema.Schema.Type<typeof SpendSourceRoleDTO>;

/** Safe coverage metadata; internal ledger/source identities never cross IPC. */
export const SpendSourceCoverageDTO = Schema.Literals(["exact", "estimated"]);
export type SpendSourceCoverageDTO = Schema.Schema.Type<typeof SpendSourceCoverageDTO>;

export const SpendSourceDTO = Schema.Struct({
  provider: ProviderInstanceId,
  displayName: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(160))),
  role: SpendSourceRoleDTO,
  state: SpendSourceStateDTO,
  coverage: Schema.optional(SpendSourceCoverageDTO),
});
export type SpendSourceDTO = Schema.Schema.Type<typeof SpendSourceDTO>;

export const SpendTotalsDTO = Schema.Struct({
  inputTokens: Schema.Natural,
  outputTokens: Schema.Natural,
  totalTokens: Schema.Natural,
  costUsd: Schema.Finite.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  coveredDayCount: Schema.Natural,
  sourceCount: Schema.Natural,
});
export type SpendTotalsDTO = Schema.Schema.Type<typeof SpendTotalsDTO>;

export const SpendProviderRowDTO = Schema.Struct({
  provider: ProviderId,
  displayName: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(160))),
  totals: SpendTotalsDTO,
});
export type SpendProviderRowDTO = Schema.Schema.Type<typeof SpendProviderRowDTO>;

const SpendBucketDate = Schema.String.pipe(Schema.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)));
export const SpendDailyPointDTO = Schema.Struct({
  provider: ProviderId,
  day: SpendBucketDate,
  inputTokens: Schema.Natural,
  outputTokens: Schema.Natural,
  costUsd: Schema.Finite.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type SpendDailyPointDTO = Schema.Schema.Type<typeof SpendDailyPointDTO>;

/** Shared safe projection used by the overview card and spend dashboard. */
export const SpendOverviewDTO = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  revision: Schema.Natural,
  generation: Schema.Natural,
  loadedAt: ISODateString,
  isRefreshing: Schema.Boolean,
  truncated: Schema.Boolean,
  sources: Schema.Array(SpendSourceDTO).pipe(Schema.check(Schema.isMaxLength(256))),
  totals: SpendTotalsDTO,
  providers: Schema.Array(SpendProviderRowDTO).pipe(Schema.check(Schema.isMaxLength(69))),
});
export type SpendOverviewDTO = Schema.Schema.Type<typeof SpendOverviewDTO>;

export const SpendDashboardDTO = Schema.Struct({
  overview: SpendOverviewDTO,
  requestedDays: Schema.Natural.pipe(
    Schema.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(365)),
  ),
  dailyPoints: Schema.Array(SpendDailyPointDTO).pipe(Schema.check(Schema.isMaxLength(69 * 365))),
});
export type SpendDashboardDTO = Schema.Schema.Type<typeof SpendDashboardDTO>;

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

export const DefaultBrowserSessionStatusStateDTO = Schema.Literals([
  "persisted",
  "absent",
  "unavailable",
]);
export type DefaultBrowserSessionStatusStateDTO = Schema.Schema.Type<
  typeof DefaultBrowserSessionStatusStateDTO
>;

/**
 * Safe browser-session projection for the renderer's three supported default
 * login buttons only. It deliberately omits cookies, domains, keyring keys,
 * paths, labels, timestamps, and error detail.
 */
export const DefaultBrowserSessionStatusesDTO = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  claudeDefault: DefaultBrowserSessionStatusStateDTO,
  t3chatDefault: DefaultBrowserSessionStatusStateDTO,
  grokDefault: DefaultBrowserSessionStatusStateDTO,
});
export type DefaultBrowserSessionStatusesDTO = Schema.Schema.Type<
  typeof DefaultBrowserSessionStatusesDTO
>;

export const TokenAccountMetadataDTO = Schema.Struct({
  id: TokenAccountId,
  label: TokenAccountMetadataString,
  addedAt: TokenAccountSeconds,
  lastUsed: Schema.optional(TokenAccountSeconds),
  externalIdentifier: Schema.optional(TokenAccountMetadataString),
  usageScope: Schema.optional(TokenAccountMetadataString),
  organizationId: Schema.optional(TokenAccountMetadataString),
  workspaceID: Schema.optional(TokenAccountMetadataString),
  /** Secret-bearing legacy input is never valid on renderer IPC. */
  token: Schema.optional(Schema.Never),
});
export type TokenAccountMetadataDTO = Schema.Schema.Type<typeof TokenAccountMetadataDTO>;

export const TokenAccountRosterDTO = Schema.Struct({
  provider: ProviderId,
  accounts: Schema.Array(TokenAccountMetadataDTO).pipe(Schema.check(Schema.isMaxLength(64))),
  activeIndex: Schema.Natural.pipe(
    Schema.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(63)),
  ),
  selectionAvailable: Schema.Boolean,
  revision: TokenAccountRevision,
});
export type TokenAccountRosterDTO = Schema.Schema.Type<typeof TokenAccountRosterDTO>;

export const ListTokenAccountsRequestDTO = Schema.Struct({
  provider: ProviderId,
});
export type ListTokenAccountsRequestDTO = Schema.Schema.Type<typeof ListTokenAccountsRequestDTO>;

export const SelectTokenAccountRequestDTO = Schema.Struct({
  provider: ProviderId,
  accountId: TokenAccountId,
  expectedRevision: TokenAccountRevision,
});
export type SelectTokenAccountRequestDTO = Schema.Schema.Type<typeof SelectTokenAccountRequestDTO>;

export const RenameTokenAccountRequestDTO = Schema.Struct({
  provider: ProviderId,
  accountId: TokenAccountId,
  label: TokenAccountRenameLabel,
  expectedRevision: TokenAccountRevision,
});
export type RenameTokenAccountRequestDTO = Schema.Schema.Type<typeof RenameTokenAccountRequestDTO>;

export const RemoveTokenAccountRequestDTO = Schema.Struct({
  provider: ProviderId,
  accountId: TokenAccountId,
  expectedRevision: TokenAccountRevision,
  /** Explicitly reject common secret-bearing fields before the main handler. */
  token: Schema.optional(Schema.Never),
  secret: Schema.optional(Schema.Never),
  vaultKey: Schema.optional(Schema.Never),
});
export type RemoveTokenAccountRequestDTO = Schema.Schema.Type<typeof RemoveTokenAccountRequestDTO>;

/** Host-owned Codex CLI login; renderer cannot choose executable, path, ID, or credential. */
export const CodexAccountLoginRequestDTO = Schema.Struct({
  provider: Schema.Literal("codex"),
  token: Schema.optional(Schema.Never),
  secret: Schema.optional(Schema.Never),
  credentialJson: Schema.optional(Schema.Never),
  command: Schema.optional(Schema.Never),
  path: Schema.optional(Schema.Never),
  accountId: Schema.optional(Schema.Never),
});
export type CodexAccountLoginRequestDTO = Schema.Schema.Type<typeof CodexAccountLoginRequestDTO>;

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
 * An account identifier issued by a host-owned Claude Swap listing. The
 * renderer treats this value as opaque and the desktop host rechecks it
 * against a fresh eligible listing before any credential mutation.
 */
export const ClaudeSwapAccountIdDTO = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  Schema.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/u)),
);
export type ClaudeSwapAccountIdDTO = Schema.Schema.Type<typeof ClaudeSwapAccountIdDTO>;

/** Explicitly scoped credential mutation; no executable, slot, args, or source can cross IPC. */
export const ActivateClaudeSwapAccountRequestDTO = Schema.Struct({
  provider: Schema.Literal("claude"),
  accountId: ClaudeSwapAccountIdDTO,
});
export type ActivateClaudeSwapAccountRequestDTO = Schema.Schema.Type<
  typeof ActivateClaudeSwapAccountRequestDTO
>;

/** Deliberately omits helper output, paths, and all credential-bearing details. */
export const ActivateClaudeSwapAccountResultDTO = Schema.Struct({
  provider: Schema.Literal("claude"),
  accountId: ClaudeSwapAccountIdDTO,
  switched: Schema.Boolean,
});
export type ActivateClaudeSwapAccountResultDTO = Schema.Schema.Type<
  typeof ActivateClaudeSwapAccountResultDTO
>;

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
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(3)),
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

/**
 * Global, non-sensitive notification preference. The renderer can read and
 * replace this one Boolean, but never receives the persisted config document
 * or any provider/account data used to produce a notification.
 */
export const SessionQuotaNotificationSettingsDTO = Schema.Struct({
  enabled: Schema.Boolean,
});
export type SessionQuotaNotificationSettingsDTO = Schema.Schema.Type<
  typeof SessionQuotaNotificationSettingsDTO
>;

/** A complete replacement keeps the desktop mutation unambiguous. */
export const UpdateSessionQuotaNotificationSettingsRequestDTO = Schema.Struct({
  enabled: Schema.Boolean,
});
export type UpdateSessionQuotaNotificationSettingsRequestDTO = Schema.Schema.Type<
  typeof UpdateSessionQuotaNotificationSettingsRequestDTO
>;

/** Opaque host-issued capability for one inspected legacy source selection. */
export const LegacyImportTicketDTO = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  Schema.check(Schema.isPattern(/^[a-z0-9-]+$/u)),
);
export type LegacyImportTicketDTO = Schema.Schema.Type<typeof LegacyImportTicketDTO>;

export const LegacyImportIdDTO = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  Schema.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/u)),
);
export type LegacyImportIdDTO = Schema.Schema.Type<typeof LegacyImportIdDTO>;

export const LegacyImportCandidateDTO = Schema.Struct({
  kind: Schema.Union([
    Schema.Literal("config"),
    Schema.Literal("history"),
    Schema.Literal("cost"),
    Schema.Literal("plugins"),
  ]),
  state: Schema.Union([
    Schema.Literal("ready"),
    Schema.Literal("missing"),
    Schema.Literal("invalid"),
    Schema.Literal("excluded"),
  ]),
  itemCount: Schema.Natural,
  byteCount: Schema.Natural,
});
export type LegacyImportCandidateDTO = Schema.Schema.Type<typeof LegacyImportCandidateDTO>;

const LegacyImportCountsDTO = Schema.Struct({
  config: Schema.Natural,
  history: Schema.Natural,
  cost: Schema.Natural,
  plugins: Schema.Natural,
});

/** Data-free inspection result: selected paths and parser details stay in Electron main. */
export const LegacyImportInspectionResultDTO = Schema.Union([
  Schema.Struct({ status: Schema.Literal("cancelled") }),
  Schema.Struct({
    status: Schema.Literal("ready"),
    ticket: LegacyImportTicketDTO,
    candidates: Schema.Array(LegacyImportCandidateDTO).pipe(Schema.check(Schema.isMaxLength(4))),
    excludedFeatures: Schema.Array(
      Schema.Union([
        Schema.Literal("icloud"),
        Schema.Literal("widgetkit"),
        Schema.Literal("sparkle"),
        Schema.Literal("approvals"),
      ]),
    ).pipe(Schema.check(Schema.isMaxLength(4))),
    sqliteCompatibility: Schema.Literal("not-attempted"),
  }),
]);
export type LegacyImportInspectionResultDTO = Schema.Schema.Type<
  typeof LegacyImportInspectionResultDTO
>;

export const ExecuteLegacyImportRequestDTO = Schema.Struct({ ticket: LegacyImportTicketDTO });
export type ExecuteLegacyImportRequestDTO = Schema.Schema.Type<
  typeof ExecuteLegacyImportRequestDTO
>;

export const LegacyImportExecutionResultDTO = Schema.Union([
  Schema.Struct({ status: Schema.Literal("cancelled") }),
  Schema.Struct({
    status: Schema.Union([Schema.Literal("completed"), Schema.Literal("already-completed")]),
    importId: LegacyImportIdDTO,
    imported: LegacyImportCountsDTO,
    skippedCount: Schema.Natural,
  }),
]);
export type LegacyImportExecutionResultDTO = Schema.Schema.Type<
  typeof LegacyImportExecutionResultDTO
>;

export const RollbackLegacyImportRequestDTO = Schema.Struct({ importId: LegacyImportIdDTO });
export type RollbackLegacyImportRequestDTO = Schema.Schema.Type<
  typeof RollbackLegacyImportRequestDTO
>;

export const LegacyImportRollbackResultDTO = Schema.Union([
  Schema.Struct({ status: Schema.Literal("cancelled") }),
  Schema.Struct({
    status: Schema.Literal("completed"),
    importId: LegacyImportIdDTO,
    removed: LegacyImportCountsDTO,
    skippedCount: Schema.Natural,
  }),
]);
export type LegacyImportRollbackResultDTO = Schema.Schema.Type<
  typeof LegacyImportRollbackResultDTO
>;

export const HostFailureStageDTO = Schema.Literals([
  "shell",
  "storage",
  "config",
  "plugins",
  "runtime",
]);
export type HostFailureStageDTO = Schema.Schema.Type<typeof HostFailureStageDTO>;

export const HostStatusDTO = Schema.Union([
  Schema.Struct({
    schemaVersion: Schema.Literal(1),
    status: Schema.Literal("starting"),
  }),
  Schema.Struct({
    schemaVersion: Schema.Literal(1),
    status: Schema.Literal("ready"),
  }),
  Schema.Struct({
    schemaVersion: Schema.Literal(1),
    status: Schema.Literal("failed"),
    failure: Schema.Struct({ stage: HostFailureStageDTO }),
  }),
]);

export type HostStatusDTO = Schema.Schema.Type<typeof HostStatusDTO>;

export const IPCRequest = Schema.Union([
  Schema.Struct({ type: Schema.Literal("get-usage"), provider: Schema.optional(ProviderId) }),
  Schema.Struct({ type: Schema.Literal("refresh-provider"), request: RefreshProviderRequestDTO }),
  Schema.Struct({ type: Schema.Literal("get-history"), query: HistoryQueryDTO }),
  Schema.Struct({ type: Schema.Literal("export-history"), query: HistoryQueryDTO }),
  Schema.Struct({ type: Schema.Literal("get-costs"), query: CostUsageQueryDTO }),
  Schema.Struct({ type: Schema.Literal("export-costs"), query: CostUsageQueryDTO }),
  Schema.Struct({ type: Schema.Literal("get-spend-overview") }),
  Schema.Struct({ type: Schema.Literal("get-spend-dashboard") }),
  Schema.Struct({ type: Schema.Literal("get-config") }),
  Schema.Struct({ type: Schema.Literal("get-provider-settings") }),
  Schema.Struct({ type: Schema.Literal("get-session-quota-notification-settings") }),
  Schema.Struct({
    type: Schema.Literal("update-session-quota-notification-settings"),
    request: UpdateSessionQuotaNotificationSettingsRequestDTO,
  }),
  Schema.Struct({
    type: Schema.Literal("set-provider-enabled"),
    provider: ProviderInstanceId,
    enabled: Schema.Boolean,
  }),
  Schema.Struct({ type: Schema.Literal("start-login"), request: LoginRequestDTO }),
  Schema.Struct({ type: Schema.Literal("cancel-login"), request: LoginRequestDTO }),
  Schema.Struct({ type: Schema.Literal("logout"), request: LoginRequestDTO }),
  Schema.Struct({
    type: Schema.Literal("start-codex-account-login"),
    request: CodexAccountLoginRequestDTO,
  }),
  Schema.Struct({
    type: Schema.Literal("cancel-codex-account-login"),
    request: CodexAccountLoginRequestDTO,
  }),
  Schema.Struct({ type: Schema.Literal("get-default-browser-session-statuses") }),
  Schema.Struct({ type: Schema.Literal("inspect-legacy-import") }),
  Schema.Struct({
    type: Schema.Literal("execute-legacy-import"),
    request: ExecuteLegacyImportRequestDTO,
  }),
  Schema.Struct({
    type: Schema.Literal("rollback-legacy-import"),
    request: RollbackLegacyImportRequestDTO,
  }),
]);
export type IPCRequest = Schema.Schema.Type<typeof IPCRequest>;

export const IPCResponse = Schema.Union([
  Schema.Struct({ type: Schema.Literal("usage"), payload: ProviderPayload }),
  Schema.Struct({ type: Schema.Literal("refresh-provider"), payload: RefreshProviderResultDTO }),
  Schema.Struct({ type: Schema.Literal("codex-account-login"), payload: TokenAccountRosterDTO }),
  Schema.Struct({ type: Schema.Literal("dashboard"), payload: DashboardSnapshotDTO }),
  Schema.Struct({ type: Schema.Literal("history"), payload: HistoryQueryResultDTO }),
  Schema.Struct({ type: Schema.Literal("history-export"), payload: HistoryExportDTO }),
  Schema.Struct({ type: Schema.Literal("costs"), payload: CostUsageQueryResultDTO }),
  Schema.Struct({ type: Schema.Literal("costs-export"), payload: CostUsageExportDTO }),
  Schema.Struct({ type: Schema.Literal("spend-overview"), payload: SpendOverviewDTO }),
  Schema.Struct({ type: Schema.Literal("spend-dashboard"), payload: SpendDashboardDTO }),
  Schema.Struct({ type: Schema.Literal("config"), payload: Schema.Unknown }),
  Schema.Struct({ type: Schema.Literal("provider-settings"), payload: ProviderSettingsListDTO }),
  Schema.Struct({
    type: Schema.Literal("session-quota-notification-settings"),
    payload: SessionQuotaNotificationSettingsDTO,
  }),
  Schema.Struct({
    type: Schema.Literal("default-browser-session-statuses"),
    payload: DefaultBrowserSessionStatusesDTO,
  }),
  Schema.Struct({
    type: Schema.Literal("legacy-import-inspection"),
    payload: LegacyImportInspectionResultDTO,
  }),
  Schema.Struct({
    type: Schema.Literal("legacy-import-execution"),
    payload: LegacyImportExecutionResultDTO,
  }),
  Schema.Struct({
    type: Schema.Literal("legacy-import-rollback"),
    payload: LegacyImportRollbackResultDTO,
  }),
  Schema.Struct({ type: Schema.Literal("error"), error: ProviderError }),
]);
export type IPCResponse = Schema.Schema.Type<typeof IPCResponse>;
