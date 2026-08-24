import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeImage,
  Notification,
  Tray,
  type MessageBoxOptions,
  type OpenDialogOptions,
} from "electron";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CostUsageExportDTO,
  CostUsageQueryDTO,
  CostUsageQueryResultDTO,
  SpendDashboardDTO,
  SpendOverviewDTO,
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
  ActivateClaudeSwapAccountRequestDTO,
  ActivateClaudeSwapAccountResultDTO,
  SessionQuotaNotificationSettingsDTO,
  UpdateSessionQuotaNotificationSettingsRequestDTO,
  ExecuteLegacyImportRequestDTO,
  LegacyImportExecutionResultDTO,
  LegacyImportInspectionResultDTO,
  LegacyImportRollbackResultDTO,
  RollbackLegacyImportRequestDTO,
} from "@codexbar/contracts";
import {
  makeCredentialBrowserSessions,
  makeFetchHttpTransport,
  makeFirstPartyProviderRuntime,
  makeNativeCredentialStore,
  makeNodeFirstPartyLocalCapabilities,
  makeNodeGrokLocalTokenScanner,
  makeNodeDiscoveredProviderSettings,
  makeNodeConfigRepository,
  makeSystemClock,
  makeNodeSqliteWorkerPersistence,
  claudeSwapProcessEnvironment,
  makeNodePrivateFileStore,
  makeNodeProcessRunner,
  inspectNodeLegacyImport,
  executeNodeLegacyImport,
  rollbackNodeLegacyImport,
  resolveNodeClaudeOAuthHistoryOwner,
  type NodeSqliteWorkerPersistence,
} from "@codexbar/platform/node";
import {
  filterProvidersForClaudeBackgroundPolicy,
  makeNodeClaudeCliLocalCapability,
  recordClaudeCliUserInitiatedSuccess,
} from "@codexbar/platform/node-claude-cli";
import { makeDesktopNodePtyRunner } from "./node-pty-adapter.ts";
import {
  makeClaudeOAuthHistoryOwnerCapture,
  makeNodePlanUtilizationHistoryStore,
  selectedFirstPartyAccountFromConfig,
  type ClaudeOAuthHistoryOwnerCapture,
} from "@codexbar/platform";
import {
  Clock,
  CostUsageRepository,
  HistoryRepository,
  PlanUtilizationHistoryCoordinator,
  SessionQuotaCoordinator,
  makeDefaultCodexBarConfig,
  refreshProviderAndPersist,
  GROK_LOCAL_SESSION_TOKEN_SOURCE,
  XAI_DAILY_SPEND_SOURCE,
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
import { DesktopClaudeSwapController } from "./claude-swap.js";
import { DesktopAdaptiveRefreshController } from "./adaptive-refresh.js";
import { makeDesktopSessionQuotaNotificationAdapter } from "./session-quota-notifications.js";
import {
  sessionQuotaNotificationSettingsProjection,
  updateSessionQuotaNotificationSettings,
} from "./session-quota-notification-settings.js";
import {
  DesktopSpendPublisher,
  refreshGrokLocalTokensForSpend,
  type DesktopSpendConfiguration,
  type DesktopSpendProjection,
} from "./spend-overview.js";
import { DesktopPluginManager } from "./plugin-manager.js";
import { makePluginCredentialBrowserSessions } from "./plugin-browser-session.js";
import { makeElectronPluginSandbox } from "./plugin-sandbox-process.js";
import {
  DesktopConfigMutations,
  providerSettingsFor,
  providerSettingsProjection,
  providerSettingsSourcesForStrategies,
  updateSupportedFirstPartyProviderSettings,
} from "./provider-settings.js";
import { DesktopLegacyImportController } from "./legacy-import.js";
import { recordDesktopPlanUtilization } from "./plan-utilization-history.js";
import { loadTrayIcon } from "./tray-icon.js";
import { activateWindow } from "./single-instance.js";

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
let spendPublisher: DesktopSpendPublisher | undefined;
let claudeSwap: DesktopClaudeSwapController | undefined;
let grokLocalTokenScanner: ReturnType<typeof makeNodeGrokLocalTokenScanner> | undefined;
let legacyImport: DesktopLegacyImportController | undefined;
let adaptiveRefresh: DesktopAdaptiveRefreshController | undefined;
let planUtilizationHistory: PlanUtilizationHistoryCoordinator | undefined;
let claudeOAuthHistoryOwnerCapture: ClaudeOAuthHistoryOwnerCapture | undefined;
const sessionQuotaCoordinator = new SessionQuotaCoordinator();
const desktopConfigMutations = new DesktopConfigMutations();
const providerSettingsCapabilities = FIRST_PARTY_PROVIDERS.map((provider) => ({
  id: provider.descriptor.id,
  availableSources: providerSettingsSourcesForStrategies(
    provider.strategies ?? provider.descriptor.strategies ?? [provider],
  ),
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
const activeSpendPublisher = (): DesktopSpendPublisher => {
  if (spendPublisher === undefined) throw new Error("Desktop spend publication is not ready");
  return spendPublisher;
};
const activeClaudeSwap = (): DesktopClaudeSwapController => {
  if (claudeSwap === undefined) throw new Error("Claude Swap is not ready");
  return claudeSwap;
};
const activeGrokLocalTokenScanner = (): ReturnType<typeof makeNodeGrokLocalTokenScanner> => {
  if (grokLocalTokenScanner === undefined) throw new Error("Grok local token scanner is not ready");
  return grokLocalTokenScanner;
};
const activeLegacyImport = (): DesktopLegacyImportController => {
  if (legacyImport === undefined) throw new Error("Legacy import is not ready");
  return legacyImport;
};
const activePlanUtilizationHistory = (): PlanUtilizationHistoryCoordinator => {
  if (planUtilizationHistory === undefined)
    throw new Error("Plan-utilization history is not ready");
  return planUtilizationHistory;
};
const activeClaudeOAuthHistoryOwnerCapture = (): ClaudeOAuthHistoryOwnerCapture => {
  if (claudeOAuthHistoryOwnerCapture === undefined)
    throw new Error("Claude OAuth history owner capture is not ready");
  return claudeOAuthHistoryOwnerCapture;
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

const sessionQuotaProviderName = (providerId: (typeof PROVIDERS)[number]["id"]): string =>
  PROVIDERS.find((provider) => provider.id === providerId)?.name ?? providerId;

const sessionQuotaNotificationAdapter = makeDesktopSessionQuotaNotificationAdapter({
  nativeNotifications: {
    create: ({ title, body }) => new Notification({ title, body }),
  },
  providerName: sessionQuotaProviderName,
  locale: () => app.getLocale(),
});

/**
 * This runs only after a successful persisted refresh. Codex deliberately has
 * no owner key here: until the owner derivation is ported from the Swift
 * credential/account path, the core coordinator fails closed and emits no
 * Codex notification.
 */
const publishSessionQuotaNotification = (
  provider: (typeof PROVIDERS)[number]["id"],
  snapshot: UsageSnapshot,
): void => {
  const result = sessionQuotaCoordinator.observe({
    provider,
    snapshot,
    ...(desktopConfig?.sessionQuotaNotificationsEnabled === undefined
      ? {}
      : { notificationsEnabled: desktopConfig.sessionQuotaNotificationsEnabled }),
    now: new Date(),
  });
  if (result.notification === undefined) return;
  try {
    void Promise.resolve(sessionQuotaNotificationAdapter.notify(result.notification)).catch(() => {
      // Async native adapters are best effort for the same reason as their
      // synchronous counterparts below.
    });
  } catch {
    // Native permission/back-end failures never fail an otherwise successful
    // provider refresh and are never sent to renderer IPC.
  }
};

/**
 * Main-process-only background refresh. Failures stay provider-local and do
 * not surface their text through a renderer, console, or adaptive scheduler.
 */
const refreshEnabledProvidersInBackground = async (signal: AbortSignal): Promise<void> => {
  await Promise.all(
    filterProvidersForClaudeBackgroundPolicy(overviewProviders(), "background").map(
      async (provider) => {
        try {
          // Local Grok tokens are independent of the remote billing session;
          // retain that source even when the following web refresh fails.
          if (provider.id === "grok") await activeGrokLocalTokenScanner().refresh(signal);
          const outcome = await activeClaudeOAuthHistoryOwnerCapture().captureFetch(
            provider.id,
            () =>
              Effect.runPromise(
                refreshProviderAndPersist(activeProviderRuntime(), provider.id, {
                  sourceMode: provider.source,
                  includeCredits: false,
                }).pipe(
                  Effect.provideService(Clock, providerClock),
                  Effect.provideService(HistoryRepository, activePersistence().history),
                  Effect.provideService(CostUsageRepository, activePersistence().costs),
                ),
                { signal },
              ),
            signal,
          );
          if (!signal.aborted) {
            const claudeOAuthHistoryOwnerIdentifier =
              await activeClaudeOAuthHistoryOwnerCapture().consume(provider.id, outcome, signal);
            if (signal.aborted) throw new Error("Adaptive refresh was cancelled.");
            publishSessionQuotaNotification(provider.id, outcome.snapshot);
            await recordDesktopPlanUtilization({
              coordinator: activePlanUtilizationHistory(),
              providerId: provider.id,
              snapshot: outcome.snapshot,
              capturedAt: new Date(),
              signal,
              strategyId: outcome.strategyId,
              ...(claudeOAuthHistoryOwnerIdentifier === undefined
                ? {}
                : { claudeOAuthHistoryOwnerIdentifier }),
            });
          }
        } catch {
          // The provider refresh path owns classified errors. Avoid retaining
          // transport text here because it can contain sensitive context.
          if (signal.aborted) throw new Error("Adaptive refresh was cancelled.");
        }
      },
    ),
  );
};

/**
 * Only non-sensitive provider ownership participates in this digest. It
 * invalidates a reusable spend projection when enablement/source selection
 * changes without ever placing the original config or account data in IPC.
 */
const spendConfiguration = (): DesktopSpendConfiguration => {
  const enabled = overviewProviders().filter((provider) => provider.enabled);
  const fingerprintMaterial = enabled
    .map(
      (provider) => `${provider.id}\u0000${provider.source}\u0000${provider.enabled ? "1" : "0"}`,
    )
    .join("\u0000");
  return {
    ownershipFingerprint: createHash("sha256").update(fingerprintMaterial).digest("hex"),
    roster: enabled.map((provider) => ({
      id: provider.id,
      providerId: provider.id,
      displayName: provider.name,
      ...(provider.id === "xai" ? { dailySpendSourceKey: XAI_DAILY_SPEND_SOURCE } : {}),
      ...(provider.id === "grok" ? { dailySpendSourceKey: GROK_LOCAL_SESSION_TOKEN_SOURCE } : {}),
    })),
    requestedDays: 30,
  };
};

const loadSpendProjection = async (refresh: boolean): Promise<DesktopSpendProjection> => {
  const configuration = spendConfiguration();
  const publisher = activeSpendPublisher();
  // Grok local tokens are independent of the remote billing request. Refresh
  // them whenever this call will build a fresh spend projection, but never
  // let an unreadable local profile fail an IPC request or expose its path.
  if (refresh || publisher.current(configuration) === undefined)
    await refreshGrokLocalTokensForSpend(configuration, activeGrokLocalTokenScanner());
  return refresh
    ? publisher.refresh(configuration)
    : (publisher.current(configuration) ?? publisher.refresh(configuration));
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
  return loadTrayIcon({
    platform: process.platform,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    mainDirectory: currentDirectory,
    createFromPath: (path) => nativeImage.createFromPath(path),
  });
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    window = activateWindow(window, createWindow);
  });
}

const desktopReady = hasSingleInstanceLock ? app.whenReady() : undefined;
void desktopReady
  ?.then(async () => {
    const userDataPath = app.getPath("userData");
    const databasePath = join(userDataPath, "usage.sqlite");
    planUtilizationHistory = new PlanUtilizationHistoryCoordinator(
      makeNodePlanUtilizationHistoryStore({
        directoryPath: join(userDataPath, "history"),
      }),
    );
    await Effect.runPromise(planUtilizationHistory.load);
    persistence = await Effect.runPromise(
      makeNodeSqliteWorkerPersistence({
        databasePath,
        workerUrl: new URL(/* @vite-ignore */ "./sqlite-worker.js", import.meta.url),
      }),
    );
    spendPublisher = new DesktopSpendPublisher(persistence);
    grokLocalTokenScanner = makeNodeGrokLocalTokenScanner({ costs: persistence.costs });
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
    claudeOAuthHistoryOwnerCapture = makeClaudeOAuthHistoryOwnerCapture({
      resolveOwner: (signal) =>
        Effect.runPromise(
          resolveNodeClaudeOAuthHistoryOwner({
            credentialStore: credentials,
            environment: process.env,
          }),
          signal === undefined ? {} : { signal },
        ),
    });
    const processRunner = makeNodeProcessRunner();
    const baseLocal = makeNodeFirstPartyLocalCapabilities({ processRunner });
    providerRuntime = makeFirstPartyProviderRuntime({
      providers: FIRST_PARTY_PROVIDERS,
      settings: makeNodeDiscoveredProviderSettings(),
      credentials,
      browserSessions: makeCredentialBrowserSessions(credentials),
      selectedAccounts: {
        resolve: (providerId) =>
          Effect.sync(() => selectedFirstPartyAccountFromConfig(desktopConfig, providerId)),
      },
      local: {
        ...baseLocal,
        fetchClaudeCliUsage: makeNodeClaudeCliLocalCapability({
          processRunner,
          ptyRunner: makeDesktopNodePtyRunner(),
          userDataPath,
        }),
      },
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
    adaptiveRefresh = new DesktopAdaptiveRefreshController(
      {
        now: () => new Date(),
        sleep: (milliseconds, signal) =>
          new Promise<void>((resolve, reject) => {
            const cancel = () => {
              clearTimeout(timer);
              reject(new Error("Adaptive refresh was cancelled."));
            };
            const timer = setTimeout(() => {
              signal.removeEventListener("abort", cancel);
              resolve();
            }, milliseconds);
            signal.addEventListener("abort", cancel, { once: true });
          }),
        refresh: refreshEnabledProvidersInBackground,
        // Electron does not expose the OS low-power-mode state or thermal
        // pressure consistently across all three targets. Keep both neutral
        // until a dedicated platform adapter can supply the real semantics;
        // being on battery alone is not equivalent to low-power mode.
        signals: () => ({
          lowPowerModeEnabled: false,
          thermalPressure: "nominal",
        }),
      },
      { immediate: true },
    );
    adaptiveRefresh.start();
    claudeSwap = new DesktopClaudeSwapController({
      config: () => desktopConfig,
      processes: makeNodeProcessRunner({ environment: claudeSwapProcessEnvironment(process.env) }),
      files: makeNodePrivateFileStore(),
      retentionPath: join(app.getPath("userData"), "claude-swap-retained.json"),
    });
    legacyImport = new DesktopLegacyImportController({
      adapter: {
        inspect: (options) => Effect.runPromise(inspectNodeLegacyImport(options)),
        execute: (options) => Effect.runPromise(executeNodeLegacyImport(options)),
        rollback: (options) => Effect.runPromise(rollbackNodeLegacyImport(options)),
      },
      host: {
        selectLegacyRoot: async () => {
          const options: OpenDialogOptions = {
            title: "Select the copied CodexBar data directory",
            buttonLabel: "Inspect",
            properties: ["openDirectory"],
          };
          const selected =
            window === undefined
              ? await dialog.showOpenDialog(options)
              : await dialog.showOpenDialog(window, options);
          return selected.canceled ? undefined : selected.filePaths[0];
        },
        confirm: async (action, itemCount) => {
          const importing = action === "execute";
          const options: MessageBoxOptions = {
            type: "warning",
            title: importing ? "Import legacy CodexBar data?" : "Roll back legacy import?",
            message: importing
              ? `Copy ${itemCount} inspected item${itemCount === 1 ? "" : "s"} into CodexBar Multi?`
              : "Remove only data recorded in this CodexBar Multi import journal?",
            detail: importing
              ? "Credentials, browser sessions, approvals, iCloud, WidgetKit and Sparkle are never imported."
              : "The original Swift installation is never changed.",
            buttons: ["Cancel", importing ? "Import" : "Roll Back"],
            cancelId: 0,
            defaultId: 0,
            noLink: true,
          };
          const confirmed =
            window === undefined
              ? await dialog.showMessageBox(options)
              : await dialog.showMessageBox(window, options);
          return confirmed.response === 1;
        },
      },
      paths: {
        destinationRoot: userDataPath,
        databasePath,
        targetConfigPath: join(userDataPath, "config.json"),
        targetPluginsPath: join(userDataPath, "plugins"),
      },
      nextOpaqueId: randomUUID,
    });
    const decodeVoid = Schema.decodeUnknownPromise(Schema.Void);
    const decodeOverview = Schema.decodeUnknownPromise(DashboardSnapshotDTO);
    const decodeHistoryQuery = Schema.decodeUnknownPromise(HistoryQueryDTO);
    const decodeHistoryResult = Schema.decodeUnknownPromise(HistoryQueryResultDTO);
    const decodeHistoryExport = Schema.decodeUnknownPromise(HistoryExportDTO);
    const decodeCostQuery = Schema.decodeUnknownPromise(CostUsageQueryDTO);
    const decodeCostResult = Schema.decodeUnknownPromise(CostUsageQueryResultDTO);
    const decodeCostExport = Schema.decodeUnknownPromise(CostUsageExportDTO);
    const decodeSpendOverview = Schema.decodeUnknownPromise(SpendOverviewDTO);
    const decodeSpendDashboard = Schema.decodeUnknownPromise(SpendDashboardDTO);
    const decodeLogin = Schema.decodeUnknownPromise(LoginRequestDTO);
    const decodeLoginResult = Schema.decodeUnknownPromise(LoginResultDTO);
    const decodeRefresh = Schema.decodeUnknownPromise(RefreshProviderRequestDTO);
    const decodeRefreshResult = Schema.decodeUnknownPromise(RefreshProviderResultDTO);
    const decodeActivateClaudeSwapAccount = Schema.decodeUnknownPromise(
      ActivateClaudeSwapAccountRequestDTO,
    );
    const decodeActivateClaudeSwapAccountResult = Schema.decodeUnknownPromise(
      ActivateClaudeSwapAccountResultDTO,
    );
    const decodeProviderSettings = Schema.decodeUnknownPromise(ProviderSettingsDTO);
    const decodeProviderSettingsList = Schema.decodeUnknownPromise(ProviderSettingsListDTO);
    const decodeUpdateProviderSettings = Schema.decodeUnknownPromise(
      UpdateProviderSettingsRequestDTO,
    );
    const decodeSessionQuotaNotificationSettings = Schema.decodeUnknownPromise(
      SessionQuotaNotificationSettingsDTO,
    );
    const decodeUpdateSessionQuotaNotificationSettings = Schema.decodeUnknownPromise(
      UpdateSessionQuotaNotificationSettingsRequestDTO,
    );
    const decodeLegacyImportInspection = Schema.decodeUnknownPromise(
      LegacyImportInspectionResultDTO,
    );
    const decodeExecuteLegacyImport = Schema.decodeUnknownPromise(ExecuteLegacyImportRequestDTO);
    const decodeLegacyImportExecution = Schema.decodeUnknownPromise(LegacyImportExecutionResultDTO);
    const decodeRollbackLegacyImport = Schema.decodeUnknownPromise(RollbackLegacyImportRequestDTO);
    const decodeLegacyImportRollback = Schema.decodeUnknownPromise(LegacyImportRollbackResultDTO);
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
        const accounts = await activeClaudeSwap().refreshForOverview();
        return decodeOverview(
          await loadPersistedOverview(
            activePersistence(),
            () => new Date(),
            overviewProviders(),
            accounts,
          ),
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
    ipcMain.handle(DesktopChannels.spendOverview, (_event, input: unknown) =>
      handleDesktopRequest(async () => {
        await decodeVoid(input);
        return decodeSpendOverview((await loadSpendProjection(true)).overview);
      }),
    );
    ipcMain.handle(DesktopChannels.spendDashboard, (_event, input: unknown) =>
      handleDesktopRequest(async () => {
        await decodeVoid(input);
        return decodeSpendDashboard((await loadSpendProjection(false)).dashboard);
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
        adaptiveRefresh?.noteMenuOpen();
        // Persist local Grok token activity before the remote billing request:
        // a web/session failure must not erase independently readable logs.
        if (request.provider === "grok") {
          await activeGrokLocalTokenScanner()
            .refresh()
            .catch(() => undefined);
        }
        const outcome = await activeClaudeOAuthHistoryOwnerCapture().captureFetch(
          request.provider,
          () =>
            Effect.runPromise(
              refreshProviderAndPersist(activeProviderRuntime(), request.provider, {
                sourceMode: request.source ?? "auto",
                includeCredits: true,
              }).pipe(
                Effect.provideService(Clock, providerClock),
                Effect.provideService(HistoryRepository, activePersistence().history),
                Effect.provideService(CostUsageRepository, activePersistence().costs),
              ),
            ),
        );
        if (request.provider === "claude" && outcome.strategyId === "claude.cli") {
          recordClaudeCliUserInitiatedSuccess();
        }
        const claudeOAuthHistoryOwnerIdentifier =
          await activeClaudeOAuthHistoryOwnerCapture().consume(request.provider, outcome);
        publishSessionQuotaNotification(request.provider, outcome.snapshot);
        await recordDesktopPlanUtilization({
          coordinator: activePlanUtilizationHistory(),
          providerId: request.provider,
          snapshot: outcome.snapshot,
          capturedAt: new Date(),
          strategyId: outcome.strategyId,
          ...(claudeOAuthHistoryOwnerIdentifier === undefined
            ? {}
            : { claudeOAuthHistoryOwnerIdentifier }),
        });
        return decodeRefreshResult({
          provider: request.provider,
          strategyId: outcome.strategyId,
          source: outcome.source,
          snapshot: outcome.snapshot,
        });
      }),
    );
    ipcMain.handle(DesktopChannels.activateClaudeSwapAccount, (_event, input: unknown) =>
      handleDesktopRequest(async () => {
        const request = await decodeActivateClaudeSwapAccount(input);
        const result = await activeClaudeSwap().activate(request.accountId);
        // The external tool owns the credential. Refreshing the ambient Claude
        // snapshot is best effort; the subsequent account listing is already
        // verified and replaces any stale active-row presentation.
        const outcome = await Effect.runPromise(
          refreshProviderAndPersist(activeProviderRuntime(), "claude", {
            sourceMode: "auto",
            includeCredits: true,
          }).pipe(
            Effect.provideService(Clock, providerClock),
            Effect.provideService(HistoryRepository, activePersistence().history),
            Effect.provideService(CostUsageRepository, activePersistence().costs),
            Effect.orElseSucceed(() => undefined),
          ),
        );
        if (outcome !== undefined) publishSessionQuotaNotification("claude", outcome.snapshot);
        return decodeActivateClaudeSwapAccountResult({
          provider: "claude",
          accountId: result.accountId,
          switched: result.switched,
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
    ipcMain.handle(DesktopChannels.getSessionQuotaNotificationSettings, (_event, input: unknown) =>
      handleDesktopRequest(async () => {
        await decodeVoid(input);
        const current = desktopConfig;
        if (current === undefined) throw new Error("Desktop config is not ready");
        return decodeSessionQuotaNotificationSettings(
          sessionQuotaNotificationSettingsProjection(current),
        );
      }),
    );
    ipcMain.handle(
      DesktopChannels.updateSessionQuotaNotificationSettings,
      (_event, input: unknown) =>
        handleDesktopRequest(async () => {
          const request = await decodeUpdateSessionQuotaNotificationSettings(input);
          const saved = await mutateDesktopConfig(async (current) => {
            const next = updateSessionQuotaNotificationSettings(current, request);
            return { next, value: next };
          });
          return decodeSessionQuotaNotificationSettings(
            sessionQuotaNotificationSettingsProjection(saved),
          );
        }),
    );
    ipcMain.handle(DesktopChannels.inspectLegacyImport, (_event, input: unknown) =>
      handleDesktopRequest(async () => {
        await decodeVoid(input);
        return decodeLegacyImportInspection(await activeLegacyImport().inspect());
      }),
    );
    ipcMain.handle(DesktopChannels.executeLegacyImport, (_event, input: unknown) =>
      handleDesktopRequest(async () =>
        decodeLegacyImportExecution(
          await activeLegacyImport().execute(await decodeExecuteLegacyImport(input)),
        ),
      ),
    );
    ipcMain.handle(DesktopChannels.rollbackLegacyImport, (_event, input: unknown) =>
      handleDesktopRequest(async () =>
        decodeLegacyImportRollback(
          await activeLegacyImport().rollback(await decodeRollbackLegacyImport(input)),
        ),
      ),
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
      adaptiveRefresh?.noteMenuOpen();
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
  adaptiveRefresh?.stop();
  adaptiveRefresh = undefined;
  legacyImport?.cancel();
  legacyImport = undefined;
  spendPublisher?.cancel();
  spendPublisher = undefined;
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
