import { app, BrowserWindow, ipcMain, nativeImage, Tray } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CostUsageExportDTO,
  CostUsageQueryDTO,
  CostUsageQueryResultDTO,
  LoginRequestDTO,
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
  UsageSnapshot,
  DashboardSnapshotDTO,
  RefreshProviderRequestDTO,
  RefreshProviderResultDTO,
  ProviderSettingsDTO,
  ProviderSettingsListDTO,
  UpdateProviderSettingsRequestDTO,
  HistoryExportDTO,
  HistoryQueryDTO,
  HistoryQueryResultDTO,
  LoginResultDTO,
} from "@codexbar/contracts";
import {
  makeCredentialBrowserSessions,
  makeEnvironmentProviderSettings,
  makeFetchHttpTransport,
  makeFirstPartyProviderRuntime,
  makeNativeCredentialStore,
  makeNodeFirstPartyLocalCapabilities,
  makeNodeConfigRepository,
  makeSystemClock,
  makeNodeSqliteWorkerPersistence,
  type NodeSqliteWorkerPersistence,
} from "@codexbar/platform/node";
import {
  Clock,
  HistoryRepository,
  makeDefaultCodexBarConfig,
  refreshProviderAndPersist,
  type PersistedCodexBarConfig,
  type ProviderRuntimeService,
} from "@codexbar/core";
import { FIRST_PARTY_PROVIDERS, PROVIDERS } from "@codexbar/providers";
import { Effect } from "effect";
import * as Schema from "effect/Schema";

import { DesktopChannels } from "../ipc/api.js";
import { cancelBrowserLogin, logoutBrowserSession, startBrowserLogin } from "./browser-session.js";
import { exportCosts, exportHistory, queryCosts, queryHistory } from "./history-api.js";
import { loadPersistedOverview } from "./overview.js";
import { DesktopPluginManager } from "./plugin-manager.js";
import { makePluginCredentialBrowserSessions } from "./plugin-browser-session.js";
import { makeElectronPluginSandbox } from "./plugin-sandbox-process.js";
import {
  DesktopConfigMutations,
  providerSettingsFor,
  providerSettingsProjection,
  providerSettingsSourcesForKind,
  updateSupportedFirstPartyProviderSettings,
} from "./provider-settings.js";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
// Electron otherwise derives this directory from the executable name, which
// becomes `Electron` in development and varies across packaged platforms.
// Keep the product data namespace stable without teaching domain packages
// anything about operating-system paths.
app.setPath("userData", join(app.getPath("appData"), "codexbar-multi"));
let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let persistence: NodeSqliteWorkerPersistence | undefined;
let providerRuntime: ProviderRuntimeService | undefined;
let desktopConfig: PersistedCodexBarConfig | undefined;
let pluginManager: DesktopPluginManager | undefined;
let pluginSandbox: ReturnType<typeof makeElectronPluginSandbox> | undefined;
const desktopConfigMutations = new DesktopConfigMutations();
const providerSettingsCapabilities = FIRST_PARTY_PROVIDERS.map((provider) => ({
  id: provider.descriptor.id,
  availableSources: providerSettingsSourcesForKind(provider.kind),
}));
const providerSettingsCapabilitiesById = new Map(
  providerSettingsCapabilities.map((capability) => [capability.id, capability]),
);
/** Latest user-plugin snapshots are host-only and are cleared with the plugin. */
const pluginSnapshots = new Map<string, UsageSnapshot>();
const providerClock = makeSystemClock();
let storageClosing = false;

const desktopRequestFailed = () => new Error("Could not complete the desktop request.");

const activePersistence = (): NodeSqliteWorkerPersistence => {
  if (persistence === undefined) throw new Error("Desktop persistence is not ready");
  return persistence;
};
const activeProviderRuntime = (): ProviderRuntimeService => {
  if (providerRuntime === undefined) throw new Error("Provider runtime is not ready");
  return providerRuntime;
};
const activePluginManager = (): DesktopPluginManager => {
  if (pluginManager === undefined) throw new Error("Plugin manager is not ready");
  return pluginManager;
};

const overviewProviders = () => {
  const byId = new Map(desktopConfig?.providers.map((provider) => [provider.id, provider]));
  return PROVIDERS.map((provider) => {
    const configured = byId.get(provider.id);
    const availableSources = providerSettingsCapabilitiesById.get(provider.id)
      ?.availableSources ?? ["auto"];
    const source = configured?.source;
    return {
      ...provider,
      enabled: configured?.enabled ?? provider.id === "codex",
      source: source !== undefined && availableSources.includes(source) ? source : "auto",
    } as const;
  });
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
    // The config adapter retains only registered plugin IDs. Populate this
    // mutable set from the hardened discovery pass before decoding a config,
    // so deleting one plugin cannot discard a sibling plugin's config entry.
    const pluginProviderIds = new Set<string>();
    const configRepository = makeNodeConfigRepository(
      join(app.getPath("userData"), "config.json"),
      {
        pluginProviderIds,
      },
    );
    const mutateDesktopConfig = <Value>(
      mutation: (current: PersistedCodexBarConfig) => Promise<{
        readonly next: PersistedCodexBarConfig;
        readonly value: Value;
      }>,
    ): Promise<Value> =>
      desktopConfigMutations.run(async () => {
        const current = desktopConfig;
        if (current === undefined) throw new Error("Desktop config is not ready");
        const result = await mutation(current);
        // The repository performs a same-directory atomic replacement. Do not
        // update the in-memory view until that replacement has succeeded.
        await Effect.runPromise(configRepository.save(result.next));
        desktopConfig = result.next;
        return result.value;
      });
    const credentials = makeNativeCredentialStore();
    providerRuntime = makeFirstPartyProviderRuntime({
      providers: FIRST_PARTY_PROVIDERS,
      settings: makeEnvironmentProviderSettings(),
      credentials,
      browserSessions: makeCredentialBrowserSessions(credentials),
      local: makeNodeFirstPartyLocalCapabilities(),
      http: makeFetchHttpTransport(),
      clock: providerClock,
    });
    pluginSandbox = makeElectronPluginSandbox();
    const pluginBrowserSessions = makePluginCredentialBrowserSessions({
      read: (key) => Effect.runPromise(credentials.read(key)),
      remove: (key) => Effect.runPromise(credentials.remove(key)),
    });
    pluginManager = new DesktopPluginManager({
      storageRoot: app.getPath("userData"),
      sandbox: pluginSandbox,
      reservedIds: new Set(PROVIDERS.map((provider) => provider.id)),
      readSecret: (pluginId, key) =>
        Effect.runPromise(credentials.read(`plugin/${pluginId}/secret/${key}`)),
      writeSecret: (pluginId, key, value) =>
        Effect.runPromise(credentials.write(`plugin/${pluginId}/secret/${key}`, value)),
      removeSecret: (pluginId, key) =>
        Effect.runPromise(credentials.remove(`plugin/${pluginId}/secret/${key}`)),
      readCookie: pluginBrowserSessions.readCookie,
      removeBrowserSessions: pluginBrowserSessions.remove,
      persistSnapshot: (pluginId, snapshot) =>
        Effect.runPromise(
          activePersistence().history.append({
            providerId: pluginId,
            recordedAt: Date.now(),
            snapshot,
          }),
        ).then(() => {
          pluginSnapshots.set(pluginId, snapshot);
        }),
      removeSnapshot: async (pluginId) => {
        pluginSnapshots.delete(pluginId);
      },
      removeHistory: (pluginId) =>
        Effect.runPromise(activePersistence().history.removeProvider(pluginId)),
      removeConfig: async (pluginId) => {
        await mutateDesktopConfig(async (current) => {
          const providers = current.providers.filter((provider) => provider.id !== pluginId);
          return {
            next:
              providers.length === current.providers.length ? current : { ...current, providers },
            value: undefined,
          };
        });
      },
      finalizeRemove: async (pluginId) => {
        pluginProviderIds.delete(pluginId);
      },
      log: (pluginId, message) => console.info(`[plugin:${pluginId}]`, message),
    });
    const installedPlugins = await pluginManager.list();
    for (const plugin of installedPlugins.plugins) pluginProviderIds.add(plugin.id);
    desktopConfig = await Effect.runPromise(configRepository.load);
    if (desktopConfig === undefined) {
      desktopConfig = makeDefaultCodexBarConfig();
      await Effect.runPromise(configRepository.save(desktopConfig));
    }
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
    const decodeRefresh = Schema.decodeUnknownPromise(RefreshProviderRequestDTO);
    const decodeRefreshResult = Schema.decodeUnknownPromise(RefreshProviderResultDTO);
    const decodeProviderSettings = Schema.decodeUnknownPromise(ProviderSettingsDTO);
    const decodeProviderSettingsList = Schema.decodeUnknownPromise(ProviderSettingsListDTO);
    const decodeUpdateProviderSettings = Schema.decodeUnknownPromise(
      UpdateProviderSettingsRequestDTO,
    );
    const decodeInstallPlugin = Schema.decodeUnknownPromise(InstallPluginRequestDTO);
    const decodeInstalledPlugin = Schema.decodeUnknownPromise(InstalledPluginDTO);
    const decodePluginList = Schema.decodeUnknownPromise(PluginListResultDTO);
    const decodePluginApprovalPreviewRequest = Schema.decodeUnknownPromise(
      PluginApprovalPreviewRequestDTO,
    );
    const decodePluginApprovalRequest = Schema.decodeUnknownPromise(PluginApprovalRequestDTO);
    const decodePluginApprovalPreview = Schema.decodeUnknownPromise(PluginApprovalPreviewDTO);
    const decodeRemovePlugin = Schema.decodeUnknownPromise(RemovePluginRequestDTO);
    const decodeTestPlugin = Schema.decodeUnknownPromise(TestPluginRequestDTO);
    const decodeTestPluginResult = Schema.decodeUnknownPromise(TestPluginResultDTO);
    const decodePluginSecret = Schema.decodeUnknownPromise(PluginSecretRequestDTO);
    const decodePluginSecretResult = Schema.decodeUnknownPromise(PluginSecretResultDTO);
    ipcMain.handle(DesktopChannels.overview, (_event, input: unknown) =>
      handleDesktopRequest(async () => {
        await decodeVoid(input);
        return decodeOverview(
          await loadPersistedOverview(activePersistence(), () => new Date(), overviewProviders()),
        );
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
    ipcMain.handle(DesktopChannels.refreshProvider, (_event, input: unknown) =>
      handleDesktopRequest(async () => {
        const request = await decodeRefresh(input);
        const outcome = await Effect.runPromise(
          refreshProviderAndPersist(activeProviderRuntime(), request.provider, {
            sourceMode: request.source ?? "auto",
            includeCredits: true,
          }).pipe(
            Effect.provideService(Clock, providerClock),
            Effect.provideService(HistoryRepository, activePersistence().history),
          ),
        );
        return decodeRefreshResult({
          provider: request.provider,
          strategyId: outcome.strategyId,
          source: outcome.source,
          snapshot: outcome.snapshot,
        });
      }),
    );
    ipcMain.handle(DesktopChannels.getProviderSettings, (_event, input: unknown) =>
      handleDesktopRequest(async () => {
        await decodeVoid(input);
        const current = desktopConfig;
        if (current === undefined) throw new Error("Desktop config is not ready");
        return decodeProviderSettingsList({
          providers: providerSettingsProjection(current, providerSettingsCapabilities),
        });
      }),
    );
    ipcMain.handle(DesktopChannels.updateProviderSettings, (_event, input: unknown) =>
      handleDesktopRequest(async () => {
        const request = await decodeUpdateProviderSettings(input);
        const saved = await mutateDesktopConfig(async (current) => {
          const next = updateSupportedFirstPartyProviderSettings(
            current,
            request,
            providerSettingsCapabilities,
          );
          return { next, value: next };
        });
        const projected = providerSettingsFor(saved, request, providerSettingsCapabilities);
        if (projected === undefined) throw new Error("Provider settings are not available");
        return decodeProviderSettings(projected);
      }),
    );
    ipcMain.handle(DesktopChannels.listPlugins, (_event, input: unknown) =>
      handleDesktopRequest(async () => {
        await decodeVoid(input);
        return decodePluginList(await activePluginManager().list());
      }),
    );
    ipcMain.handle(DesktopChannels.installPlugin, (_event, input: unknown) =>
      handleDesktopRequest(async () => {
        const request = await decodeInstallPlugin(input);
        const installed = await activePluginManager().install(request.source, request.language);
        pluginProviderIds.add(installed.id);
        return decodeInstalledPlugin(installed);
      }),
    );
    ipcMain.handle(DesktopChannels.previewPluginApproval, (_event, input: unknown) =>
      handleDesktopRequest(async () => {
        const request = await decodePluginApprovalPreviewRequest(input);
        return decodePluginApprovalPreview(
          await activePluginManager().previewApproval(request.pluginId, request.settings),
        );
      }),
    );
    ipcMain.handle(DesktopChannels.approvePlugin, (_event, input: unknown) =>
      handleDesktopRequest(async () =>
        decodePluginApprovalPreview(
          await activePluginManager().approve(await decodePluginApprovalRequest(input)),
        ),
      ),
    );
    ipcMain.handle(DesktopChannels.removePlugin, (_event, input: unknown) =>
      handleDesktopRequest(async () => {
        const request = await decodeRemovePlugin(input);
        await activePluginManager().remove(request.pluginId);
        return decodeVoid(undefined);
      }),
    );
    ipcMain.handle(DesktopChannels.testPlugin, (_event, input: unknown) =>
      handleDesktopRequest(async () => {
        const request = await decodeTestPlugin(input);
        return decodeTestPluginResult(await activePluginManager().test(request.pluginId));
      }),
    );
    ipcMain.handle(DesktopChannels.configurePluginSecret, (_event, input: unknown) =>
      handleDesktopRequest(async () =>
        decodePluginSecretResult(
          await activePluginManager().configureSecret(await decodePluginSecret(input)),
        ),
      ),
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
  pluginSandbox?.terminate();
  pluginSandbox = undefined;
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
