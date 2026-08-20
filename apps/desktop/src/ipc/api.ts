import type {
  CostUsageExportDTO,
  CostUsageQueryDTO,
  CostUsageQueryResultDTO,
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
  RemovePluginRequestDTO,
  TestPluginRequestDTO,
  TestPluginResultDTO,
  RefreshProviderRequestDTO,
  RefreshProviderResultDTO,
} from "@codexbar/contracts";

export const DesktopChannels = Object.freeze({
  overview: "codexbar-multi:overview",
  history: "codexbar-multi:history",
  exportHistory: "codexbar-multi:export-history",
  costs: "codexbar-multi:costs",
  exportCosts: "codexbar-multi:export-costs",
  startLogin: "codexbar-multi:start-login",
  cancelLogin: "codexbar-multi:cancel-login",
  logout: "codexbar-multi:logout",
  refreshProvider: "codexbar-multi:refresh-provider",
  listPlugins: "codexbar-multi:list-plugins",
  installPlugin: "codexbar-multi:install-plugin",
  previewPluginApproval: "codexbar-multi:preview-plugin-approval",
  approvePlugin: "codexbar-multi:approve-plugin",
  removePlugin: "codexbar-multi:remove-plugin",
  testPlugin: "codexbar-multi:test-plugin",
});

export interface CodexBarDesktopApi {
  readonly getOverview: () => Promise<DashboardSnapshotDTO>;
  readonly getHistory: (query: HistoryQueryDTO) => Promise<HistoryQueryResultDTO>;
  readonly exportHistory: (query: HistoryQueryDTO) => Promise<HistoryExportDTO>;
  readonly getCosts: (query: CostUsageQueryDTO) => Promise<CostUsageQueryResultDTO>;
  readonly exportCosts: (query: CostUsageQueryDTO) => Promise<CostUsageExportDTO>;
  readonly startLogin: (request: LoginRequestDTO) => Promise<LoginResultDTO>;
  readonly cancelLogin: (request: LoginRequestDTO) => Promise<void>;
  readonly logout: (request: LoginRequestDTO) => Promise<void>;
  readonly refreshProvider: (
    request: RefreshProviderRequestDTO,
  ) => Promise<RefreshProviderResultDTO>;
  readonly listPlugins: () => Promise<PluginListResultDTO>;
  readonly installPlugin: (request: InstallPluginRequestDTO) => Promise<InstalledPluginDTO>;
  readonly previewPluginApproval: (
    request: PluginApprovalPreviewRequestDTO,
  ) => Promise<PluginApprovalPreviewDTO>;
  readonly approvePlugin: (request: PluginApprovalRequestDTO) => Promise<PluginApprovalPreviewDTO>;
  readonly removePlugin: (request: RemovePluginRequestDTO) => Promise<void>;
  readonly testPlugin: (request: TestPluginRequestDTO) => Promise<TestPluginResultDTO>;
}
