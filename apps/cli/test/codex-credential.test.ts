import { describe, expect, it } from "vite-plus/test";

import { accountIdFromJwt, discoverCodexCredential } from "../src/codex-credential.ts";

const jwt = (payload: unknown) =>
  `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;

describe("Codex credential discovery", () => {
  it("reads snake-case tokens and derives the account ID from the ID token", () => {
    const credential = discoverCodexCredential({
      environment: { CODEX_HOME: "/isolated/codex" },
      read: (path) => {
        expect(path).toBe("/isolated/codex/auth.json");
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

  it("fails closed for malformed or unreadable credential files", () => {
    expect(
      discoverCodexCredential({
        read: () => {
          throw new Error("locked");
        },
      }),
    ).toEqual({});
    expect(accountIdFromJwt("not-a-jwt")).toBeUndefined();
  });
});
