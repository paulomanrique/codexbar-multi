import { contextBridge, ipcRenderer } from "electron";
import * as Schema from "effect/Schema";
import {
  CostUsageExportDTO,
  CostUsageQueryDTO,
  CostUsageQueryResultDTO,
  DashboardSnapshotDTO,
  HistoryExportDTO,
  HistoryQueryDTO,
  HistoryQueryResultDTO,
  LoginRequestDTO,
  LoginResultDTO,
  type CostUsageQueryDTO as CostUsageQuery,
  type HistoryQueryDTO as HistoryQuery,
  type LoginRequestDTO as LoginRequest,
} from "@codexbar/contracts";

import { DesktopChannels, type CodexBarDesktopApi } from "../ipc/api.js";

const decodeOverview = Schema.decodeUnknownPromise(DashboardSnapshotDTO);
const decodeHistoryQuery = Schema.decodeUnknownPromise(HistoryQueryDTO);
const decodeHistoryResult = Schema.decodeUnknownPromise(HistoryQueryResultDTO);
const decodeHistoryExport = Schema.decodeUnknownPromise(HistoryExportDTO);
const decodeCostQuery = Schema.decodeUnknownPromise(CostUsageQueryDTO);
const decodeCostResult = Schema.decodeUnknownPromise(CostUsageQueryResultDTO);
const decodeCostExport = Schema.decodeUnknownPromise(CostUsageExportDTO);
const decodeLoginRequest = Schema.decodeUnknownPromise(LoginRequestDTO);
const decodeLoginResult = Schema.decodeUnknownPromise(LoginResultDTO);
const api: CodexBarDesktopApi = Object.freeze({
  getOverview: async () => decodeOverview(await ipcRenderer.invoke(DesktopChannels.overview)),
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
});

contextBridge.exposeInMainWorld("codexbar", api);
