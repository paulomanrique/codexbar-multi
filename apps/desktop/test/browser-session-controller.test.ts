import { describe, expect, it } from "vite-plus/test";

import type { LoginRequestDTO } from "@codexbar/contracts";
import {
  BrowserLoginController,
  browserCredentialKey,
  browserSessionPartition,
  requireDefaultBrowserLoginRequest,
  type BrowserLoginHost,
  type BrowserLoginSession,
  type BrowserLoginWindow,
} from "../src/main/browser-session-controller.ts";
import type {
  BrowserCookieValue,
  BrowserLoginDescriptor,
} from "../src/main/browser-session-policy.ts";

const request: LoginRequestDTO = { provider: "t3chat", accountId: "primary" };
const claudeDefaultRequest: LoginRequestDTO = { provider: "claude", accountId: "default" };
const grokDefaultRequest: LoginRequestDTO = { provider: "grok", accountId: "default" };

class FakeSession implements BrowserLoginSession {
  readonly cookies = new Map<string, readonly BrowserCookieValue[]>();
  readonly listeners = new Set<() => void>();
  clearCalls = 0;

  async cookiesFor(domain: string): Promise<readonly BrowserCookieValue[]> {
    return this.cookies.get(domain) ?? [];
  }

  onCookiesChanged(listener: () => void): void {
    this.listeners.add(listener);
  }

  offCookiesChanged(listener: () => void): void {
    this.listeners.delete(listener);
  }

  async clear(): Promise<void> {
    this.clearCalls += 1;
  }

  changed(): void {
    for (const listener of this.listeners) listener();
  }
}

class FakeWindow implements BrowserLoginWindow {
  readonly closeListeners = new Set<() => void>();
  loaded: string | undefined;
  focused = 0;
  closed = false;
  closeRequested = false;
  delayClose = false;

  focus(): void {
    this.focused += 1;
  }

  close(): void {
    if (this.closed) return;
    this.closeRequested = true;
    if (this.delayClose) return;
    this.finishClose();
  }

  destroy(): void {
    this.close();
  }

  finishClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closeListeners) listener();
  }

  isDestroyed(): boolean {
    return this.closed;
  }

  async load(url: string): Promise<void> {
    this.loaded = url;
  }

  onClosed(listener: () => void): void {
    this.closeListeners.add(listener);
  }
}

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const makeHost = () => {
  const session = new FakeSession();
  const window = new FakeWindow();
  const writes: Array<{ key: string; value: string }> = [];
  const removes: string[] = [];
  const credentials = new Map<string, string>();
  const host: BrowserLoginHost = {
    sessionFor: () => session,
    createWindow: (_request: LoginRequestDTO, _descriptor: BrowserLoginDescriptor, _session) =>
      window,
    persistCredential: async (key, value) => {
      writes.push({ key, value });
      credentials.set(key, value);
    },
    readCredential: async (key) => credentials.get(key),
    removeCredential: async (key) => {
      removes.push(key);
      credentials.delete(key);
    },
    now: () => new Date("2026-08-20T12:34:56.000Z"),
  };
  return { host, session, window, writes, removes };
};

describe("browser login controller", () => {
  it("uses isolated provider/account names for partitions and credentials", () => {
    expect(browserSessionPartition(request)).toBe("persist:codexbar-multi-t3chat-primary");
    expect(browserCredentialKey(request)).toBe("browser-session/t3chat/primary");
    expect(browserSessionPartition(claudeDefaultRequest)).toBe(
      "persist:codexbar-multi-claude-default",
    );
    expect(browserCredentialKey(claudeDefaultRequest)).toBe("browser-session/claude/default");
    expect(browserSessionPartition(grokDefaultRequest)).toBe("persist:codexbar-multi-grok-default");
    expect(browserCredentialKey(grokDefaultRequest)).toBe("browser-session/grok/default");
  });

  it("restricts the generic renderer login bridge to default account IDs", () => {
    expect(requireDefaultBrowserLoginRequest(grokDefaultRequest)).toBe(grokDefaultRequest);
    expect(() => requireDefaultBrowserLoginRequest(request)).toThrow(
      "restricted to the default account",
    );
  });

  it("persists only allowlisted completion cookies and never exposes them in the result", async () => {
    const { host, session, window, writes } = makeHost();
    session.cookies.set("t3.chat", [
      { name: "tracking", value: "must-not-leave" },
      { name: "__client_uat", value: "public-ish" },
      { name: "__session", value: "secret-session" },
    ]);
    const controller = new BrowserLoginController(host);

    const result = controller.start(request);
    await flush();
    expect(window.loaded).toBe("https://t3.chat/settings/customization");
    session.changed();

    await expect(result).resolves.toEqual({ ...request, status: "connected" });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.key).toBe(browserCredentialKey(request));
    expect(writes[0]?.value).toContain("__session=secret-session");
    expect(writes[0]?.value).not.toContain("must-not-leave");
  });

  it("persists Grok browser login as host-only credential material", async () => {
    const { host, session, window, writes } = makeHost();
    session.cookies.set("grok.com", [
      { name: "tracking", value: "must-not-leave" },
      { name: "sso-rw", value: "secret-rw" },
      { name: "sso", value: "secret-sso" },
    ]);
    session.cookies.set("www.grok.com", [{ name: "sso", value: "subdomain-secret" }]);
    session.cookies.set("accounts.x.ai", [{ name: "sso", value: "sso-origin-secret" }]);
    const controller = new BrowserLoginController(host);

    const result = controller.start(grokDefaultRequest);
    await flush();
    expect(window.loaded).toBe("https://grok.com/?_s=usage");
    session.changed();

    const resolved = await result;
    expect(resolved).toEqual({ ...grokDefaultRequest, status: "connected" });
    expect(JSON.stringify(resolved)).not.toContain("secret");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.key).toBe(browserCredentialKey(grokDefaultRequest));
    const payload = JSON.parse(writes[0]?.value ?? "{}") as {
      readonly cookieHeaders?: Readonly<Record<string, string>>;
    };
    expect(payload.cookieHeaders).toEqual({ "grok.com": "sso=secret-sso; sso-rw=secret-rw" });
    expect(writes[0]?.value).not.toContain("must-not-leave");
    expect(writes[0]?.value).not.toContain("subdomain-secret");
    expect(writes[0]?.value).not.toContain("sso-origin-secret");
  });

  it("persists Claude browser login as the default claude.ai sessionKey only", async () => {
    const { host, session, window, writes } = makeHost();
    session.cookies.set("claude.ai", [
      { name: "tracking", value: "must-not-leave" },
      { name: "sessionKey", value: "secret-session" },
    ]);
    session.cookies.set("www.claude.ai", [{ name: "sessionKey", value: "subdomain-secret" }]);
    session.cookies.set("accounts.google.com", [
      { name: "sessionKey", value: "google-origin-secret" },
    ]);
    const controller = new BrowserLoginController(host);

    const result = controller.start(claudeDefaultRequest);
    await flush();
    expect(window.loaded).toBe("https://claude.ai");
    session.changed();

    const resolved = await result;
    expect(resolved).toEqual({ ...claudeDefaultRequest, status: "connected" });
    expect(JSON.stringify(resolved)).not.toContain("secret");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.key).toBe(browserCredentialKey(claudeDefaultRequest));
    const payload = JSON.parse(writes[0]?.value ?? "{}") as {
      readonly cookieHeaders?: Readonly<Record<string, string>>;
    };
    expect(payload.cookieHeaders).toEqual({ "claude.ai": "sessionKey=secret-session" });
    expect(writes[0]?.value).not.toContain("must-not-leave");
    expect(writes[0]?.value).not.toContain("subdomain-secret");
    expect(writes[0]?.value).not.toContain("google-origin-secret");
  });

  it("focuses an existing account login instead of opening a second window", async () => {
    const { host, window } = makeHost();
    const controller = new BrowserLoginController(host);
    const first = controller.start(request);
    await flush();

    await expect(controller.start(request)).rejects.toThrow("already active");
    expect(window.focused).toBe(1);
    controller.cancel(request);
    await expect(first).resolves.toEqual({ ...request, status: "cancelled" });
  });

  it("cancels an active login and clears the partition plus encrypted credential on logout", async () => {
    const { host, session, removes } = makeHost();
    const controller = new BrowserLoginController(host);
    const pending = controller.start(request);
    await flush();

    await controller.logout(request);
    await expect(pending).resolves.toEqual({ ...request, status: "cancelled" });
    expect(session.clearCalls).toBe(1);
    expect(removes).toEqual([browserCredentialKey(request)]);
  });

  it("logs out Grok default by clearing its partition and credential", async () => {
    const { host, session, removes } = makeHost();
    const controller = new BrowserLoginController(host);
    const pending = controller.start(grokDefaultRequest);
    await flush();

    await controller.logout(grokDefaultRequest);
    await expect(pending).resolves.toEqual({ ...grokDefaultRequest, status: "cancelled" });
    expect(session.clearCalls).toBe(1);
    expect(removes).toEqual([browserCredentialKey(grokDefaultRequest)]);
  });

  it("waits for the login window to close before clearing storage on logout", async () => {
    const { host, session, window, removes } = makeHost();
    window.delayClose = true;
    const controller = new BrowserLoginController(host);
    const pending = controller.start(grokDefaultRequest);
    await flush();

    const logout = controller.logout(grokDefaultRequest);
    await flush();

    expect(window.closeRequested).toBe(true);
    expect(session.clearCalls).toBe(0);
    expect(removes).toEqual([]);
    await expect(controller.start(grokDefaultRequest)).rejects.toThrow("cleanup is incomplete");

    window.finishClose();
    await logout;
    await expect(pending).resolves.toEqual({ ...grokDefaultRequest, status: "cancelled" });
    expect(session.clearCalls).toBe(1);
    expect(removes).toEqual([browserCredentialKey(grokDefaultRequest)]);
  });

  it("blocks a same-account relogin until an earlier logout cleanup finishes", async () => {
    const { host, session, removes } = makeHost();
    let releasePersistence: (() => void) | undefined;
    const slowHost: BrowserLoginHost = {
      ...host,
      persistCredential: async () =>
        new Promise<void>((resolve) => {
          releasePersistence = resolve;
        }),
    };
    session.cookies.set("grok.com", [{ name: "sso", value: "old-session" }]);
    const controller = new BrowserLoginController(slowHost);
    const first = controller.start(grokDefaultRequest);
    await flush();
    session.changed();
    await flush();

    const logout = controller.logout(grokDefaultRequest);
    await expect(controller.start(grokDefaultRequest)).rejects.toThrow("cleanup is incomplete");
    releasePersistence?.();

    await logout;
    await expect(first).resolves.toEqual({ ...grokDefaultRequest, status: "cancelled" });
    expect(session.clearCalls).toBe(1);
    expect(removes).toEqual([browserCredentialKey(grokDefaultRequest)]);

    const second = controller.start(grokDefaultRequest);
    await flush();
    controller.cancel(grokDefaultRequest);
    await expect(second).resolves.toEqual({ ...grokDefaultRequest, status: "cancelled" });
  });

  it("fences cancel until a late credential write is rolled back", async () => {
    const { host, session, window, removes } = makeHost();
    window.delayClose = true;
    let releasePersistence: (() => void) | undefined;
    const slowHost: BrowserLoginHost = {
      ...host,
      persistCredential: async (key, value) => {
        await new Promise<void>((resolve) => {
          releasePersistence = resolve;
        });
        await host.persistCredential(key, value);
      },
    };
    session.cookies.set("grok.com", [{ name: "sso", value: "late-session" }]);
    const controller = new BrowserLoginController(slowHost);
    const pending = controller.start(grokDefaultRequest);
    await flush();
    session.changed();
    await flush();

    controller.cancel(grokDefaultRequest);
    await expect(controller.start(grokDefaultRequest)).rejects.toThrow("cleanup is incomplete");
    window.finishClose();
    await flush();
    await expect(controller.start(grokDefaultRequest)).rejects.toThrow("cleanup is incomplete");

    releasePersistence?.();
    await expect(pending).resolves.toEqual({ ...grokDefaultRequest, status: "cancelled" });
    await flush();

    expect(session.clearCalls).toBe(1);
    expect(removes).toEqual([browserCredentialKey(grokDefaultRequest)]);
    await flush();
    await flush();
    const next = controller.start(grokDefaultRequest);
    await flush();
    controller.cancel(grokDefaultRequest);
    await expect(next).resolves.toEqual({ ...grokDefaultRequest, status: "cancelled" });
  });

  it("keeps login fail-closed after cleanup failure until logout retry succeeds", async () => {
    const { host, session } = makeHost();
    let failClear = true;
    session.clear = async () => {
      session.clearCalls += 1;
      if (failClear) throw new Error("partition busy");
    };
    const controller = new BrowserLoginController(host);

    await expect(controller.logout(grokDefaultRequest)).rejects.toThrow("partition busy");
    await expect(controller.start(grokDefaultRequest)).rejects.toThrow("cleanup is incomplete");

    failClear = false;
    await controller.logout(grokDefaultRequest);
    const login = controller.start(grokDefaultRequest);
    await flush();
    controller.cancel(grokDefaultRequest);
    await expect(login).resolves.toEqual({ ...grokDefaultRequest, status: "cancelled" });
    expect(session.clearCalls).toBe(3);
  });

  it("keeps cleanup pending when credential readback remains present", async () => {
    const { host } = makeHost();
    let retained = true;
    const retainingHost: BrowserLoginHost = {
      ...host,
      readCredential: async () => (retained ? "still-present" : undefined),
    };
    const controller = new BrowserLoginController(retainingHost);

    await expect(controller.logout(grokDefaultRequest)).rejects.toThrow(
      "remained available after removal",
    );
    await expect(controller.start(grokDefaultRequest)).rejects.toThrow("cleanup is incomplete");

    retained = false;
    await expect(controller.logout(grokDefaultRequest)).resolves.toBeUndefined();
    const login = controller.start(grokDefaultRequest);
    await flush();
    controller.cancel(grokDefaultRequest);
    await expect(login).resolves.toEqual({ ...grokDefaultRequest, status: "cancelled" });
  });

  it("clears an isolated partition when exporting to the credential store fails", async () => {
    const { host, session, removes, window } = makeHost();
    window.delayClose = true;
    const failingHost: BrowserLoginHost = {
      ...host,
      persistCredential: async () => {
        throw new Error("keyring unavailable");
      },
    };
    session.cookies.set("t3.chat", [{ name: "__session", value: "secret-session" }]);
    const controller = new BrowserLoginController(failingHost);
    const result = controller.start(request);
    await flush();

    session.changed();
    for (let index = 0; index < 5 && !window.closeRequested; index += 1) await flush();
    expect(window.closeRequested).toBe(true);
    expect(session.clearCalls).toBe(0);
    expect(removes).toEqual([]);
    window.finishClose();
    await expect(result).rejects.toThrow("Could not persist the authenticated browser session");
    expect(session.clearCalls).toBe(1);
    expect(removes).toEqual([browserCredentialKey(request)]);
  });

  it("coalesces a completion-cookie event that arrives during an earlier cookie read", async () => {
    const { host, session, writes } = makeHost();
    let releaseFirstRead: (() => void) | undefined;
    let reads = 0;
    session.cookiesFor = async (domain) => {
      reads += 1;
      if (reads === 1) await new Promise<void>((resolve) => (releaseFirstRead = resolve));
      return session.cookies.get(domain) ?? [];
    };
    const controller = new BrowserLoginController(host);
    const result = controller.start(request);
    await flush();

    session.changed();
    await flush();
    session.cookies.set("t3.chat", [{ name: "__session", value: "final-session" }]);
    session.changed();
    releaseFirstRead?.();

    await expect(result).resolves.toEqual({ ...request, status: "connected" });
    expect(reads).toBeGreaterThan(1);
    expect(writes.at(-1)?.value).toContain("__session=final-session");
  });
});
