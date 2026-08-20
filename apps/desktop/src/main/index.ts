import { app, BrowserWindow, ipcMain, nativeImage, Tray } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CostUsageExportDTO,
  CostUsageQueryDTO,
  CostUsageQueryResultDTO,
  LoginRequestDTO,
  DashboardSnapshotDTO,
  HistoryExportDTO,
  HistoryQueryDTO,
  HistoryQueryResultDTO,
  LoginResultDTO,
} from "@codexbar/contracts";
import {
  makeNodeSqliteWorkerPersistence,
  type NodeSqliteWorkerPersistence,
} from "@codexbar/platform/node";
import { Effect } from "effect";
import * as Schema from "effect/Schema";

import { DesktopChannels } from "../ipc/api.js";
import { cancelBrowserLogin, logoutBrowserSession, startBrowserLogin } from "./browser-session.js";
import { exportCosts, exportHistory, queryCosts, queryHistory } from "./history-api.js";
import { loadPersistedOverview } from "./overview.js";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let persistence: NodeSqliteWorkerPersistence | undefined;
let storageClosing = false;

const desktopRequestFailed = () => new Error("Could not complete the desktop request.");

const activePersistence = (): NodeSqliteWorkerPersistence => {
  if (persistence === undefined) throw new Error("Desktop persistence is not ready");
  return persistence;
};

const handleDesktopRequest = async <Value>(request: () => Promise<Value>): Promise<Value> => {
  try {
    return await request();
  } catch {
    // Never relay storage paths, credentials, or native error detail to the renderer.
    throw desktopRequestFailed();
  }
};

function createWindow(): BrowserWindow {
  const created = new BrowserWindow({
    width: 420,
    height: 640,
    minWidth: 360,
    minHeight: 420,
    show: false,
    title: "CodexBar Multi",
    webPreferences: {
      preload: join(currentDirectory, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  created.removeMenu();
  created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  created.webContents.on("will-navigate", (event, url) => {
    if (url !== created.webContents.getURL()) event.preventDefault();
  });
  void created.loadFile(join(currentDirectory, "../renderer/index.html"));
  created.once("ready-to-show", () => created.show());
  created.on("closed", () => {
    window = undefined;
  });
  return created;
}

function trayImage() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22"><rect x="2" y="2" width="18" height="18" rx="5" fill="#111827"/><path d="M7 8h8M7 11h6M7 14h4" stroke="white" stroke-width="1.8" stroke-linecap="round"/></svg>`;
  return nativeImage
    .createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`)
    .resize({ width: 18, height: 18 });
}

void app
  .whenReady()
  .then(async () => {
    persistence = await Effect.runPromise(
      makeNodeSqliteWorkerPersistence({
        databasePath: join(app.getPath("userData"), "usage.sqlite"),
        workerUrl: new URL(/* @vite-ignore */ "./sqlite-worker.js", import.meta.url),
      }),
    );
    const decodeVoid = Schema.decodeUnknownPromise(Schema.Void);
    const decodeOverview = Schema.decodeUnknownPromise(DashboardSnapshotDTO);
    const decodeHistoryQuery = Schema.decodeUnknownPromise(HistoryQueryDTO);
    const decodeHistoryResult = Schema.decodeUnknownPromise(HistoryQueryResultDTO);
    const decodeHistoryExport = Schema.decodeUnknownPromise(HistoryExportDTO);
    const decodeCostQuery = Schema.decodeUnknownPromise(CostUsageQueryDTO);
    const decodeCostResult = Schema.decodeUnknownPromise(CostUsageQueryResultDTO);
    const decodeCostExport = Schema.decodeUnknownPromise(CostUsageExportDTO);
    const decodeLogin = Schema.decodeUnknownPromise(LoginRequestDTO);
    const decodeLoginResult = Schema.decodeUnknownPromise(LoginResultDTO);
    ipcMain.handle(DesktopChannels.overview, (_event, input: unknown) =>
      handleDesktopRequest(async () => {
        await decodeVoid(input);
        return decodeOverview(await loadPersistedOverview(activePersistence()));
      }),
    );
    ipcMain.handle(DesktopChannels.history, (_event, input: unknown) =>
      handleDesktopRequest(async () => {
        const query = await decodeHistoryQuery(input);
        return decodeHistoryResult(await queryHistory(activePersistence(), query));
      }),
    );
    ipcMain.handle(DesktopChannels.exportHistory, (_event, input: unknown) =>
      handleDesktopRequest(async () => {
        const query = await decodeHistoryQuery(input);
        return decodeHistoryExport(await exportHistory(activePersistence(), query));
      }),
    );
    ipcMain.handle(DesktopChannels.costs, (_event, input: unknown) =>
      handleDesktopRequest(async () => {
        const query = await decodeCostQuery(input);
        return decodeCostResult(await queryCosts(activePersistence(), query));
      }),
    );
    ipcMain.handle(DesktopChannels.exportCosts, (_event, input: unknown) =>
      handleDesktopRequest(async () => {
        const query = await decodeCostQuery(input);
        return decodeCostExport(await exportCosts(activePersistence(), query));
      }),
    );
    ipcMain.handle(DesktopChannels.startLogin, (_event, input: unknown) =>
      handleDesktopRequest(async () =>
        decodeLoginResult(await startBrowserLogin(await decodeLogin(input))),
      ),
    );
    ipcMain.handle(DesktopChannels.cancelLogin, (_event, input: unknown) =>
      handleDesktopRequest(async () => {
        await cancelBrowserLogin(await decodeLogin(input));
        return decodeVoid(undefined);
      }),
    );
    ipcMain.handle(DesktopChannels.logout, (_event, input: unknown) =>
      handleDesktopRequest(async () => {
        await logoutBrowserSession(await decodeLogin(input));
        return decodeVoid(undefined);
      }),
    );
    window = createWindow();
    tray = new Tray(trayImage());
    tray.setToolTip("CodexBar Multi");
    tray.on("click", () => {
      if (window === undefined) window = createWindow();
      else if (window.isVisible()) window.hide();
      else window.show();
    });
  })
  .catch((cause: unknown) => {
    console.error("Could not start CodexBar Multi", cause);
    app.exit(1);
  });

app.on("before-quit", (event) => {
  if (persistence === undefined || storageClosing) return;
  event.preventDefault();
  storageClosing = true;
  void Effect.runPromise(persistence.close)
    .catch((cause: unknown) => console.error("Could not close the usage database", cause))
    .finally(() => app.quit());
});

app.on("window-all-closed", () => {
  // Tray applications stay alive until the user explicitly quits.
});
