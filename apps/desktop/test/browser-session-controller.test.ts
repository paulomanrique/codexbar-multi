import { describe, expect, it } from "vite-plus/test";

import type { LoginRequestDTO } from "@codexbar/contracts";
import {
  BrowserLoginController,
  browserCredentialKey,
  browserSessionPartition,
  type BrowserLoginHost,
  type BrowserLoginSession,
  type BrowserLoginWindow,
} from "../src/main/browser-session-controller.ts";
import type {
  BrowserCookieValue,
  BrowserLoginDescriptor,
} from "../src/main/browser-session-policy.ts";

const request: LoginRequestDTO = { provider: "t3chat", accountId: "primary" };

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

  focus(): void {
    this.focused += 1;
  }

  close(): void {
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
  const host: BrowserLoginHost = {
    sessionFor: () => session,
    createWindow: (_request: LoginRequestDTO, _descriptor: BrowserLoginDescriptor, _session) =>
      window,
    persistCredential: async (key, value) => {
      writes.push({ key, value });
    },
    removeCredential: async (key) => {
      removes.push(key);
    },
    now: () => new Date("2026-08-20T12:34:56.000Z"),
  };
  return { host, session, window, writes, removes };
};

describe("browser login controller", () => {
  it("uses isolated provider/account names for partitions and credentials", () => {
    expect(browserSessionPartition(request)).toBe("persist:codexbar-multi-t3chat-primary");
    expect(browserCredentialKey(request)).toBe("browser-session/t3chat/primary");
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

  it("clears an isolated partition when exporting to the credential store fails", async () => {
    const { host, session } = makeHost();
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
    await expect(result).rejects.toThrow("Could not persist the authenticated browser session");
    expect(session.clearCalls).toBe(1);
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
