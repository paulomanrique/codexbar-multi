import { contextBridge, ipcRenderer } from "electron";
import * as Schema from "effect/Schema";
import {
  DashboardSnapshotDTO,
  LoginRequestDTO,
  LoginResultDTO,
  type LoginRequestDTO as LoginRequest,
} from "@codexbar/contracts";

import { DesktopChannels, type CodexBarDesktopApi } from "../ipc/api.js";

const decodeOverview = Schema.decodeUnknownPromise(DashboardSnapshotDTO);
const decodeLoginRequest = Schema.decodeUnknownPromise(LoginRequestDTO);
const decodeLoginResult = Schema.decodeUnknownPromise(LoginResultDTO);
const api: CodexBarDesktopApi = Object.freeze({
  getOverview: async () => decodeOverview(await ipcRenderer.invoke(DesktopChannels.overview)),
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
