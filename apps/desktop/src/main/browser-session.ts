import { BrowserWindow, session as electronSession, type Session } from "electron";
import { Effect } from "effect";
import type { LoginRequestDTO, LoginResultDTO } from "@codexbar/contracts";
import { makeNativeCredentialStore } from "@codexbar/platform/node";
import {
  BrowserLoginController,
  browserSessionPartition,
  type BrowserLoginSession,
  type BrowserLoginWindow,
} from "./browser-session-controller.js";
import {
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

const sessionFacade = (session: Session): BrowserLoginSession => ({
  cookiesFor: (domain) => session.cookies.get({ url: `https://${domain}/` }),
  onCookiesChanged: (listener) => session.cookies.on("changed", listener),
  offCookiesChanged: (listener) => session.cookies.off("changed", listener),
  clear: () => session.clearStorageData(),
});

const windowFacade = (window: BrowserWindow): BrowserLoginWindow => ({
  focus: () => window.focus(),
  close: () => window.close(),
  isDestroyed: () => window.isDestroyed(),
  load: (url) => window.loadURL(url),
  onClosed: (listener) => window.on("closed", listener),
});

const loginController = new BrowserLoginController({
  sessionFor: (request) => {
    const session = electronSession.fromPartition(browserSessionPartition(request), {
      cache: true,
    });
    hardenSession(session);
    return sessionFacade(session);
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
  removeCredential: (key) => Effect.runPromise(credentials.remove(key)),
  now: () => new Date(),
});

export const startBrowserLogin = (request: LoginRequestDTO): Promise<LoginResultDTO> =>
  loginController.start(request);

export const cancelBrowserLogin = (request: LoginRequestDTO): void =>
  loginController.cancel(request);

export const logoutBrowserSession = (request: LoginRequestDTO): Promise<void> =>
  loginController.logout(request);
