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
}
