import type {
  CostUsageExportDTO,
  CostUsageQueryDTO,
  CostUsageQueryResultDTO,
  SpendDashboardDTO,
  SpendOverviewDTO,
  DashboardSnapshotDTO,
  HistoryExportDTO,
  HistoryQueryDTO,
  HistoryQueryResultDTO,
  LoginRequestDTO,
  LoginResultDTO,
  InstallPluginRequestDTO,
  InstalledPluginDTO,
  PluginApprovalPreviewDTO,
  PluginApprovalPreviewRequestDTO,
  PluginApprovalRequestDTO,
  PluginListResultDTO,
  PluginSecretRequestDTO,
  PluginSecretResultDTO,
  RemovePluginRequestDTO,
  TestPluginRequestDTO,
  TestPluginResultDTO,
  RefreshProviderRequestDTO,
  RefreshProviderResultDTO,
  ActivateClaudeSwapAccountRequestDTO,
  ActivateClaudeSwapAccountResultDTO,
  ProviderSettingsDTO,
  ProviderSettingsListDTO,
  SessionQuotaNotificationSettingsDTO,
  UpdateSessionQuotaNotificationSettingsRequestDTO,
  UpdateProviderSettingsRequestDTO,
  ExecuteLegacyImportRequestDTO,
  LegacyImportExecutionResultDTO,
  LegacyImportInspectionResultDTO,
  LegacyImportRollbackResultDTO,
  RollbackLegacyImportRequestDTO,
} from "@codexbar/contracts";

export const DesktopChannels = Object.freeze({
  overview: "codexbar-multi:overview",
  history: "codexbar-multi:history",
  exportHistory: "codexbar-multi:export-history",
  costs: "codexbar-multi:costs",
  exportCosts: "codexbar-multi:export-costs",
  spendOverview: "codexbar-multi:spend-overview",
  spendDashboard: "codexbar-multi:spend-dashboard",
  startLogin: "codexbar-multi:start-login",
  cancelLogin: "codexbar-multi:cancel-login",
  logout: "codexbar-multi:logout",
  refreshProvider: "codexbar-multi:refresh-provider",
  activateClaudeSwapAccount: "codexbar-multi:activate-claude-swap-account",
  getProviderSettings: "codexbar-multi:get-provider-settings",
  updateProviderSettings: "codexbar-multi:update-provider-settings",
  getSessionQuotaNotificationSettings: "codexbar-multi:get-session-quota-notification-settings",
  updateSessionQuotaNotificationSettings:
    "codexbar-multi:update-session-quota-notification-settings",
  inspectLegacyImport: "codexbar-multi:inspect-legacy-import",
  executeLegacyImport: "codexbar-multi:execute-legacy-import",
  rollbackLegacyImport: "codexbar-multi:rollback-legacy-import",
  listPlugins: "codexbar-multi:list-plugins",
  installPlugin: "codexbar-multi:install-plugin",
  previewPluginApproval: "codexbar-multi:preview-plugin-approval",
  approvePlugin: "codexbar-multi:approve-plugin",
  removePlugin: "codexbar-multi:remove-plugin",
  testPlugin: "codexbar-multi:test-plugin",
  configurePluginSecret: "codexbar-multi:configure-plugin-secret",
});

export interface CodexBarDesktopApi {
  readonly getOverview: () => Promise<DashboardSnapshotDTO>;
  readonly getHistory: (query: HistoryQueryDTO) => Promise<HistoryQueryResultDTO>;
  readonly exportHistory: (query: HistoryQueryDTO) => Promise<HistoryExportDTO>;
  readonly getCosts: (query: CostUsageQueryDTO) => Promise<CostUsageQueryResultDTO>;
  readonly exportCosts: (query: CostUsageQueryDTO) => Promise<CostUsageExportDTO>;
  /** High-level spend projections only; no source IDs, files, or credentials. */
  readonly getSpendOverview: () => Promise<SpendOverviewDTO>;
  readonly getSpendDashboard: () => Promise<SpendDashboardDTO>;
  readonly startLogin: (request: LoginRequestDTO) => Promise<LoginResultDTO>;
  readonly cancelLogin: (request: LoginRequestDTO) => Promise<void>;
  readonly logout: (request: LoginRequestDTO) => Promise<void>;
  readonly refreshProvider: (
    request: RefreshProviderRequestDTO,
  ) => Promise<RefreshProviderResultDTO>;
  /** Activates only a host-listed Claude Swap account ID. */
  readonly activateClaudeSwapAccount: (
    request: ActivateClaudeSwapAccountRequestDTO,
  ) => Promise<ActivateClaudeSwapAccountResultDTO>;
  /** First-party enablement/source projection only; no config document or secrets. */
  readonly getProviderSettings: () => Promise<ProviderSettingsListDTO>;
  readonly updateProviderSettings: (
    request: UpdateProviderSettingsRequestDTO,
  ) => Promise<ProviderSettingsDTO>;
  /** Global non-sensitive preference only; never exposes the config document. */
  readonly getSessionQuotaNotificationSettings: () => Promise<SessionQuotaNotificationSettingsDTO>;
  readonly updateSessionQuotaNotificationSettings: (
    request: UpdateSessionQuotaNotificationSettingsRequestDTO,
  ) => Promise<SessionQuotaNotificationSettingsDTO>;
  /** Native-picker, ticketed migration API. No path or source content crosses preload. */
  readonly inspectLegacyImport: () => Promise<LegacyImportInspectionResultDTO>;
  readonly executeLegacyImport: (
    request: ExecuteLegacyImportRequestDTO,
  ) => Promise<LegacyImportExecutionResultDTO>;
  readonly rollbackLegacyImport: (
    request: RollbackLegacyImportRequestDTO,
  ) => Promise<LegacyImportRollbackResultDTO>;
  readonly listPlugins: () => Promise<PluginListResultDTO>;
  readonly installPlugin: (request: InstallPluginRequestDTO) => Promise<InstalledPluginDTO>;
  readonly previewPluginApproval: (
    request: PluginApprovalPreviewRequestDTO,
  ) => Promise<PluginApprovalPreviewDTO>;
  readonly approvePlugin: (request: PluginApprovalRequestDTO) => Promise<PluginApprovalPreviewDTO>;
  readonly removePlugin: (request: RemovePluginRequestDTO) => Promise<void>;
  readonly testPlugin: (request: TestPluginRequestDTO) => Promise<TestPluginResultDTO>;
  readonly configurePluginSecret: (
    request: PluginSecretRequestDTO,
  ) => Promise<PluginSecretResultDTO>;
}
