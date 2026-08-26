import { describe, expect, it } from "vite-plus/test";
import { readFile } from "node:fs/promises";

describe("main wiring for visible startup shell", () => {
  it("creates window/tray/status-handler before persistence and never app.exit(1) on bootstrap failure", async () => {
    const source = await readFile(new URL("../src/main/index.ts", import.meta.url), "utf8");

    const hostStatusIndex = source.indexOf("DesktopChannels.hostStatus");
    const createWindowIndex = source.indexOf("createWindow()");
    const trayIndex = source.indexOf("new Tray(");
    const persistenceIndex = source.indexOf("makeNodeSqliteWorkerPersistence({");
    expect(hostStatusIndex).toBeGreaterThan(-1);
    expect(createWindowIndex).toBeGreaterThan(-1);
    expect(trayIndex).toBeGreaterThan(-1);
    expect(persistenceIndex).toBeGreaterThan(-1);
    // status handler and window/tray must occur before persistence
    expect(hostStatusIndex).toBeLessThan(persistenceIndex);
    expect(createWindowIndex).toBeLessThan(persistenceIndex);
    expect(trayIndex).toBeLessThan(persistenceIndex);

    // No app.exit(1) in bootstrap catch
    expect(source).not.toContain("app.exit(1)");
    // tray.destroy must be present for failure and before-quit
    expect(source).toContain("tray?.destroy()");
    expect(source).toContain("destroy()");

    // Isolation flags unchanged
    expect(source).toContain("contextIsolation: true");
    expect(source).toContain("nodeIntegration: false");
    expect(source).toContain("sandbox: true");
    // denies navigation/window-open and uses preload
    expect(source).toContain("setWindowOpenHandler");
    expect(source).toContain("will-navigate");
    expect(source).toContain("preload");

    // startup visibly deterministic with show:true and dark background
    expect(source).toContain("show: true");
    expect(source).toContain("backgroundColor");
    expect(source).toContain("#090b10");
    expect(source).not.toContain("ready-to-show");

    // second-instance still uses activateWindow
    expect(source).toContain("activateWindow");
    expect(source).toContain("second-instance");

    // hostStatus handler registered before loading renderer (before loadFile)
    const loadFileIndex = source.indexOf("loadFile");
    expect(hostStatusIndex).toBeLessThan(loadFileIndex);

    // tray creation is best-effort try/catch and Starting tooltip
    expect(source).toContain("Starting");
    expect(source).toContain("try {");
    expect(source).toContain("new Tray");

    // shell failure uses fixed redacted dialog.showErrorBox and app.quit(), never raw cause
    expect(source).toContain("dialog.showErrorBox");
    expect(source).toContain("The window could not be created");
    expect(source).not.toMatch(/showErrorBox.*cause/);

    // failure logs only safe stage token
    expect(source).toContain("bootstrap failed at stage");
    // ensure no raw cause logging in that block (search near)
    const failureBlock = source.slice(
      source.indexOf("bootstrap failed at stage") - 200,
      source.indexOf("bootstrap failed at stage") + 800,
    );
    expect(failureBlock).not.toContain("cause");
    expect(failureBlock).not.toContain("message");

    // window-all-closed quits only in failed phase
    expect(source).toContain("window-all-closed");
    expect(source).toContain('status === "failed"');
    expect(source).toContain("app.quit()");

    // before-quit destroys tray
    expect(source).toContain("before-quit");
    expect(source).toContain("tray?.destroy");

    // second-instance always reuses same window (activateWindow with existing window var)
    expect(source).toMatch(/activateWindow\s*\(\s*window/);
  });

  it("installs tray click handler once with starting vs ready behavior", async () => {
    const source = await readFile(new URL("../src/main/index.ts", import.meta.url), "utf8");
    // handler is installed once after tray creation
    const trayOnClickMatches = (source.match(/tray\.on\("click"/g) ?? []).length;
    expect(trayOnClickMatches).toBe(1);
    // starting branch only shows/focuses, never hide
    expect(source).toContain('status === "starting"');
    // ready branch contains hide/show toggle and noteMenuOpen
    expect(source).toContain("noteMenuOpen");
    expect(source).toContain("window.hide()");
  });

  it("publishes overview invalidation as one channel-only background event", async () => {
    const source = await readFile(new URL("../src/main/index.ts", import.meta.url), "utf8");
    expect(source).toContain("refreshOverviewAndPublish");
    expect(source).toContain("refresh: (signal) =>");
    expect(source).toContain("signal,");
    expect(source).toContain("refresh: refreshEnabledProvidersInBackground");
    expect(source).toContain("publish: publishOverviewUpdated");
    expect(source).toContain("{ immediate: true }");
    expect(source).toContain("webContents.send(DesktopChannels.overviewUpdated);");
    expect(source).not.toContain("webContents.send(DesktopChannels.overviewUpdated,");
    expect(source).not.toContain("OverviewUpdatedDTO");
  });

  it("derives selected accounts and persisted provider settings from one config generation", async () => {
    const source = await readFile(new URL("../src/main/index.ts", import.meta.url), "utf8");
    const runtimeStart = source.indexOf("providerRuntime = makeFirstPartyProviderRuntime({");
    const runtimeEnd = source.indexOf("adaptiveRefresh =", runtimeStart);
    const runtimeBlock = source.slice(runtimeStart, runtimeEnd);
    expect(runtimeBlock).toContain("resolveFetchState: (providerId) =>");
    expect(runtimeBlock.match(/configRepository\.load/g)).toHaveLength(1);
    expect(runtimeBlock).toContain("(capturedConfig) =>");
    expect(runtimeBlock).toContain("makePersistedFirstPartySettings(");
    expect(runtimeBlock).toContain("resolveSelectedFirstPartyAccountFromVault(");
    expect(runtimeBlock).not.toContain("selectedAccounts:");
  });

  it("wires Codex browser-session IPC through exact DTOs and crash-safe publication", async () => {
    const source = await readFile(new URL("../src/main/index.ts", import.meta.url), "utf8");
    for (const [channel, keys] of [
      ["startCodexBrowserSession", '["accountId", "expectedRevision"]'],
      ["cancelCodexBrowserSession", '["accountId"]'],
      ["logoutCodexBrowserSession", '["accountId", "expectedRevision"]'],
      ["getCodexBrowserSessionStatuses", '["expectedRevision"]'],
    ] as const) {
      const start = source.indexOf(`DesktopChannels.${channel}`);
      expect(start).toBeGreaterThan(-1);
      expect(source.slice(start, start + 800)).toContain("decodeExactDesktopRecord");
      expect(source.slice(start, start + 800)).toContain(keys);
    }
    expect(source).toContain("stageValidatedCodexBrowserSessionCredential(");
    expect(source).toContain("commitCodexBrowserSessionCredential(");
    expect(source).toContain('browserCredentialKey({ provider: "codex", accountId })');
    expect(source).toContain("browserSessionController?.cancelAll()");
    expect(source).toContain("browserSessionController?.cancelAll())");
  });

  it("enforces startup lifecycle hardening from independent review", async () => {
    const source = await readFile(new URL("../src/main/index.ts", import.meta.url), "utf8");

    // (1) shell reuses live window via activateWindow and closed clears only if window === created
    expect(source).toContain('from "./host-lifecycle.js"');
    expect(source).not.toContain('from "./host-lifecycle.ts"');
    expect(source).toContain("if (window === created) window = undefined");
    expect(source).toContain("window = activateWindow(window, createWindow)");

    // (2) starting tray click recreates missing/destroyed window with safe dialog fallback
    const startingClickIndex = source.indexOf('status === "starting"');
    const startingClickBlock = source.slice(startingClickIndex, startingClickIndex + 800);
    expect(startingClickBlock).toContain("activateWindow(window, createWindow)");
    expect(startingClickBlock).toContain("The window could not be created");

    // failure handling recreates visible window if closed during starting; if recreation throws, safe dialog and quit
    const failureRecreateIndex = source.indexOf("bootstrap failed at stage");
    const failureBlock = source.slice(failureRecreateIndex, failureRecreateIndex + 1500);
    // must contain recreation branch for missing/destroyed window
    expect(failureBlock).toContain("window === undefined || window.isDestroyed()");
    // tray destroy occurs immediately after marking failed, before any awaited persistence.close
    const markFailedIndex = source.indexOf("markFailed", failureRecreateIndex);
    const trayDestroyIndex = source.indexOf("tray?.destroy()", markFailedIndex);
    const persistenceCloseIndex = source.indexOf("persistence.close", markFailedIndex);
    const failureWindowIndex = source.indexOf(
      "activateWindow(window, createWindow)",
      markFailedIndex,
    );
    expect(markFailedIndex).toBeGreaterThan(-1);
    expect(trayDestroyIndex).toBeGreaterThan(markFailedIndex);
    expect(failureWindowIndex).toBeGreaterThan(trayDestroyIndex);
    if (persistenceCloseIndex !== -1) {
      expect(trayDestroyIndex).toBeLessThan(persistenceCloseIndex);
      expect(failureWindowIndex).toBeLessThan(persistenceCloseIndex);
    }

    // (4) markReady occurs only after post-success tray/window operations that can throw
    const markReadyIndex = source.indexOf("hostLifecycle.markReady()");
    const setToolTipIndex = source.indexOf('tray?.setToolTip("CodexBar Multi")', 0);
    const windowShowIndex = source.indexOf("window.show()", setToolTipIndex);
    expect(markReadyIndex).toBeGreaterThan(setToolTipIndex);
    expect(markReadyIndex).toBeGreaterThan(windowShowIndex);
  });
});
