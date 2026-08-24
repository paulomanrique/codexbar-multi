import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import type { CredentialStoreService } from "@codexbar/core";
import type { ProviderId } from "@codexbar/contracts";

import { makeCredentialBrowserSessions } from "../src/node.ts";

const storedBrowserSession = (
  provider: ProviderId,
  accountId: string,
  cookieHeaders: Readonly<Record<string, string>>,
) =>
  JSON.stringify({
    version: 1,
    provider,
    accountId,
    cookieHeaders,
  });

const store = (
  values: Readonly<Record<string, string | undefined>>,
  reads: string[] = [],
): CredentialStoreService => ({
  read: (key) =>
    Effect.sync(() => {
      reads.push(key);
      return values[key];
    }),
  write: () => Effect.void,
  remove: () => Effect.void,
});

describe("browser session credential domain isolation", () => {
  it("returns only the cookie header stored for the requested domain", async () => {
    const sessions = makeCredentialBrowserSessions({
      read: () =>
        Effect.succeed(
          storedBrowserSession("t3chat", "default", {
            "t3.chat": "root=session-root",
            "www.t3.chat": "www=session-www",
          }),
        ),
      write: () => Effect.void,
      remove: () => Effect.void,
    });

    await expect(Effect.runPromise(sessions.cookieHeader("t3chat", "t3.chat"))).resolves.toBe(
      "root=session-root",
    );
    await expect(Effect.runPromise(sessions.cookieHeader("t3chat", "www.t3.chat"))).resolves.toBe(
      "www=session-www",
    );
    await expect(
      Effect.runPromise(sessions.cookieHeader("t3chat", "accounts.google.com")),
    ).rejects.toMatchObject({ _tag: "InfrastructureError", operation: "browser session" });
  });

  it("rejects the legacy aggregate cookie shape instead of widening its domain", async () => {
    const sessions = makeCredentialBrowserSessions({
      read: () => Effect.succeed(JSON.stringify({ cookieHeader: "session=legacy" })),
      write: () => Effect.void,
      remove: () => Effect.void,
    });
    await expect(
      Effect.runPromise(sessions.cookieHeader("t3chat", "t3.chat")),
    ).rejects.toMatchObject({ _tag: "InfrastructureError", operation: "browser session" });
  });
});

describe("browser session credential account routing", () => {
  it("reads the selected Grok account key", async () => {
    const reads: string[] = [];
    const sessions = makeCredentialBrowserSessions(
      store(
        {
          "browser-session/grok/account_selected-1": storedBrowserSession(
            "grok",
            "account_selected-1",
            { "grok.com": "sso=selected" },
          ),
          "browser-session/grok/default": storedBrowserSession("grok", "default", {
            "grok.com": "sso=default",
          }),
        },
        reads,
      ),
      () => "default",
    );

    await expect(
      Effect.runPromise(sessions.cookieHeader("grok", "grok.com", "account_selected-1")),
    ).resolves.toBe("sso=selected");
    expect(reads).toEqual(["browser-session/grok/account_selected-1"]);
  });

  it("uses the configured default account when no selected ID is supplied", async () => {
    const reads: string[] = [];
    const sessions = makeCredentialBrowserSessions(
      store(
        {
          "browser-session/grok/configured_default": storedBrowserSession(
            "grok",
            "configured_default",
            { "grok.com": "sso=default" },
          ),
        },
        reads,
      ),
      () => "configured_default",
    );

    await expect(Effect.runPromise(sessions.cookieHeader("grok", "grok.com"))).resolves.toBe(
      "sso=default",
    );
    expect(reads).toEqual(["browser-session/grok/configured_default"]);
  });

  it("does not fall back to the default key when a selected Grok key is missing", async () => {
    const reads: string[] = [];
    const sessions = makeCredentialBrowserSessions(
      store(
        {
          "browser-session/grok/default": storedBrowserSession("grok", "default", {
            "grok.com": "sso=default",
          }),
        },
        reads,
      ),
      () => "default",
    );

    await expect(
      Effect.runPromise(sessions.cookieHeader("grok", "grok.com", "missing_selected")),
    ).rejects.toMatchObject({ _tag: "MissingBrowserCredentialError" });
    expect(reads).toEqual(["browser-session/grok/missing_selected"]);
  });

  it.each([
    [
      "provider mismatch",
      storedBrowserSession("claude", "account_selected", { "grok.com": "sso=wrong-provider" }),
    ],
    [
      "account mismatch",
      storedBrowserSession("grok", "other_account", { "grok.com": "sso=wrong-account" }),
    ],
  ] as const)("rejects a stored credential with %s", async (_label, stored) => {
    const sessions = makeCredentialBrowserSessions(
      store({ "browser-session/grok/account_selected": stored }),
    );

    await expect(
      Effect.runPromise(sessions.cookieHeader("grok", "grok.com", "account_selected")),
    ).rejects.toMatchObject({ _tag: "InfrastructureError", operation: "browser session" });
  });

  it("rejects an invalid selected account ID before reading the credential store", async () => {
    const reads: string[] = [];
    let defaultAccountCalls = 0;
    const sessions = makeCredentialBrowserSessions(store({}, reads), () => {
      defaultAccountCalls += 1;
      return "default";
    });

    await expect(
      Effect.runPromise(sessions.cookieHeader("grok", "grok.com", "../default")),
    ).rejects.toMatchObject({ _tag: "InfrastructureError", operation: "browser session" });
    expect(reads).toEqual([]);
    expect(defaultAccountCalls).toBe(0);
  });

  it("rejects a selected account for non-Grok providers before reading the credential store", async () => {
    const reads: string[] = [];
    let defaultAccountCalls = 0;
    const sessions = makeCredentialBrowserSessions(store({}, reads), () => {
      defaultAccountCalls += 1;
      return "default";
    });

    await expect(
      Effect.runPromise(sessions.cookieHeader("t3chat", "t3.chat", "account_selected")),
    ).rejects.toMatchObject({ _tag: "InfrastructureError", operation: "browser session" });
    expect(reads).toEqual([]);
    expect(defaultAccountCalls).toBe(0);
  });
});
