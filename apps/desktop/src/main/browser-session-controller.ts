import type { LoginRequestDTO, LoginResultDTO } from "@codexbar/contracts";
import {
  browserSessionCredentialKey,
  browserSessionCredentialKeys,
  browserSessionStorageAccountId,
} from "@codexbar/platform";
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
  /** Force-close path used by security cleanup; provider pages cannot veto it. */
  readonly destroy: () => void;
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
  readonly readCredential: (key: string) => Promise<string | undefined>;
  readonly removeCredential: (key: string) => Promise<void>;
  readonly now: () => Date;
}

export interface BrowserLoginCredentialCandidate {
  readonly key: string;
  readonly value: string;
  readonly cookieHeaders: Readonly<Record<string, string>>;
}

export type BrowserLoginCredentialValidator = (
  request: LoginRequestDTO,
  candidate: BrowserLoginCredentialCandidate,
  signal: AbortSignal,
) => Promise<"persisted">;

interface ActiveLogin {
  readonly request: LoginRequestDTO;
  readonly window: BrowserLoginWindow;
  readonly session: BrowserLoginSession;
  readonly close: () => void;
  readonly waitClosed: () => Promise<void>;
  pendingPersistence: Promise<void> | undefined;
  credentialDirty: boolean;
  cancelled: boolean;
  readonly validationAbortController: AbortController;
}

export const browserLoginKey = ({ provider, accountId }: LoginRequestDTO) =>
  `${provider}/${accountId}`;
export const browserCredentialKey = ({ provider, accountId }: LoginRequestDTO) =>
  browserSessionCredentialKey(provider, accountId);
export const browserCredentialKeys = ({ provider, accountId }: LoginRequestDTO) =>
  browserSessionCredentialKeys(provider, accountId);
export const browserSessionPartition = ({ provider, accountId }: LoginRequestDTO) =>
  `persist:codexbar-multi-${provider}-${browserSessionStorageAccountId(accountId)}`;
export const legacyBrowserSessionPartition = ({ provider, accountId }: LoginRequestDTO) =>
  browserSessionStorageAccountId(accountId) === accountId
    ? undefined
    : `persist:codexbar-multi-${provider}-${accountId}`;

/** The generic renderer bridge owns only one host-selected account per provider. */
export const requireDefaultBrowserLoginRequest = (request: LoginRequestDTO): LoginRequestDTO => {
  if (request.provider === "codex") {
    throw new Error("Codex browser login requires the account-scoped host API");
  }
  if (request.accountId !== "default")
    throw new Error("Generic browser login is restricted to the default account");
  return request;
};

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
  readonly #cleanup = new Map<string, Promise<void>>();
  readonly #cleanupRequired = new Set<string>();
  readonly #host: BrowserLoginHost;

  constructor(host: BrowserLoginHost) {
    this.#host = host;
  }

  async #closeWindow(active: ActiveLogin): Promise<void> {
    if (active.window.isDestroyed()) {
      active.close();
      return active.waitClosed();
    }
    active.window.destroy();
    if (active.window.isDestroyed()) active.close();
    return active.waitClosed();
  }

  async #drainCancelledLogin(active: ActiveLogin): Promise<void> {
    active.cancelled = true;
    active.validationAbortController.abort();
    await this.#closeWindow(active);
    await active.pendingPersistence?.catch(() => undefined);
  }

  async #clearSessionAndCredential(
    request: LoginRequestDTO,
    session: BrowserLoginSession,
    removeCredential: boolean,
  ): Promise<void> {
    const credentialKeys = browserCredentialKeys(request);
    const [cleared, ...credentialRemovals] = await Promise.allSettled([
      session.clear(),
      ...(removeCredential ? credentialKeys.map((key) => this.#host.removeCredential(key)) : []),
    ]);
    if (cleared.status === "rejected") throw cleared.reason;
    const failedRemoval = credentialRemovals.find((result) => result.status === "rejected");
    if (failedRemoval?.status === "rejected") throw failedRemoval.reason;
    if (removeCredential) {
      const remaining = await Promise.all(
        credentialKeys.map((key) => this.#host.readCredential(key)),
      );
      if (remaining.some((value) => value !== undefined))
        throw new Error("Browser-session credential remained available after removal");
    }
  }

  #scheduleCancelCleanup(key: string, active: ActiveLogin): void {
    if (this.#cleanup.has(key)) return;
    active.cancelled = true;
    const cleanup = Promise.resolve().then(async () => {
      try {
        await this.#drainCancelledLogin(active);
        await this.#clearSessionAndCredential(
          active.request,
          active.session,
          active.credentialDirty,
        );
        this.#cleanupRequired.delete(key);
      } catch (cause) {
        this.#cleanupRequired.add(key);
        throw cause;
      } finally {
        if (this.#cleanup.get(key) === cleanup) this.#cleanup.delete(key);
      }
    });
    this.#cleanup.set(key, cleanup);
    void cleanup.catch(() => undefined);
  }

  async start(
    request: LoginRequestDTO,
    validateCredential?: BrowserLoginCredentialValidator,
  ): Promise<LoginResultDTO> {
    const descriptor = browserLoginDescriptor(request.provider);
    if (descriptor === undefined)
      throw new Error(`Interactive login is not declared for '${request.provider}'`);
    const key = browserLoginKey(request);
    if (this.#cleanup.has(key) || this.#cleanupRequired.has(key))
      throw new Error("Browser-session cleanup is incomplete for this account");
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
      let windowClosed = false;
      let closingForFailure = false;
      let resolveClosed: (() => void) | undefined;
      const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
      });
      const active: ActiveLogin = {
        request,
        window,
        session,
        pendingPersistence: undefined,
        credentialDirty: false,
        cancelled: false,
        validationAbortController: new AbortController(),
        close: () => {
          if (!windowClosed) {
            windowClosed = true;
            resolveClosed?.();
          }
          if (closingForFailure) return;
          if (active.pendingPersistence !== undefined && !settled && !active.cancelled) {
            this.#scheduleCancelCleanup(key, active);
          }
          finish("cancelled");
        },
        waitClosed: () => closed,
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
      const failAfterClosing = async (
        message: string,
        cause: unknown,
        removeCredential: boolean,
      ) => {
        closingForFailure = true;
        active.cancelled = true;
        try {
          await this.#closeWindow(active);
          await this.#clearSessionAndCredential(request, session, removeCredential);
          fail(message, cause);
        } catch (cleanupCause) {
          this.#cleanupRequired.add(key);
          fail(message, cleanupCause);
        }
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
            const candidate = {
              key: browserCredentialKey(request),
              value: browserCredentialPayload(request, cookieHeaders, this.#host.now()),
              cookieHeaders,
            } satisfies BrowserLoginCredentialCandidate;
            const persistedByValidator =
              validateCredential === undefined
                ? false
                : (await validateCredential(
                    request,
                    candidate,
                    active.validationAbortController.signal,
                  )) === "persisted";
            if (validateCredential !== undefined && !persistedByValidator) {
              throw new Error(
                "Browser-session credential validation did not persist the candidate",
              );
            }
            if (persistedByValidator) active.credentialDirty = true;
            if (!isCurrent() || settled) return;
            if (!persistedByValidator) {
              // Fail closed if a keyring write reports an error after partially
              // replacing an older credential.
              active.credentialDirty = true;
              await this.#host.persistCredential(candidate.key, candidate.value);
            }
            if (!isCurrent() || settled) return;
            finish("connected");
            if (!window.isDestroyed()) window.close();
          }
        })()
          .catch(async (cause: unknown) => {
            if (!isCurrent() || settled) return;
            await failAfterClosing(
              "Could not persist the authenticated browser session",
              cause,
              active.credentialDirty,
            );
          })
          .finally(() => {
            persisting = false;
          });
      };
      this.#active.set(key, active);
      session.onCookiesChanged(changed);
      window.onClosed(active.close);
      if (window.isDestroyed()) active.close();
      void window.load(descriptor.startUrl).catch(async (cause: unknown) => {
        if (!isCurrent() || settled) return;
        await failAfterClosing("Could not open the provider login page", cause, false);
      });
    });
  }

  cancel(request: LoginRequestDTO): void {
    const key = browserLoginKey(request);
    const active = this.#active.get(key);
    if (active === undefined) return;
    this.#scheduleCancelCleanup(key, active);
  }

  async logout(request: LoginRequestDTO): Promise<void> {
    const key = browserLoginKey(request);
    const priorCleanup = this.#cleanup.get(key);
    const active = this.#active.get(key);
    const cleanup = (async () => {
      await priorCleanup?.catch(() => undefined);
      if (active !== undefined) await this.#drainCancelledLogin(active);
      await this.#clearSessionAndCredential(
        request,
        active?.session ?? this.#host.sessionFor(request),
        true,
      );
    })();
    this.#cleanup.set(key, cleanup);
    try {
      await cleanup;
      this.#cleanupRequired.delete(key);
    } catch (cause) {
      // A failed partition clear must not permit a new login to reuse stale
      // cookies. Retrying logout is allowed and clears this fail-closed gate.
      this.#cleanupRequired.add(key);
      throw cause;
    } finally {
      if (this.#cleanup.get(key) === cleanup) this.#cleanup.delete(key);
    }
  }
}
