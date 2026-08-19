import { app, BrowserWindow, ipcMain, nativeImage, Tray } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  LoginRequestDTO,
  type DashboardSnapshotDTO,
  type ProviderInstanceId,
} from "@codexbar/contracts";
import { PROVIDERS } from "@codexbar/providers";
import {
  makeNodeSqliteWorkerPersistence,
  type NodeSqliteWorkerPersistence,
} from "@codexbar/platform/node";
import { Effect } from "effect";
import * as Schema from "effect/Schema";

import { DesktopChannels } from "../ipc/api.js";
import { cancelBrowserLogin, logoutBrowserSession, startBrowserLogin } from "./browser-session.js";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let persistence: NodeSqliteWorkerPersistence | undefined;
let storageClosing = false;

function overview(): DashboardSnapshotDTO {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    staleAfterSeconds: 300,
    providers: PROVIDERS.map((provider) => ({
      id: provider.id as ProviderInstanceId,
      name: provider.name,
      enabled: provider.status === "partial",
      source: "auto",
      windows: [],
    })),
  };
}

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
    ipcMain.handle(DesktopChannels.overview, () => overview());
    const decodeLogin = Schema.decodeUnknownPromise(LoginRequestDTO);
    ipcMain.handle(DesktopChannels.startLogin, async (_event, input: unknown) =>
      startBrowserLogin(await decodeLogin(input)),
    );
    ipcMain.handle(DesktopChannels.cancelLogin, async (_event, input: unknown) =>
      cancelBrowserLogin(await decodeLogin(input)),
    );
    ipcMain.handle(DesktopChannels.logout, async (_event, input: unknown) =>
      logoutBrowserSession(await decodeLogin(input)),
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
