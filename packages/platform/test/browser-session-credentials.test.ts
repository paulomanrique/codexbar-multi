import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { InfrastructureError, type CredentialStoreService } from "@codexbar/core";
import type { ProviderId } from "@codexbar/contracts";

import { makeCredentialBrowserSessions, readDefaultBrowserSessionStatuses } from "../src/node.ts";

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

  it("reads only the selected Codex account key and never its default session", async () => {
    const reads: string[] = [];
    const sessions = makeCredentialBrowserSessions(
      store(
        {
          "browser-session/codex/account_selected-1": storedBrowserSession(
            "codex",
            "account_selected-1",
            { "chatgpt.com": "__Secure-next-auth.session-token=selected-secret" },
          ),
          "browser-session/codex/default": storedBrowserSession("codex", "default", {
            "chatgpt.com": "__Secure-next-auth.session-token=default-secret",
          }),
        },
        reads,
      ),
      () => "default",
    );

    await expect(
      Effect.runPromise(sessions.cookieHeader("codex", "chatgpt.com", "account_selected-1")),
    ).resolves.toBe("__Secure-next-auth.session-token=selected-secret");
    expect(reads).toEqual(["browser-session/codex/account_selected-1"]);
  });

  it("does not fall back to the default key when a selected Codex key is missing", async () => {
    const reads: string[] = [];
    const sessions = makeCredentialBrowserSessions(
      store(
        {
          "browser-session/codex/default": storedBrowserSession("codex", "default", {
            "chatgpt.com": "__Secure-next-auth.session-token=default-secret",
          }),
        },
        reads,
      ),
      () => "default",
    );

    await expect(
      Effect.runPromise(sessions.cookieHeader("codex", "chatgpt.com", "missing_selected")),
    ).rejects.toMatchObject({ _tag: "MissingBrowserCredentialError" });
    expect(reads).toEqual(["browser-session/codex/missing_selected"]);
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

  it("rejects a selected account for providers without account-scoped browser sessions", async () => {
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

describe("default browser session status projection", () => {
  it("reports persisted only for strict default Claude, T3, and Grok credentials", async () => {
    const reads: string[] = [];
    await expect(
      readDefaultBrowserSessionStatuses(
        store(
          {
            "browser-session/claude/default": storedBrowserSession("claude", "default", {
              "claude.ai": "sessionKey=fixture-secret",
            }),
            "browser-session/t3chat/default": storedBrowserSession("t3chat", "default", {
              "t3.chat": "__session=fixture-secret",
            }),
            "browser-session/grok/default": storedBrowserSession("grok", "default", {
              "grok.com": "sso=fixture-secret",
            }),
            "browser-session/openai/default": storedBrowserSession("openai", "default", {
              "openai.com": "must-not-read",
            }),
          },
          reads,
        ),
      ),
    ).resolves.toEqual({
      schemaVersion: 1,
      claudeDefault: "persisted",
      t3chatDefault: "persisted",
      grokDefault: "persisted",
    });
    expect(reads).toEqual([
      "browser-session/claude/default",
      "browser-session/t3chat/default",
      "browser-session/grok/default",
    ]);
  });

  it("reports absent for missing exact default credentials", async () => {
    await expect(readDefaultBrowserSessionStatuses(store({}))).resolves.toEqual({
      schemaVersion: 1,
      claudeDefault: "absent",
      t3chatDefault: "absent",
      grokDefault: "absent",
    });
  });

  it("requires a non-empty Claude sessionKey for the claude.ai default credential", async () => {
    await expect(
      readDefaultBrowserSessionStatuses(
        store({
          "browser-session/claude/default": storedBrowserSession("claude", "default", {
            "claude.ai": "tracking=fixture-secret",
          }),
          "browser-session/t3chat/default": storedBrowserSession("t3chat", "default", {
            "t3.chat": "__session=fixture-secret",
          }),
          "browser-session/grok/default": storedBrowserSession("grok", "default", {
            "grok.com": "sso=fixture-secret",
          }),
        }),
      ),
    ).resolves.toEqual({
      schemaVersion: 1,
      claudeDefault: "unavailable",
      t3chatDefault: "persisted",
      grokDefault: "persisted",
    });
    await expect(
      readDefaultBrowserSessionStatuses(
        store({
          "browser-session/claude/default": storedBrowserSession("claude", "default", {
            "claude.ai": "sessionKey=   ",
          }),
        }),
      ),
    ).resolves.toMatchObject({ claudeDefault: "unavailable" });
  });

  it.each([
    ["extra cookie", "sessionKey=fixture-secret; tracking=must-not-cross"],
    ["duplicate cookie", "sessionKey=fixture-secret; sessionKey=other-secret"],
    ["control character", "sessionKey=fixture-secret\nInjected=value"],
  ] as const)("rejects a Claude default credential with %s", async (_label, cookieHeader) => {
    const stored = storedBrowserSession("claude", "default", { "claude.ai": cookieHeader });
    await expect(
      readDefaultBrowserSessionStatuses(
        store({
          "browser-session/claude/default": stored,
        }),
      ),
    ).resolves.toMatchObject({ claudeDefault: "unavailable" });
    const sessions = makeCredentialBrowserSessions(
      store({
        "browser-session/claude/default": stored,
      }),
    );
    await expect(
      Effect.runPromise(sessions.cookieHeader("claude", "claude.ai")),
    ).rejects.toMatchObject({ _tag: "InfrastructureError", operation: "browser session" });
  });

  it("canonicalizes the single allowlisted Claude sessionKey before release", async () => {
    const sessions = makeCredentialBrowserSessions(
      store({
        "browser-session/claude/default": storedBrowserSession("claude", "default", {
          "claude.ai": "  sessionKey = fixture-secret  ",
        }),
      }),
    );
    await expect(Effect.runPromise(sessions.cookieHeader("claude", "claude.ai"))).resolves.toBe(
      "sessionKey=fixture-secret",
    );
  });

  it.each([
    ["corrupt JSON", "{not-json"],
    [
      "provider mismatch",
      storedBrowserSession("openai", "default", { "t3.chat": "__session=fixture-secret" }),
    ],
    [
      "account mismatch",
      storedBrowserSession("t3chat", "other", { "t3.chat": "__session=fixture-secret" }),
    ],
    [
      "missing domain",
      storedBrowserSession("t3chat", "default", { "www.t3.chat": "__session=fixture-secret" }),
    ],
    ["blank header", storedBrowserSession("t3chat", "default", { "t3.chat": "   " })],
  ] as const)(
    "reports unavailable for %s without exposing payload text",
    async (_label, stored) => {
      const result = await readDefaultBrowserSessionStatuses(
        store({
          "browser-session/claude/default": storedBrowserSession("claude", "default", {
            "claude.ai": "sessionKey=fixture-secret",
          }),
          "browser-session/t3chat/default": stored,
          "browser-session/grok/default": storedBrowserSession("grok", "default", {
            "grok.com": "sso=fixture-secret",
          }),
        }),
      );
      expect(result).toEqual({
        schemaVersion: 1,
        claudeDefault: "persisted",
        t3chatDefault: "unavailable",
        grokDefault: "persisted",
      });
      expect(JSON.stringify(result)).not.toContain("fixture-secret");
      expect(JSON.stringify(result)).not.toContain("sessionKey");
      expect(JSON.stringify(result)).not.toContain("__session");
      expect(JSON.stringify(result)).not.toContain("sso=");
    },
  );

  it("reports unavailable on credential-store failure without exposing the cause", async () => {
    const result = await readDefaultBrowserSessionStatuses({
      read: () =>
        Effect.fail(
          new InfrastructureError(
            "keyring",
            "fixture-secret should stay host-only",
            new Error("fixture-secret cause"),
          ),
        ),
      write: () => Effect.void,
      remove: () => Effect.void,
    });
    expect(result).toEqual({
      schemaVersion: 1,
      claudeDefault: "unavailable",
      t3chatDefault: "unavailable",
      grokDefault: "unavailable",
    });
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
  });
});
