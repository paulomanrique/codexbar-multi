import { BrowserWindow, session as electronSession, type Session } from "electron";
import { Effect } from "effect";
import type { LoginRequestDTO, LoginResultDTO } from "@codexbar/contracts";
import { makeNativeCredentialStore } from "@codexbar/platform/node";
import {
  browserLoginDescriptor,
  exportableCookieHeader,
  isAllowedBrowserLoginNavigation,
  type BrowserLoginDescriptor,
} from "./browser-session-policy.js";

const credentials = makeNativeCredentialStore();
const activeLogins = new Map<string, BrowserWindow>();

const keyFor = ({ provider, accountId }: LoginRequestDTO) => `${provider}/${accountId}`;
const credentialKeyFor = ({ provider, accountId }: LoginRequestDTO) =>
  `browser-session/${provider}/${accountId}`;
const partitionFor = ({ provider, accountId }: LoginRequestDTO) =>
  `persist:codexbar-multi-${provider}-${accountId}`;

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
  window.webContents.on("did-create-window", (child) => protectNavigation(child, descriptor));
}

function hardenSession(session: Session): void {
  session.setPermissionCheckHandler(() => false);
  session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.on("will-download", (event) => event.preventDefault());
}

async function exportedCookieHeaders(
  session: Session,
  descriptor: BrowserLoginDescriptor,
): Promise<Readonly<Record<string, string>>> {
  const result: Record<string, string> = {};
  for (const domain of descriptor.cookieDomains) {
    // URL filtering preserves Electron's host-only/domain/path eligibility. A
    // cookie observed on www.t3.chat is never folded into the t3.chat header.
    const cookies = await session.cookies.get({ url: `https://${domain}/` });
    const header = exportableCookieHeader(descriptor, cookies);
    if (header !== undefined) result[domain] = header;
  }
  return result;
}

export async function startBrowserLogin(request: LoginRequestDTO): Promise<LoginResultDTO> {
  const descriptor = browserLoginDescriptor(request.provider);
  if (descriptor === undefined)
    throw new Error(`Interactive login is not declared for '${request.provider}'`);
  const loginKey = keyFor(request);
  const existing = activeLogins.get(loginKey);
  if (existing !== undefined) {
    existing.focus();
    throw new Error("A login window is already active for this account");
  }

  const isolatedSession = electronSession.fromPartition(partitionFor(request), { cache: true });
  hardenSession(isolatedSession);
  const loginWindow = new BrowserWindow({
    width: 520,
    height: 760,
    title: `Sign in — ${request.provider}`,
    webPreferences: {
      session: isolatedSession,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  activeLogins.set(loginKey, loginWindow);
  protectNavigation(loginWindow, descriptor);

  return new Promise<LoginResultDTO>((resolve, reject) => {
    let settled = false;
    const changed = () => {
      void exportedCookieHeaders(isolatedSession, descriptor)
        .then(async (cookieHeaders) => {
          if (Object.keys(cookieHeaders).length === 0 || settled) return;
          await Effect.runPromise(
            credentials.write(
              credentialKeyFor(request),
              JSON.stringify({
                version: 1,
                provider: request.provider,
                accountId: request.accountId,
                cookieHeaders,
                exportedAt: new Date().toISOString(),
              }),
            ),
          );
          finish("connected");
          if (!loginWindow.isDestroyed()) loginWindow.close();
        })
        .catch((cause: unknown) => {
          if (settled) return;
          settled = true;
          activeLogins.delete(loginKey);
          reject(
            new Error(
              "Could not persist the authenticated browser session in the native credential store",
              { cause },
            ),
          );
          if (!loginWindow.isDestroyed()) loginWindow.close();
        });
    };
    const finish = (status: LoginResultDTO["status"]) => {
      if (settled) return;
      settled = true;
      activeLogins.delete(loginKey);
      isolatedSession.cookies.off("changed", changed);
      resolve({ provider: request.provider, accountId: request.accountId, status });
    };
    isolatedSession.cookies.on("changed", changed);
    loginWindow.on("closed", () => finish("cancelled"));
    void loginWindow.loadURL(descriptor.startUrl).catch((cause: unknown) => {
      if (!settled) {
        settled = true;
        activeLogins.delete(loginKey);
        isolatedSession.cookies.off("changed", changed);
        reject(new Error("Could not open the provider login page", { cause }));
      }
      if (!loginWindow.isDestroyed()) loginWindow.close();
    });
  });
}

export function cancelBrowserLogin(request: LoginRequestDTO): void {
  activeLogins.get(keyFor(request))?.close();
}

export async function logoutBrowserSession(request: LoginRequestDTO): Promise<void> {
  cancelBrowserLogin(request);
  await electronSession.fromPartition(partitionFor(request), { cache: true }).clearStorageData();
  await Effect.runPromise(credentials.remove(credentialKeyFor(request)));
}
