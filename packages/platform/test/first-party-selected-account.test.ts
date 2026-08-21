import { describe, expect, it } from "vite-plus/test";
import type { PersistedCodexBarConfig } from "@codexbar/core";
import { selectedFirstPartyAccountFromConfig } from "../src/first-party-selected-account.ts";

const jwt = (payload: Record<string, unknown>): string => {
  const encoded = btoa(JSON.stringify(payload))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
  return `header.${encoded}.signature`;
};

const config = (tokens: readonly string[], activeIndex: number): PersistedCodexBarConfig => ({
  version: 1,
  providers: [
    {
      id: "antigravity",
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
    expect(selectedFirstPartyAccountFromConfig(config(["{}"], 0), "claude")).toBeUndefined();
  });
});
