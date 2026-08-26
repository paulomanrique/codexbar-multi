import { describe, expect, it } from "vite-plus/test";

import {
  normalizeMiniMaxCookieCredential,
  type MiniMaxCookieCredential,
} from "../src/providers/minimax-credential.ts";

describe("MiniMax cookie credential normalization", () => {
  it.each([
    ["session=abc", { cookieHeader: "session=abc" }],
    [" Cookie: session=abc ", { cookieHeader: "session=abc" }],
    [`Cookie: "session=abc"`, { cookieHeader: "session=abc" }],
    [`Cookie: 'session=abc'`, { cookieHeader: "session=abc" }],
    [
      `curl https://platform.minimaxi.com -H 'Cookie: session=abc'`,
      { cookieHeader: "session=abc" },
    ],
    [
      `curl https://platform.minimaxi.com -H "Cookie: session=abc"`,
      { cookieHeader: "session=abc" },
    ],
    [
      `curl https://platform.minimaxi.com -H 'accept: */*' -H 'Cookie: session=abc' -H 'sec-fetch-site: same-origin'`,
      { cookieHeader: "session=abc" },
    ],
    [`curl https://platform.minimaxi.com -H Cookie:session=abc`, { cookieHeader: "session=abc" }],
    [`curl https://platform.minimaxi.com --cookie 'session=abc'`, { cookieHeader: "session=abc" }],
    [`curl https://platform.minimaxi.com --cookie "session=abc"`, { cookieHeader: "session=abc" }],
    [`curl https://platform.minimaxi.com --cookie session=abc`, { cookieHeader: "session=abc" }],
    [`curl https://platform.minimaxi.com -b 'session=abc'`, { cookieHeader: "session=abc" }],
    [`curl https://platform.minimaxi.com -b "session=abc"`, { cookieHeader: "session=abc" }],
    [`curl https://platform.minimaxi.com -b session=abc`, { cookieHeader: "session=abc" }],
    [
      `Cookie: session=abc; minimax_group_id_v2=12345`,
      { cookieHeader: "session=abc; minimax_group_id_v2=12345", groupId: "12345" },
    ],
    [
      `curl 'https://api.minimax.chat/v1?group_id=4567' -H 'Cookie: session=abc'`,
      { cookieHeader: "session=abc", groupId: "4567" },
    ],
    [
      `curl 'https://api.minimax.chat/v1?groupid=5678' -H 'Cookie: session=abc'`,
      { cookieHeader: "session=abc", groupId: "5678" },
    ],
    [
      `Cookie: session=abc\nAuthorization: Bearer token._-+=/123`,
      { cookieHeader: "session=abc", authorizationToken: "token._-+=/123" },
    ],
    [
      `Cookie: session=abc\nAuthorization: Bearer token._-+=/123\nx-group-id: 6789`,
      { cookieHeader: "session=abc", authorizationToken: "token._-+=/123", groupId: "6789" },
    ],
    [
      `curl https://platform.minimaxi.com \\
  -H 'Cookie: session=abc' \\
  -H 'Authorization: Bearer token._-+=/123' \\
  -H 'x-group-id: 7890'`,
      { cookieHeader: "session=abc", authorizationToken: "token._-+=/123", groupId: "7890" },
    ],
  ] as const)("accepts %s", (raw, expected) => {
    expect(normalizeMiniMaxCookieCredential(raw)).toEqual(
      expected satisfies MiniMaxCookieCredential,
    );
  });

  it.each([
    undefined,
    "",
    "not-a-cookie",
    "session",
    "=abc",
    "Cookie: session=abc\r\nInjected: yes",
    "Cookie: session=abc\nInjected: yes",
    "Cookie: session=abc\nX-Other: yes",
    "curl https://platform.minimaxi.com \\\nInjected: yes\n-H 'Cookie: session=abc'",
    "curl https://platform.minimaxi.com -H 'Cookie: session=abc\r\nInjected: yes'",
    "session=abc\0",
    `session=${"a".repeat(1024 * 1024)}`,
    `Cookie: ${"a".repeat(1024 * 1024 - "Cookie: ".length)}=x`,
  ] as const)("rejects %s", (raw) => {
    expect(normalizeMiniMaxCookieCredential(raw)).toBeUndefined();
  });

  it("rejects final extracted cookies at or above one MiB", () => {
    const hugeCookie = `session=${"a".repeat(1024 * 1024 - "session=".length)}`;
    expect(
      normalizeMiniMaxCookieCredential(
        `curl https://platform.minimaxi.com -H 'Cookie: ${hugeCookie}'`,
      ),
    ).toBeUndefined();
  });

  it("never returns line breaks from extracted fields", () => {
    const credential = normalizeMiniMaxCookieCredential(
      `Cookie: session=abc\r\nAuthorization: Bearer token._-+=/123\r\nx-group-id: 1234`,
    );
    expect(credential).toEqual({
      cookieHeader: "session=abc",
      authorizationToken: "token._-+=/123",
      groupId: "1234",
    });
    expect(Object.values(credential ?? {}).every((value) => !/[\r\n]/u.test(value))).toBe(true);
  });

  it("keeps bearer and group extraction bounded to the MiniMax patterns", () => {
    expect(
      normalizeMiniMaxCookieCredential(
        "Cookie: session=abc\nAuthorization: Bearer token._-+=/123!ignored\nx-group-id: 123",
      ),
    ).toEqual({ cookieHeader: "session=abc", authorizationToken: "token._-+=/123" });
  });
});
