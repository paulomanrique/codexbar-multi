import { contextBridge, ipcRenderer } from "electron";
import * as Schema from "effect/Schema";
import {
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
  type CostUsageQueryDTO as CostUsageQuery,
  type HistoryQueryDTO as HistoryQuery,
  type LoginRequestDTO as LoginRequest,
  type InstallPluginRequestDTO as InstallPluginRequest,
  type PluginApprovalPreviewRequestDTO as PluginApprovalPreviewRequest,
  type PluginApprovalRequestDTO as PluginApprovalRequest,
  type PluginSecretRequestDTO as PluginSecretRequest,
  type RemovePluginRequestDTO as RemovePluginRequest,
  type TestPluginRequestDTO as TestPluginRequest,
  type RefreshProviderRequestDTO as RefreshProviderRequest,
} from "@codexbar/contracts";

import { DesktopChannels, type CodexBarDesktopApi } from "../ipc/api.js";
import { makeProviderSettingsApi } from "./provider-settings-api.js";
import { makeClaudeSwapApi } from "./claude-swap-api.js";
import { makeSessionQuotaNotificationSettingsApi } from "./session-quota-notification-settings-api.js";
import { makeLegacyImportApi } from "./legacy-import-api.js";
import { makeHostStatusApi } from "./host-status-api.js";
import { makeDefaultBrowserSessionStatusesApi } from "./default-browser-session-statuses-api.js";
import { makeOverviewUpdatedApi } from "./overview-updated-api.js";
import { makeTokenAccountsApi } from "./token-accounts-api.js";
import { makeCodexBrowserSessionApi } from "./codex-browser-session-api.js";

const decodeOverview = Schema.decodeUnknownPromise(DashboardSnapshotDTO);
const decodeHistoryQuery = Schema.decodeUnknownPromise(HistoryQueryDTO);
const decodeHistoryResult = Schema.decodeUnknownPromise(HistoryQueryResultDTO);
const decodeHistoryExport = Schema.decodeUnknownPromise(HistoryExportDTO);
const decodeCostQuery = Schema.decodeUnknownPromise(CostUsageQueryDTO);
const decodeCostResult = Schema.decodeUnknownPromise(CostUsageQueryResultDTO);
const decodeCostExport = Schema.decodeUnknownPromise(CostUsageExportDTO);
const decodeSpendOverview = Schema.decodeUnknownPromise(SpendOverviewDTO);
const decodeSpendDashboard = Schema.decodeUnknownPromise(SpendDashboardDTO);
const decodeLoginRequest = Schema.decodeUnknownPromise(LoginRequestDTO);
const decodeLoginResult = Schema.decodeUnknownPromise(LoginResultDTO);
const decodeRefreshRequest = Schema.decodeUnknownPromise(RefreshProviderRequestDTO);
const decodeRefreshResult = Schema.decodeUnknownPromise(RefreshProviderResultDTO);
const decodeInstallPluginRequest = Schema.decodeUnknownPromise(InstallPluginRequestDTO);
const decodeInstalledPlugin = Schema.decodeUnknownPromise(InstalledPluginDTO);
const decodePluginList = Schema.decodeUnknownPromise(PluginListResultDTO);
const decodePluginApprovalPreviewRequest = Schema.decodeUnknownPromise(
  PluginApprovalPreviewRequestDTO,
);
const decodePluginApprovalRequest = Schema.decodeUnknownPromise(PluginApprovalRequestDTO);
const decodePluginApprovalPreview = Schema.decodeUnknownPromise(PluginApprovalPreviewDTO);
const decodeRemovePluginRequest = Schema.decodeUnknownPromise(RemovePluginRequestDTO);
const decodeTestPluginRequest = Schema.decodeUnknownPromise(TestPluginRequestDTO);
const decodeTestPluginResult = Schema.decodeUnknownPromise(TestPluginResultDTO);
const decodePluginSecretRequest = Schema.decodeUnknownPromise(PluginSecretRequestDTO);
const decodePluginSecretResult = Schema.decodeUnknownPromise(PluginSecretResultDTO);
const api: CodexBarDesktopApi = Object.freeze({
  ...makeHostStatusApi((channel, input) => ipcRenderer.invoke(channel, input)),
  getOverview: async () => decodeOverview(await ipcRenderer.invoke(DesktopChannels.overview)),
  ...makeOverviewUpdatedApi(
    (channel, listener) => {
      ipcRenderer.on(channel, listener);
    },
    (channel, listener) => {
      ipcRenderer.removeListener(channel, listener);
    },
  ),
  getHistory: async (query: HistoryQuery) =>
    decodeHistoryResult(
      await ipcRenderer.invoke(DesktopChannels.history, await decodeHistoryQuery(query)),
    ),
  exportHistory: async (query: HistoryQuery) =>
    decodeHistoryExport(
      await ipcRenderer.invoke(DesktopChannels.exportHistory, await decodeHistoryQuery(query)),
    ),
  getCosts: async (query: CostUsageQuery) =>
    decodeCostResult(await ipcRenderer.invoke(DesktopChannels.costs, await decodeCostQuery(query))),
  exportCosts: async (query: CostUsageQuery) =>
    decodeCostExport(
      await ipcRenderer.invoke(DesktopChannels.exportCosts, await decodeCostQuery(query)),
    ),
  getSpendOverview: async () =>
    decodeSpendOverview(await ipcRenderer.invoke(DesktopChannels.spendOverview)),
  getSpendDashboard: async () =>
    decodeSpendDashboard(await ipcRenderer.invoke(DesktopChannels.spendDashboard)),
  startLogin: async (request: LoginRequest) =>
    decodeLoginResult(
      await ipcRenderer.invoke(DesktopChannels.startLogin, await decodeLoginRequest(request)),
    ),
  cancelLogin: async (request: LoginRequest) => {
    await ipcRenderer.invoke(DesktopChannels.cancelLogin, await decodeLoginRequest(request));
  },
  logout: async (request: LoginRequest) => {
    await ipcRenderer.invoke(DesktopChannels.logout, await decodeLoginRequest(request));
  },
  refreshProvider: async (request: RefreshProviderRequest) =>
    decodeRefreshResult(
      await ipcRenderer.invoke(
        DesktopChannels.refreshProvider,
        await decodeRefreshRequest(request),
      ),
    ),
  ...makeTokenAccountsApi((channel, input) => ipcRenderer.invoke(channel, input)),
  ...makeCodexBrowserSessionApi((channel, input) => ipcRenderer.invoke(channel, input)),
  ...makeClaudeSwapApi((channel, input) => ipcRenderer.invoke(channel, input)),
  ...makeProviderSettingsApi((channel, input) => ipcRenderer.invoke(channel, input)),
  ...makeDefaultBrowserSessionStatusesApi((channel, input) => ipcRenderer.invoke(channel, input)),
  ...makeSessionQuotaNotificationSettingsApi((channel, input) =>
    ipcRenderer.invoke(channel, input),
  ),
  ...makeLegacyImportApi((channel, input) => ipcRenderer.invoke(channel, input)),
  listPlugins: async () => decodePluginList(await ipcRenderer.invoke(DesktopChannels.listPlugins)),
  installPlugin: async (request: InstallPluginRequest) =>
    decodeInstalledPlugin(
      await ipcRenderer.invoke(
        DesktopChannels.installPlugin,
        await decodeInstallPluginRequest(request),
      ),
    ),
  previewPluginApproval: async (request: PluginApprovalPreviewRequest) =>
    decodePluginApprovalPreview(
      await ipcRenderer.invoke(
        DesktopChannels.previewPluginApproval,
        await decodePluginApprovalPreviewRequest(request),
      ),
    ),
  approvePlugin: async (request: PluginApprovalRequest) =>
    decodePluginApprovalPreview(
      await ipcRenderer.invoke(
        DesktopChannels.approvePlugin,
        await decodePluginApprovalRequest(request),
      ),
    ),
  removePlugin: async (request: RemovePluginRequest) => {
    await ipcRenderer.invoke(
      DesktopChannels.removePlugin,
      await decodeRemovePluginRequest(request),
    );
  },
  testPlugin: async (request: TestPluginRequest) =>
    decodeTestPluginResult(
      await ipcRenderer.invoke(DesktopChannels.testPlugin, await decodeTestPluginRequest(request)),
    ),
  configurePluginSecret: async (request: PluginSecretRequest) =>
    decodePluginSecretResult(
      await ipcRenderer.invoke(
        DesktopChannels.configurePluginSecret,
        await decodePluginSecretRequest(request),
      ),
    ),
});

contextBridge.exposeInMainWorld("codexbar", api);
