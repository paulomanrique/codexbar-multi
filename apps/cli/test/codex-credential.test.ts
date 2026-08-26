import { describe, expect, it } from "vite-plus/test";
import { join } from "node:path";

import { accountIdFromJwt, discoverCodexCredential } from "../src/codex-credential.ts";

const jwt = (payload: unknown) =>
  `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;

describe("Codex credential discovery", () => {
  it("reads snake-case tokens and derives the account ID from the ID token", () => {
    const credential = discoverCodexCredential({
      environment: { CODEX_HOME: "/isolated/codex" },
      read: (path) => {
        expect(path).toBe(join("/isolated/codex", "auth.json"));
        return JSON.stringify({
          tokens: {
            access_token: "access",
            id_token: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "account-1" } }),
          },
        });
      },
    });
    expect(credential).toEqual({ accessToken: "access", accountId: "account-1" });
  });

  it("keeps a personal access token separate from OAuth credentials", () => {
    const credential = discoverCodexCredential({
      environment: { CODEX_HOME: "/isolated/codex" },
      read: () =>
        JSON.stringify({
          personal_access_token: "  at-personal-token  ",
          tokens: { access_token: "oauth-access" },
        }),
    });
    expect(credential).toEqual({
      accessToken: "oauth-access",
      personalAccessToken: "at-personal-token",
    });
  });

  it("matches Swift auth.json API-key precedence over OAuth tokens", () => {
    const credential = discoverCodexCredential({
      environment: { CODEX_HOME: "/isolated/codex" },
      read: () =>
        JSON.stringify({
          OPENAI_API_KEY: "  sk-api-key  ",
          tokens: {
            access_token: "oauth-access",
            id_token: jwt({ chatgpt_account_id: "oauth-account" }),
            account_id: "oauth-account",
          },
        }),
    });
    expect(credential).toEqual({ accessToken: "sk-api-key" });
  });

  it("fails closed for malformed or unreadable credential files", () => {
    expect(
      discoverCodexCredential({
        read: () => {
          throw new Error("locked");
        },
      }),
    ).toEqual({});
    expect(accountIdFromJwt("not-a-jwt")).toBeUndefined();
    expect(accountIdFromJwt(`header.${Buffer.from("{}").toString("base64url")}`)).toBeUndefined();
  });

  it("matches Swift account claim precedence and organization fallback", () => {
    expect(
      accountIdFromJwt(
        jwt({
          chatgpt_account_id: "direct",
          "https://api.openai.com/auth": { chatgpt_account_id: "namespaced" },
          organizations: [{ id: "organization" }],
        }),
      ),
    ).toBe("direct");
    expect(accountIdFromJwt(jwt({ organizations: [{ id: "first" }, { id: "second" }] }))).toBe(
      "first",
    );
  });
});
