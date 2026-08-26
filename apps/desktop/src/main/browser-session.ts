import { BrowserWindow, session as electronSession, type Session } from "electron";
import { Effect } from "effect";
import type { LoginRequestDTO, LoginResultDTO, ProviderId } from "@codexbar/contracts";
import { InfrastructureError } from "@codexbar/core";
import { makeNativeCredentialStore } from "@codexbar/platform/node";
import type { BrowserSessionCleanupAdapter } from "@codexbar/platform";
import {
  BrowserLoginController,
  browserSessionPartition,
  legacyBrowserSessionPartition,
  requireDefaultBrowserLoginRequest,
  type BrowserLoginCredentialValidator,
  type BrowserLoginSession,
  type BrowserLoginWindow,
} from "./browser-session-controller.js";
import {
  browserLoginDescriptor,
  isAllowedBrowserLoginNavigation,
  type BrowserLoginDescriptor,
} from "./browser-session-policy.js";

const credentials = makeNativeCredentialStore();
const hardenedSessions = new WeakSet<Session>();

function protectNavigation(window: BrowserWindow, descriptor: BrowserLoginDescriptor): void {
  window.webContents.setWindowOpenHandler(({ url }) =>
    isAllowedBrowserLoginNavigation(descriptor, url)
      ? {
          action: "allow",
          overrideBrowserWindowOptions: {
            webPreferences: {
              session: window.webContents.session,
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: true,
            },
          },
        }
      : { action: "deny" },
  );
  const rejectUnknown = (event: Electron.Event, url: string) => {
    if (!isAllowedBrowserLoginNavigation(descriptor, url)) event.preventDefault();
  };
  window.webContents.on("will-navigate", rejectUnknown);
  window.webContents.on("will-redirect", rejectUnknown);
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.on("did-create-window", (child) => protectNavigation(child, descriptor));
}

function hardenSession(session: Session): void {
  if (hardenedSessions.has(session)) return;
  hardenedSessions.add(session);
  session.setPermissionCheckHandler(() => false);
  session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.on("will-download", (event) => event.preventDefault());
}

const sessionFacade = (
  session: Session,
  cleanupSessions: readonly Session[] = [session],
): BrowserLoginSession => ({
  cookiesFor: (domain) => session.cookies.get({ url: `https://${domain}/` }),
  onCookiesChanged: (listener) => session.cookies.on("changed", listener),
  offCookiesChanged: (listener) => session.cookies.off("changed", listener),
  clear: async () => {
    const results = await Promise.allSettled(
      cleanupSessions.map((candidate) => candidate.clearStorageData()),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  },
});

const windowFacade = (window: BrowserWindow): BrowserLoginWindow => ({
  focus: () => window.focus(),
  close: () => window.close(),
  destroy: () => window.destroy(),
  isDestroyed: () => window.isDestroyed(),
  load: (url) => window.loadURL(url),
  onClosed: (listener) => window.on("closed", listener),
});

const loginController = new BrowserLoginController({
  sessionFor: (request) => {
    const primary = electronSession.fromPartition(browserSessionPartition(request), {
      cache: true,
    });
    const legacyPartition = legacyBrowserSessionPartition(request);
    const cleanupSessions = [
      primary,
      ...(legacyPartition === undefined
        ? []
        : [electronSession.fromPartition(legacyPartition, { cache: true })]),
    ];
    for (const candidate of cleanupSessions) hardenSession(candidate);
    return sessionFacade(primary, cleanupSessions);
  },
  createWindow: (request, descriptor, _session) => {
    const nativeSession = electronSession.fromPartition(browserSessionPartition(request), {
      cache: true,
    });
    const loginWindow = new BrowserWindow({
      width: 520,
      height: 760,
      title: `Sign in — ${request.provider}`,
      webPreferences: {
        session: nativeSession,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    protectNavigation(loginWindow, descriptor);
    return windowFacade(loginWindow);
  },
  persistCredential: (key, value) => Effect.runPromise(credentials.write(key, value)),
  readCredential: (key) => Effect.runPromise(credentials.read(key)),
  removeCredential: (key) => Effect.runPromise(credentials.remove(key)),
  now: () => new Date(),
});

export const startBrowserLogin = (request: LoginRequestDTO): Promise<LoginResultDTO> =>
  loginController.start(requireDefaultBrowserLoginRequest(request));

export const cancelBrowserLogin = (request: LoginRequestDTO): void =>
  loginController.cancel(requireDefaultBrowserLoginRequest(request));

/** Host-only account-scoped login used by provider-specific authorization flows. */
export const startAccountBrowserLogin = (
  request: LoginRequestDTO,
  validateCredential: BrowserLoginCredentialValidator,
): Promise<LoginResultDTO> => loginController.start(request, validateCredential);

/** Host-only account-scoped cancellation; never exposed as generic renderer IPC. */
export const cancelAccountBrowserLogin = (request: LoginRequestDTO): void =>
  loginController.cancel(request);

export const logoutBrowserSession = (request: LoginRequestDTO): Promise<void> =>
  browserLoginDescriptor(request.provider) === undefined
    ? Promise.reject(new Error("Interactive login is not declared for this provider"))
    : loginController.logout(requireDefaultBrowserLoginRequest(request));

/** Host-only recovery entrypoint. It never crosses preload/renderer IPC. */
export const cleanupBrowserSession = (request: LoginRequestDTO): Promise<void> =>
  loginController.logout(request);

export const desktopBrowserSessionCleanupAdapter: BrowserSessionCleanupAdapter = {
  cleanup: ({
    providerId,
    accountId,
  }: {
    readonly providerId: ProviderId;
    readonly accountId: string;
  }) =>
    Effect.tryPromise({
      try: () => cleanupBrowserSession({ provider: providerId, accountId }),
      catch: (cause) =>
        new InfrastructureError("clean browser session", "Browser-session cleanup failed.", cause),
    }),
};
