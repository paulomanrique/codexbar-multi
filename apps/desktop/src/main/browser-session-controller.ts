import type { LoginRequestDTO, LoginResultDTO } from "@codexbar/contracts";
import {
  browserLoginDescriptor,
  exportableCookieHeader,
  type BrowserCookieValue,
  type BrowserLoginDescriptor,
} from "./browser-session-policy.js";

export interface BrowserLoginSession {
  readonly cookiesFor: (domain: string) => Promise<readonly BrowserCookieValue[]>;
  readonly onCookiesChanged: (listener: () => void) => void;
  readonly offCookiesChanged: (listener: () => void) => void;
  readonly clear: () => Promise<void>;
}

export interface BrowserLoginWindow {
  readonly focus: () => void;
  readonly close: () => void;
  readonly isDestroyed: () => boolean;
  readonly load: (url: string) => Promise<void>;
  readonly onClosed: (listener: () => void) => void;
}

export interface BrowserLoginHost {
  readonly sessionFor: (request: LoginRequestDTO) => BrowserLoginSession;
  readonly createWindow: (
    request: LoginRequestDTO,
    descriptor: BrowserLoginDescriptor,
    session: BrowserLoginSession,
  ) => BrowserLoginWindow;
  readonly persistCredential: (key: string, value: string) => Promise<void>;
  readonly removeCredential: (key: string) => Promise<void>;
  readonly now: () => Date;
}

interface ActiveLogin {
  readonly window: BrowserLoginWindow;
  readonly session: BrowserLoginSession;
  readonly close: () => void;
  pendingPersistence: Promise<void> | undefined;
  cancelled: boolean;
}

export const browserLoginKey = ({ provider, accountId }: LoginRequestDTO) =>
  `${provider}/${accountId}`;
export const browserCredentialKey = ({ provider, accountId }: LoginRequestDTO) =>
  `browser-session/${provider}/${accountId}`;
export const browserSessionPartition = ({ provider, accountId }: LoginRequestDTO) =>
  `persist:codexbar-multi-${provider}-${accountId}`;

export const browserCredentialPayload = (
  request: LoginRequestDTO,
  cookieHeaders: Readonly<Record<string, string>>,
  exportedAt: Date,
) =>
  JSON.stringify({
    version: 1,
    provider: request.provider,
    accountId: request.accountId,
    cookieHeaders,
    exportedAt: exportedAt.toISOString(),
  });

const exportedCookieHeaders = async (
  session: BrowserLoginSession,
  descriptor: BrowserLoginDescriptor,
): Promise<Readonly<Record<string, string>>> => {
  const result: Record<string, string> = {};
  for (const domain of descriptor.cookieDomains) {
    const header = exportableCookieHeader(descriptor, await session.cookiesFor(domain));
    if (header !== undefined) result[domain] = header;
  }
  return result;
};

/**
 * Lifecycle state is intentionally Electron-free. The Electron composition
 * supplies a sandboxed BrowserWindow and a partitioned Session; tests supply
 * fakes and can exercise every state transition without opening a browser.
 */
export class BrowserLoginController {
  readonly #active = new Map<string, ActiveLogin>();
  readonly #host: BrowserLoginHost;

  constructor(host: BrowserLoginHost) {
    this.#host = host;
  }

  async start(request: LoginRequestDTO): Promise<LoginResultDTO> {
    const descriptor = browserLoginDescriptor(request.provider);
    if (descriptor === undefined)
      throw new Error(`Interactive login is not declared for '${request.provider}'`);
    const key = browserLoginKey(request);
    const existing = this.#active.get(key);
    if (existing !== undefined) {
      existing.window.focus();
      throw new Error("A login window is already active for this account");
    }

    const session = this.#host.sessionFor(request);
    const window = this.#host.createWindow(request, descriptor, session);
    return new Promise<LoginResultDTO>((resolve, reject) => {
      let settled = false;
      let persisting = false;
      let pendingCookieChange = false;
      const active: ActiveLogin = {
        window,
        session,
        pendingPersistence: undefined,
        cancelled: false,
        close: () => finish("cancelled"),
      };
      const isCurrent = () => this.#active.get(key) === active && !active.cancelled;
      const finish = (status: LoginResultDTO["status"]) => {
        if (settled) return;
        settled = true;
        session.offCookiesChanged(changed);
        this.#active.delete(key);
        resolve({ provider: request.provider, accountId: request.accountId, status });
      };
      const fail = (message: string, cause: unknown) => {
        if (settled) return;
        settled = true;
        session.offCookiesChanged(changed);
        this.#active.delete(key);
        reject(new Error(message, { cause }));
      };
      const changed = () => {
        if (!isCurrent() || settled) return;
        pendingCookieChange = true;
        if (persisting) return;
        persisting = true;
        active.pendingPersistence = (async () => {
          while (pendingCookieChange && isCurrent() && !settled) {
            pendingCookieChange = false;
            const cookieHeaders = await exportedCookieHeaders(session, descriptor);
            if (Object.keys(cookieHeaders).length === 0) continue;
            await this.#host.persistCredential(
              browserCredentialKey(request),
              browserCredentialPayload(request, cookieHeaders, this.#host.now()),
            );
            if (!isCurrent() || settled) {
              await this.#host.removeCredential(browserCredentialKey(request));
              return;
            }
            finish("connected");
            if (!window.isDestroyed()) window.close();
          }
        })()
          .catch(async (cause: unknown) => {
            if (!isCurrent() || settled) return;
            try {
              await session.clear();
            } finally {
              fail("Could not persist the authenticated browser session", cause);
              if (!window.isDestroyed()) window.close();
            }
          })
          .finally(() => {
            persisting = false;
          });
      };
      this.#active.set(key, active);
      session.onCookiesChanged(changed);
      window.onClosed(active.close);
      void window.load(descriptor.startUrl).catch(async (cause: unknown) => {
        if (!isCurrent() || settled) return;
        try {
          await session.clear();
        } finally {
          fail("Could not open the provider login page", cause);
          if (!window.isDestroyed()) window.close();
        }
      });
    });
  }

  cancel(request: LoginRequestDTO): void {
    const active = this.#active.get(browserLoginKey(request));
    if (active === undefined) return;
    active.cancelled = true;
    active.close();
    if (!active.window.isDestroyed()) active.window.close();
  }

  async logout(request: LoginRequestDTO): Promise<void> {
    const active = this.#active.get(browserLoginKey(request));
    this.cancel(request);
    // A write that began just before cancellation must finish before deleting
    // the exported credential, otherwise it could resurrect a logged-out key.
    await active?.pendingPersistence?.catch(() => undefined);
    const session = this.#host.sessionFor(request);
    const [cleared, credentialRemoved] = await Promise.allSettled([
      session.clear(),
      this.#host.removeCredential(browserCredentialKey(request)),
    ]);
    if (cleared.status === "rejected") throw cleared.reason;
    if (credentialRemoved.status === "rejected") throw credentialRemoved.reason;
  }
}
