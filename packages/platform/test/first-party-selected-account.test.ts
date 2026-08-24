import { describe, expect, it } from "vite-plus/test";
import { sha256Hex, type PersistedCodexBarConfig } from "@codexbar/core";
import { selectedFirstPartyAccountFromConfig } from "../src/first-party-selected-account.ts";

const jwt = (payload: Record<string, unknown>): string => {
  const encoded = btoa(JSON.stringify(payload))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
  return `header.${encoded}.signature`;
};

const config = (
  tokens: readonly string[],
  activeIndex: number,
  providerId = "antigravity",
): PersistedCodexBarConfig => ({
  version: 1,
  providers: [
    {
      id: providerId,
      extensions: {},
      tokenAccounts: {
        version: 1,
        activeIndex,
        accounts: tokens.map((token, index) => ({
          id: `account-${index}`,
          label: `Account ${index}`,
          token,
          addedAt: index,
        })),
      },
    },
  ],
});

describe("first-party selected accounts", () => {
  it("clamps activeIndex and exposes only the Antigravity refresh fields", () => {
    const selected = selectedFirstPartyAccountFromConfig(
      config(
        [
          "{}",
          JSON.stringify({
            access_token: "access",
            refresh_token: "refresh",
            id_token: jwt({ email: "jwt@example.com" }),
            email: "stored@example.com",
            project_id: "project",
            client_id: "client",
            client_secret: "secret",
          }),
        ],
        99,
      ),
      "antigravity",
    );
    expect(selected).toEqual({
      id: "account-1",
      accountEmail: "jwt@example.com",
      secureSettings: {
        ANTIGRAVITY_OAUTH_ACCESS_TOKEN: "access",
        ANTIGRAVITY_ID_TOKEN: expect.any(String),
      },
      plainSettings: {
        ANTIGRAVITY_ACCOUNT_EMAIL: "stored@example.com",
        ANTIGRAVITY_PROJECT_ID: "project",
      },
    });
    expect(JSON.stringify(selected)).not.toContain("refresh");
    expect(JSON.stringify(selected)).not.toContain("client");
  });

  it("explicitly clears ambient credentials for a malformed selected account", () => {
    expect(selectedFirstPartyAccountFromConfig(config(["not-json"], 0), "antigravity")).toEqual({
      id: "account-0",
      secureSettings: {
        ANTIGRAVITY_OAUTH_ACCESS_TOKEN: null,
        ANTIGRAVITY_ID_TOKEN: null,
      },
      plainSettings: {
        ANTIGRAVITY_ACCOUNT_EMAIL: null,
        ANTIGRAVITY_PROJECT_ID: null,
      },
    });
  });

  it("does not project token accounts into an unsupported provider", () => {
    expect(selectedFirstPartyAccountFromConfig(config(["{}"], 0), "codex")).toBeUndefined();
  });

  it("selects the active Claude OAuth account and strips the Bearer prefix", () => {
    const selected = selectedFirstPartyAccountFromConfig(
      config(["sk-ant-oat-first", "Bearer sk-ant-oat-second"], 1, "claude"),
      "claude",
    );
    expect(selected).toMatchObject({
      id: "account-1",
      secureSettings: {
        CLAUDE_OAUTH_ACCESS_TOKEN: "sk-ant-oat-second",
        CLAUDE_COOKIE_HEADER: null,
        CLAUDE_CLI_USAGE_JSON: null,
      },
      claudeHistoryBinding: {
        selectionKey: sha256Hex("claude:token-account:account-1"),
        oauthHistoryOwnerIdentifier: expect.stringMatching(/^[0-9a-f]{64}$/u),
        tokenAccountKey: sha256Hex("claude:token-account:account-1"),
      },
    });
    expect(JSON.stringify(selected)).not.toContain("Bearer");
  });

  it("selects Claude cookie accounts and fails closed for malformed or admin credentials", () => {
    expect(
      selectedFirstPartyAccountFromConfig(
        config(["Cookie: sessionKey=sk-ant-selected; foo=bar"], 0, "claude"),
        "claude",
      ),
    ).toMatchObject({
      id: "account-0",
      secureSettings: {
        CLAUDE_OAUTH_ACCESS_TOKEN: null,
        CLAUDE_COOKIE_HEADER: "sessionKey=sk-ant-selected; foo=bar",
        CLAUDE_CLI_USAGE_JSON: null,
      },
      claudeHistoryBinding: {
        selectionKey: sha256Hex("claude:token-account:account-0"),
        tokenAccountKey: sha256Hex("claude:token-account:account-0"),
      },
    });

    for (const token of ["Cookie:", "Bearer sk-ant-admin-test"]) {
      expect(selectedFirstPartyAccountFromConfig(config([token], 0, "claude"), "claude")).toEqual({
        id: "account-0",
        secureSettings: {
          CLAUDE_OAUTH_ACCESS_TOKEN: null,
          CLAUDE_COOKIE_HEADER: null,
          CLAUDE_CLI_USAGE_JSON: null,
        },
      });
    }
  });
});
