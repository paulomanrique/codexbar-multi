import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import {
  sha256Hex,
  type CredentialStoreService,
  type PersistedCodexBarConfig,
} from "@codexbar/core";
import {
  resolveSelectedFirstPartyAccountFromVault,
  tokenAccountVaultKey,
} from "../src/token-account-vault-config.ts";

const jwt = (payload: Record<string, unknown>): string => {
  const encoded = btoa(JSON.stringify(payload))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
  return `header.${encoded}.signature`;
};

const config = (
  providerId = "antigravity",
  activeIndex = 0,
  ids: readonly string[] = ["account-0"],
): PersistedCodexBarConfig => ({
  version: 1,
  providers: [
    {
      id: providerId,
      extensions: {},
      tokenAccounts: {
        version: 2,
        activeIndex,
        accounts: ids.map((id, index) => ({
          id,
          label: `Account ${index}`,
          addedAt: index,
        })),
      },
    },
  ],
});

const store = (values: Readonly<Record<string, string>>): CredentialStoreService => ({
  read: (key) => Effect.succeed(values[key]),
  write: () => Effect.void,
  remove: () => Effect.void,
});

const resolve = (
  input: PersistedCodexBarConfig,
  providerId: Parameters<typeof resolveSelectedFirstPartyAccountFromVault>[2],
  values: Readonly<Record<string, string>>,
) => Effect.runPromise(resolveSelectedFirstPartyAccountFromVault(input, store(values), providerId));

describe("first-party selected accounts from the token-account vault", () => {
  it("uses the stable provider/account credential key", () => {
    expect(tokenAccountVaultKey("claude", "account-1")).toBe(
      `token-account/v1/${sha256Hex("claude:account-1")}`,
    );
  });

  it("clamps activeIndex and exposes only the Antigravity refresh fields", async () => {
    const selected = await resolve(
      config("antigravity", 99, ["first", "selected"]),
      "antigravity",
      {
        [tokenAccountVaultKey("antigravity", "selected")]: JSON.stringify({
          access_token: "access",
          refresh_token: "refresh",
          id_token: jwt({ email: "jwt@example.com" }),
          email: "stored@example.com",
          project_id: "project",
          client_id: "client",
          client_secret: "secret",
        }),
      },
    );
    expect(selected).toEqual({
      id: "selected",
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

  it("fails closed for missing or malformed selected vault material", async () => {
    await expect(resolve(config("antigravity"), "antigravity", {})).rejects.toMatchObject({
      name: "ClassifiedFetchFailure",
      kind: "missing-credential",
    });
    await expect(
      resolve(config("antigravity"), "antigravity", {
        [tokenAccountVaultKey("antigravity", "account-0")]: "not-json",
      }),
    ).rejects.toMatchObject({ kind: "missing-credential" });
  });

  it("rejects duplicate account IDs before reading credential material", async () => {
    let reads = 0;
    const credentials: CredentialStoreService = {
      read: () =>
        Effect.sync(() => {
          reads += 1;
          return "must-not-be-read";
        }),
      write: () => Effect.void,
      remove: () => Effect.void,
    };

    await expect(
      Effect.runPromise(
        resolveSelectedFirstPartyAccountFromVault(
          config("grok", 0, ["duplicate", "duplicate"]),
          credentials,
          "grok",
        ),
      ),
    ).rejects.toMatchObject({ kind: "missing-credential" });
    expect(reads).toBe(0);
  });

  it("maps selected Codex auth.json material without exposing refresh tokens", async () => {
    const key = tokenAccountVaultKey("codex", "account-0");
    await expect(
      resolve(
        {
          ...config("codex"),
          providers: [
            {
              id: "codex",
              extensions: {},
              tokenAccounts: {
                version: 2,
                activeIndex: 0,
                accounts: [
                  {
                    id: "account-0",
                    label: "Codex Pro",
                    addedAt: 0,
                    externalIdentifier: "acct-selected",
                  },
                ],
              },
            },
          ],
        },
        "codex",
        {
          [key]: JSON.stringify({
            tokens: {
              access_token: "selected-oauth",
              refresh_token: "must-not-escape",
              id_token: jwt({ email: "selected@example.test" }),
              account_id: "acct-selected",
            },
          }),
        },
      ),
    ).resolves.toEqual({
      id: "account-0",
      externalIdentifier: "acct-selected",
      secureSettings: {
        CODEX_ACCESS_TOKEN: "selected-oauth",
        CODEX_PERSONAL_ACCESS_TOKEN: null,
      },
      plainSettings: { CODEX_ACCOUNT_ID: "acct-selected" },
    });
  });

  it("fails closed for invalid selected Codex account metadata before exposing settings", async () => {
    const key = tokenAccountVaultKey("codex", "account-0");
    await expect(
      resolve(
        {
          ...config("codex"),
          providers: [
            {
              id: "codex",
              extensions: {},
              tokenAccounts: {
                version: 2,
                activeIndex: 0,
                accounts: [
                  {
                    id: "account-0",
                    label: "Codex Pro",
                    addedAt: 0,
                    externalIdentifier: "bad\naccount",
                  },
                ],
              },
            },
          ],
        },
        "codex",
        {
          [key]: JSON.stringify({
            tokens: {
              access_token: "selected-oauth",
              account_id: "acct-selected",
            },
          }),
        },
      ),
    ).rejects.toMatchObject({ kind: "missing-credential" });
  });

  it.each([
    ["direct ID-token claim", { chatgpt_account_id: "acct-direct" }, "acct-direct"],
    [
      "namespaced ID-token claim",
      { "https://api.openai.com/auth": { chatgpt_account_id: "acct-namespaced" } },
      "acct-namespaced",
    ],
    [
      "first organization ID-token claim",
      { organizations: [{ id: "org-first" }, { id: "org-second" }] },
      "org-first",
    ],
  ] as const)(
    "derives a selected Codex account from the %s",
    async (_label, payload, accountId) => {
      const key = tokenAccountVaultKey("codex", "account-0");
      await expect(
        resolve(config("codex"), "codex", {
          [key]: JSON.stringify({
            tokens: {
              access_token: "selected-oauth",
              refresh_token: "selected-refresh",
              id_token: jwt(payload),
            },
          }),
        }),
      ).resolves.toMatchObject({ plainSettings: { CODEX_ACCOUNT_ID: accountId } });
    },
  );

  it("falls back to selected Codex access-token claims but prefers an explicit account ID", async () => {
    const key = tokenAccountVaultKey("codex", "account-0");
    await expect(
      resolve(config("codex"), "codex", {
        [key]: JSON.stringify({
          tokens: {
            access_token: jwt({ organizations: [{ id: "org-from-access" }] }),
            refresh_token: "selected-refresh",
            account_id: "acct-explicit",
            id_token: jwt({ chatgpt_account_id: "acct-from-id-token" }),
          },
        }),
      }),
    ).resolves.toMatchObject({ plainSettings: { CODEX_ACCOUNT_ID: "acct-explicit" } });

    await expect(
      resolve(config("codex"), "codex", {
        [key]: JSON.stringify({
          tokens: {
            access_token: jwt({ organizations: [{ id: "org-from-access" }] }),
            refresh_token: "selected-refresh",
          },
        }),
      }),
    ).resolves.toMatchObject({ plainSettings: { CODEX_ACCOUNT_ID: "org-from-access" } });
  });

  it("maps selected Codex personal access tokens and suppresses ambient OAuth", async () => {
    const key = tokenAccountVaultKey("codex", "account-0");
    await expect(
      resolve(config("codex"), "codex", {
        [key]: JSON.stringify({
          personal_access_token: "  at-selected  ",
          tokens: { access_token: "oauth-fallback", refresh_token: "oauth-refresh" },
        }),
      }),
    ).resolves.toEqual({
      id: "account-0",
      secureSettings: {
        CODEX_ACCESS_TOKEN: "oauth-fallback",
        CODEX_PERSONAL_ACCESS_TOKEN: "at-selected",
      },
      plainSettings: { CODEX_ACCOUNT_ID: null },
    });
  });

  it("matches Swift selected Codex API-key precedence over OAuth tokens", async () => {
    const key = tokenAccountVaultKey("codex", "account-0");
    await expect(
      resolve(config("codex"), "codex", {
        [key]: JSON.stringify({
          OPENAI_API_KEY: "  sk-api-key  ",
          tokens: {
            access_token: "oauth-access",
            id_token: jwt({ chatgpt_account_id: "oauth-account" }),
            account_id: "oauth-account",
          },
        }),
      }),
    ).resolves.toEqual({
      id: "account-0",
      secureSettings: {
        CODEX_ACCESS_TOKEN: "sk-api-key",
        CODEX_PERSONAL_ACCESS_TOKEN: null,
      },
      plainSettings: { CODEX_ACCOUNT_ID: null },
    });
  });

  it.each([
    "",
    "could-be-any-legacy-format",
    "null",
    JSON.stringify({ tokens: { refresh_token: "refresh-only" } }),
    JSON.stringify({ tokens: { access_token: "access-only" } }),
    JSON.stringify({ tokens: { access_token: "" } }),
    `{"tokens":{"access_token":"${"x".repeat(1024 * 1024)}"}}`,
    `${JSON.stringify({ tokens: { access_token: "selected" } })}\u0000`,
  ])("fails closed for invalid selected Codex material", async (material) => {
    const key = tokenAccountVaultKey("codex", "account-0");
    await expect(resolve(config("codex"), "codex", { [key]: material })).rejects.toMatchObject({
      kind: "missing-credential",
    });
  });

  it.each([
    ["sid=selected", "sid=selected", "qoder.com"],
    ["Cookie: sid=selected", "sid=selected", "qoder.com"],
    ["curl https://qoder.com.cn -H 'Cookie: sid=selected'", "sid=selected", "qoder.com.cn"],
  ] as const)(
    "normalizes a selected Qoder credential from %s",
    async (material, cookieHeader, site) => {
      const key = tokenAccountVaultKey("qoder", "account-0");
      await expect(resolve(config("qoder"), "qoder", { [key]: material })).resolves.toEqual({
        id: "account-0",
        secureSettings: { QODER_COOKIE_HEADER: cookieHeader },
        plainSettings: { QODER_SITE: site },
      });
    },
  );

  it.each([
    "",
    "not-a-cookie",
    "sid=value\u0000suffix",
    "curl https://example.com -H 'Cookie: sid=value'",
    "curl https://qoder.com https://qoder.com.cn -H 'Cookie: sid=value'",
    "x".repeat(1024 * 1024),
    `sid=${"x".repeat(1024 * 1024)}`,
  ])("fails closed for invalid selected Qoder material", async (material) => {
    const key = tokenAccountVaultKey("qoder", "account-0");
    await expect(resolve(config("qoder"), "qoder", { [key]: material })).rejects.toMatchObject({
      kind: "missing-credential",
    });
  });

  it.each([
    ["session=selected", "session=selected", undefined, undefined],
    [
      "Cookie: session=selected\nAuthorization: Bearer selected-bearer\nx-group-id: 123456",
      "session=selected",
      "selected-bearer",
      "123456",
    ],
    [
      "curl 'https://platform.minimax.io/v1/api/openplatform/coding_plan/remains?GroupId=654321' -H 'Cookie: session=selected'",
      "session=selected",
      undefined,
      "654321",
    ],
  ] as const)(
    "normalizes a selected MiniMax credential from %s",
    async (material, cookieHeader, authorizationToken, groupId) => {
      const key = tokenAccountVaultKey("minimax", "account-0");
      await expect(resolve(config("minimax"), "minimax", { [key]: material })).resolves.toEqual({
        id: "account-0",
        secureSettings: {
          MINIMAX_COOKIE: null,
          MINIMAX_COOKIE_HEADER: cookieHeader,
          MINIMAX_AUTHORIZATION_TOKEN: authorizationToken ?? null,
          MINIMAX_API_TOKEN: null,
          MINIMAX_API_KEY: null,
          MINIMAX_CODING_API_KEY: null,
          MINIMAX_GROUP_ID: groupId ?? null,
        },
      });
    },
  );

  it.each([
    "",
    "not-a-cookie",
    "session=value\u0000suffix",
    "Cookie: session=value\nInjected: yes",
    "x".repeat(1024 * 1024),
    `session=${"x".repeat(1024 * 1024)}`,
  ])("fails closed for invalid selected MiniMax material", async (material) => {
    const key = tokenAccountVaultKey("minimax", "account-0");
    await expect(resolve(config("minimax"), "minimax", { [key]: material })).rejects.toMatchObject({
      kind: "missing-credential",
    });
  });

  it.each([
    ["session=selected", "Cookie: session=selected"],
    [
      "access-token=selected.jwt.token; session=selected",
      "Cookie: access-token=selected.jwt.token; session=selected\nAuthorization: Bearer selected.jwt.token",
    ],
    ["Authorization: Bearer selected-token", "Authorization: Bearer selected-token"],
    [
      "Cookie: session=selected\nAuthorization: Bearer selected-token",
      "Cookie: session=selected\nAuthorization: Bearer selected-token",
    ],
  ] as const)("normalizes a selected Factory credential from %s", async (material, expected) => {
    const key = tokenAccountVaultKey("factory", "account-0");
    await expect(resolve(config("factory"), "factory", { [key]: material })).resolves.toEqual({
      id: "account-0",
      secureSettings: {
        FACTORY_COOKIE_HEADER: expected,
        FACTORY_API_KEY: null,
      },
    });
  });

  it.each([
    "",
    "definitely not a cookie or bearer",
    "short-token",
    "Cookie: session=value\nInjected: yes",
    "Cookie: session=value\rInjected: yes",
    "session=value\u0000suffix",
    "x".repeat(1024 * 1024),
    `session=${"x".repeat(1024 * 1024)}`,
  ])("fails closed for invalid selected Factory material", async (material) => {
    const key = tokenAccountVaultKey("factory", "account-0");
    await expect(resolve(config("factory"), "factory", { [key]: material })).rejects.toMatchObject({
      kind: "missing-credential",
    });
  });

  it.each([
    ["opaque-session", "__Secure-session=opaque-session"],
    ["foo=bar", "__Secure-session=foo=bar"],
    ["__secure-session=current", "__Secure-session=current"],
    ["wos-session=workos; theme=dark", "wos-session=workos; theme=dark"],
    [
      "next-auth.session-token.0=chunk-zero; next-auth.session-token.1=chunk-one",
      "next-auth.session-token.0=chunk-zero; next-auth.session-token.1=chunk-one",
    ],
    ["theme=dark; locale=en", "theme=dark; locale=en"],
    [
      "curl https://ollama.com -H 'Cookie: aid=aux; __Secure-session=curl-session'",
      "aid=aux; __Secure-session=curl-session",
    ],
    [
      "curl https://ollama.com --cookie '__Secure-session=option-session'",
      "__Secure-session=option-session",
    ],
    [
      "curl https://ollama.com -b'__Secure-session=short-session'",
      "__Secure-session=short-session",
    ],
  ] as const)("normalizes a selected Ollama session from %s", async (material, expected) => {
    const key = tokenAccountVaultKey("ollama", "account-0");
    await expect(resolve(config("ollama"), "ollama", { [key]: material })).resolves.toEqual({
      id: "account-0",
      secureSettings: {
        OLLAMA_COOKIE: expected,
        OLLAMA_API_KEY: null,
        OLLAMA_KEY: null,
      },
    });
  });

  it.each([
    "",
    "curl https://ollama.com/settings",
    "opaque\r\nInjected: yes",
    "opaque\u0000suffix",
    "x".repeat(1024 * 1024),
    `__Secure-session=${"x".repeat(1024 * 1024)}`,
  ])("fails closed for invalid selected Ollama material", async (material) => {
    const key = tokenAccountVaultKey("ollama", "account-0");
    await expect(resolve(config("ollama"), "ollama", { [key]: material })).rejects.toMatchObject({
      kind: "missing-credential",
    });
  });

  it.each([
    ["bare-session", "session_id=bare-session"],
    ["session_id=selected; theme=dark", "session_id=selected"],
    ["Session_ID=case-insensitive; theme=dark", "session_id=case-insensitive"],
    [
      "curl https://manus.im -H 'Cookie: theme=dark; session_id=from-curl; other=value'",
      "session_id=from-curl",
    ],
  ] as const)("normalizes a selected Manus session from %s", async (material, expected) => {
    const key = tokenAccountVaultKey("manus", "account-0");
    await expect(resolve(config("manus"), "manus", { [key]: material })).resolves.toEqual({
      id: "account-0",
      secureSettings: { MANUS_COOKIE_HEADER: expected },
    });
  });

  it.each([
    "",
    "theme=dark",
    "session_id=",
    "session_id=value\nInjected: yes",
    "session_id=value\rInjected: yes",
    "session_id=value\u0000suffix",
    "x".repeat(1024 * 1024),
    `session_id=${"x".repeat(1024 * 1024)}`,
  ])("fails closed for invalid selected Manus material", async (material) => {
    const key = tokenAccountVaultKey("manus", "account-0");
    await expect(resolve(config("manus"), "manus", { [key]: material })).rejects.toMatchObject({
      kind: "missing-credential",
    });
  });

  it.each([
    ["bare-oasis-token", "bare-oasis-token"],
    ["Oasis-Token=selected-token; Oasis-Webid=device", "selected-token"],
    [
      "curl https://platform.stepfun.com -H 'Cookie: Oasis-Token=curl-token; theme=dark'",
      "curl-token",
    ],
  ] as const)("normalizes a selected StepFun token from %s", async (material, expected) => {
    const key = tokenAccountVaultKey("stepfun", "account-0");
    await expect(resolve(config("stepfun"), "stepfun", { [key]: material })).resolves.toEqual({
      id: "account-0",
      secureSettings: { STEPFUN_TOKEN: expected },
    });
  });

  it.each([
    "",
    "Oasis-Token=",
    "Oasis-Token=value\nInjected: yes",
    "Oasis-Token=value\rInjected: yes",
    "Oasis-Token=value\u0000suffix",
    `Oasis-Token=${"x".repeat(1024 * 1024)}`,
  ])("fails closed for invalid selected StepFun material", async (material) => {
    const key = tokenAccountVaultKey("stepfun", "account-0");
    await expect(resolve(config("stepfun"), "stepfun", { [key]: material })).rejects.toMatchObject({
      kind: "missing-credential",
    });
  });

  it.each([
    ["abacus", "ABACUS_COOKIE_HEADER"],
    ["augment", "AUGMENT_COOKIE_HEADER"],
    ["cursor", "CURSOR_COOKIE"],
    ["mistral", "MISTRAL_COOKIE_HEADER"],
  ] as const)(
    "selects a normalized %s cookie without ambient fallback",
    async (providerId, key) => {
      const credentialKey = tokenAccountVaultKey(providerId, "account-0");
      const base = config(providerId);
      const input =
        providerId === "cursor"
          ? {
              ...base,
              providers: base.providers.map((provider) => ({
                ...provider,
                cookieSource: "manual" as const,
              })),
            }
          : base;
      await expect(
        resolve(input, providerId, {
          [credentialKey]: "curl https://example.test -H 'Cookie: session=selected; csrf=secret'",
        }),
      ).resolves.toEqual({
        id: "account-0",
        secureSettings: { [key]: "session=selected; csrf=secret" },
      });

      for (const material of ["", "   ", "''", "cookie\u0000=value", "x".repeat(1024 * 1024 + 1)]) {
        await expect(
          resolve(input, providerId, { [credentialKey]: material }),
        ).rejects.toMatchObject({ kind: "missing-credential" });
      }
    },
  );

  it("keeps a saved Cursor account passive while cookie source is automatic", async () => {
    const base = config("cursor");
    const input = (cookieSource: "auto" | "manual"): PersistedCodexBarConfig => ({
      ...base,
      providers: base.providers.map((provider) => ({ ...provider, cookieSource })),
    });
    let reads = 0;
    const credentials: CredentialStoreService = {
      read: () =>
        Effect.sync(() => {
          reads += 1;
          return "WorkosCursorSessionToken=saved";
        }),
      write: () => Effect.void,
      remove: () => Effect.void,
    };
    await expect(
      Effect.runPromise(
        resolveSelectedFirstPartyAccountFromVault(input("auto"), credentials, "cursor"),
      ),
    ).resolves.toBeUndefined();
    expect(reads).toBe(0);

    await expect(
      Effect.runPromise(
        resolveSelectedFirstPartyAccountFromVault(input("manual"), credentials, "cursor"),
      ),
    ).resolves.toEqual({
      id: "account-0",
      secureSettings: { CURSOR_COOKIE: "WorkosCursorSessionToken=saved" },
    });
    expect(reads).toBe(1);
  });

  it.each([
    [
      "provider=google; auth=session123; theme=dark; __Host-auth=host456",
      "auth=session123; __Host-auth=host456",
    ],
    [
      "curl https://opencode.ai -H 'Cookie: auth=first; auth=second; provider=google'",
      "auth=first; auth=second",
    ],
    [
      "curl https://opencode.ai --cookie '__Host-auth=host-only; theme=dark'",
      "__Host-auth=host-only",
    ],
  ] as const)("selects only exact OpenCode auth cookies from %s", async (material, expected) => {
    const key = tokenAccountVaultKey("opencode", "account-0");
    await expect(resolve(config("opencode"), "opencode", { [key]: material })).resolves.toEqual({
      id: "account-0",
      secureSettings: { OPENCODE_COOKIE: expected },
    });
  });

  it.each([
    "",
    "account-token",
    "provider=google; theme=dark",
    "Auth=wrong-case; AUTH=also-wrong; __host-auth=wrong-case",
    "auth=value\u0000suffix",
    `auth=value; ignored=${"x".repeat(1024 * 1024)}`,
  ])("fails closed for invalid selected OpenCode cookie material", async (material) => {
    const key = tokenAccountVaultKey("opencode", "account-0");
    await expect(
      resolve(config("opencode"), "opencode", { [key]: material }),
    ).rejects.toMatchObject({ kind: "missing-credential" });
  });

  it.each([
    [
      "provider=google; auth=go-session; theme=dark; __Host-auth=go-host",
      "auth=go-session; __Host-auth=go-host",
    ],
    ["curl https://opencode.ai -H 'Cookie: auth=first; auth=second'", "auth=first; auth=second"],
  ] as const)("selects only exact OpenCode Go auth cookies from %s", async (material, expected) => {
    const key = tokenAccountVaultKey("opencodego", "account-0");
    await expect(resolve(config("opencodego"), "opencodego", { [key]: material })).resolves.toEqual(
      {
        id: "account-0",
        secureSettings: { OPENCODEGO_COOKIE: expected, OPENCODE_API_KEY: null },
      },
    );
  });

  it.each([
    "",
    "account-token",
    "provider=google; theme=dark",
    "Auth=wrong-case; __host-auth=wrong-case",
    "auth=value\u0000suffix",
    `auth=value; ignored=${"x".repeat(1024 * 1024)}`,
  ])("fails closed for invalid selected OpenCode Go cookie material", async (material) => {
    const key = tokenAccountVaultKey("opencodego", "account-0");
    await expect(
      resolve(config("opencodego"), "opencodego", { [key]: material }),
    ).rejects.toMatchObject({ kind: "missing-credential" });
  });

  it("selects an opaque Copilot token without inheriting the ambient API key", async () => {
    const key = tokenAccountVaultKey("copilot", "account-0");
    await expect(
      resolve(config("copilot"), "copilot", { [key]: " 'github-selected-token' " }),
    ).resolves.toEqual({
      id: "account-0",
      secureSettings: { COPILOT_API_TOKEN: "github-selected-token" },
    });

    for (const material of ["", "   ", "''", "token\u0000value", "x".repeat(1024 * 1024 + 1)]) {
      await expect(
        resolve(config("copilot"), "copilot", { [key]: material }),
      ).rejects.toMatchObject({ kind: "missing-credential" });
    }
  });

  it("selects a cleaned DeepInfra API key without inheriting ambient aliases", async () => {
    const key = tokenAccountVaultKey("deepinfra", "account-0");
    await expect(
      resolve(config("deepinfra"), "deepinfra", { [key]: '  "deepinfra-selected"  ' }),
    ).resolves.toEqual({
      id: "account-0",
      secureSettings: { DEEPINFRA_API_KEY: "deepinfra-selected", DEEPINFRA_TOKEN: null },
    });

    for (const material of ["", "   ", "''", "token\u0000value", "x".repeat(1024 * 1024 + 1)]) {
      await expect(
        resolve(config("deepinfra"), "deepinfra", { [key]: material }),
      ).rejects.toMatchObject({ kind: "missing-credential" });
    }
  });

  it("selects a cleaned Groq API key without adding account metadata", async () => {
    const key = tokenAccountVaultKey("groq", "account-0");
    await expect(
      resolve(config("groq"), "groq", { [key]: "  'groq-selected'  " }),
    ).resolves.toEqual({
      id: "account-0",
      secureSettings: { GROQ_API_KEY: "groq-selected" },
    });

    for (const material of ["", "   ", "''", "token\u0000value", "x".repeat(1024 * 1024 + 1)]) {
      await expect(resolve(config("groq"), "groq", { [key]: material })).rejects.toMatchObject({
        kind: "missing-credential",
      });
    }
  });

  it("selects a canonical Venice API key and scrubs its ambient alias", async () => {
    const key = tokenAccountVaultKey("venice", "account-0");
    await expect(
      resolve(config("venice"), "venice", { [key]: '  "venice-selected"  ' }),
    ).resolves.toEqual({
      id: "account-0",
      secureSettings: { VENICE_API_KEY: "venice-selected", VENICE_KEY: null },
    });

    for (const material of ["", "   ", "''", "token\u0000value", "x".repeat(1024 * 1024 + 1)]) {
      await expect(resolve(config("venice"), "venice", { [key]: material })).rejects.toMatchObject({
        kind: "missing-credential",
      });
    }
  });

  it("selects a canonical ElevenLabs API key and scrubs XI_API_KEY", async () => {
    const key = tokenAccountVaultKey("elevenlabs", "account-0");
    await expect(
      resolve(config("elevenlabs"), "elevenlabs", { [key]: "  'eleven-selected'  " }),
    ).resolves.toEqual({
      id: "account-0",
      secureSettings: { ELEVENLABS_API_KEY: "eleven-selected", XI_API_KEY: null },
    });

    for (const material of ["", "   ", "''", "token\u0000value", "x".repeat(1024 * 1024 + 1)]) {
      await expect(
        resolve(config("elevenlabs"), "elevenlabs", { [key]: material }),
      ).rejects.toMatchObject({ kind: "missing-credential" });
    }
  });

  it("selects a cleaned IBM Bob key without adding account metadata", async () => {
    const key = tokenAccountVaultKey("ibmbob", "account-0");
    await expect(
      resolve(config("ibmbob"), "ibmbob", { [key]: '  "ibm-selected"  ' }),
    ).resolves.toEqual({
      id: "account-0",
      secureSettings: { BOBSHELL_API_KEY: "ibm-selected" },
    });

    for (const material of ["", "   ", "''", "token\u0000value", "x".repeat(1024 * 1024 + 1)]) {
      await expect(resolve(config("ibmbob"), "ibmbob", { [key]: material })).rejects.toMatchObject({
        kind: "missing-credential",
      });
    }
  });

  it("selects a canonical Neuralwatt key without copying its global endpoint", async () => {
    const key = tokenAccountVaultKey("neuralwatt", "account-0");
    await expect(
      resolve(config("neuralwatt"), "neuralwatt", { [key]: "  'neural-selected'  " }),
    ).resolves.toEqual({
      id: "account-0",
      secureSettings: { NEURALWATT_API_KEY: "neural-selected" },
    });

    for (const material of ["", "   ", "''", "token\u0000value", "x".repeat(1024 * 1024 + 1)]) {
      await expect(
        resolve(config("neuralwatt"), "neuralwatt", { [key]: material }),
      ).rejects.toMatchObject({ kind: "missing-credential" });
    }
  });

  it("selects a canonical sub2api key without copying its global base URL", async () => {
    const key = tokenAccountVaultKey("sub2api", "account-0");
    await expect(
      resolve(config("sub2api"), "sub2api", { [key]: '  "sub2api-selected"  ' }),
    ).resolves.toEqual({
      id: "account-0",
      secureSettings: { SUB2API_API_KEY: "sub2api-selected" },
    });

    for (const material of ["", "   ", "''", "token\u0000value", "x".repeat(1024 * 1024 + 1)]) {
      await expect(
        resolve(config("sub2api"), "sub2api", { [key]: material }),
      ).rejects.toMatchObject({ kind: "missing-credential" });
    }
  });

  it("selects a canonical LLM Proxy key without copying its global base URL", async () => {
    const key = tokenAccountVaultKey("llmproxy", "account-0");
    await expect(
      resolve(config("llmproxy"), "llmproxy", { [key]: "  'proxy-selected'  " }),
    ).resolves.toEqual({
      id: "account-0",
      secureSettings: { LLM_PROXY_API_KEY: "proxy-selected" },
    });

    for (const material of ["", "   ", "''", "token\u0000value", "x".repeat(1024 * 1024 + 1)]) {
      await expect(
        resolve(config("llmproxy"), "llmproxy", { [key]: material }),
      ).rejects.toMatchObject({
        kind: "missing-credential",
      });
    }
  });

  it("selects a canonical LiteLLM key without copying its global base URL", async () => {
    const key = tokenAccountVaultKey("litellm", "account-0");
    await expect(
      resolve(config("litellm"), "litellm", { [key]: "  'litellm-selected'  " }),
    ).resolves.toEqual({
      id: "account-0",
      secureSettings: { LITELLM_API_KEY: "litellm-selected" },
    });

    for (const material of ["", "   ", "''", "token\u0000value", "x".repeat(1024 * 1024 + 1)]) {
      await expect(
        resolve(config("litellm"), "litellm", { [key]: material }),
      ).rejects.toMatchObject({ kind: "missing-credential" });
    }
  });

  it("selects a canonical DeepSeek key while suppressing ambient platform context", async () => {
    const key = tokenAccountVaultKey("deepseek", "account-0");
    await expect(
      resolve(config("deepseek"), "deepseek", { [key]: "  'deepseek-selected'  " }),
    ).resolves.toEqual({
      id: "account-0",
      secureSettings: {
        DEEPSEEK_API_KEY: "deepseek-selected",
        DEEPSEEK_KEY: null,
        DEEPSEEK_PLATFORM_TOKEN: null,
        DEEPSEEK_USER_TOKEN: null,
      },
      plainSettings: {
        CODEXBAR_DEEPSEEK_PROFILE_ID: null,
        CODEXBAR_DEEPSEEK_PROFILE_SCOPE: null,
      },
    });

    for (const material of ["", "   ", "''", "token\u0000value", "x".repeat(1024 * 1024 + 1)]) {
      await expect(
        resolve(config("deepseek"), "deepseek", { [key]: material }),
      ).rejects.toMatchObject({ kind: "missing-credential" });
    }
  });

  it("selects a canonical OpenAI Admin key while suppressing legacy key and project scope", async () => {
    const key = tokenAccountVaultKey("openai", "account-0");
    await expect(
      resolve(config("openai"), "openai", { [key]: "  'openai-selected'  " }),
    ).resolves.toEqual({
      id: "account-0",
      secureSettings: {
        OPENAI_ADMIN_KEY: "openai-selected",
        OPENAI_API_KEY: null,
      },
      plainSettings: { OPENAI_PROJECT_ID: null },
    });

    for (const material of ["", "   ", "''", "token\u0000value", "x".repeat(1024 * 1024 + 1)]) {
      await expect(resolve(config("openai"), "openai", { [key]: material })).rejects.toMatchObject({
        kind: "missing-credential",
      });
    }
  });

  it("selects a canonical OpenRouter key without copying global management or client settings", async () => {
    const key = tokenAccountVaultKey("openrouter", "account-0");
    await expect(
      resolve(config("openrouter"), "openrouter", { [key]: "  'openrouter-selected'  " }),
    ).resolves.toEqual({
      id: "account-0",
      secureSettings: { OPENROUTER_API_KEY: "openrouter-selected" },
    });

    for (const material of ["", "   ", "''", "token\u0000value", "x".repeat(1024 * 1024 + 1)]) {
      await expect(
        resolve(config("openrouter"), "openrouter", { [key]: material }),
      ).rejects.toMatchObject({ kind: "missing-credential" });
    }
  });

  it("selects z.ai team and personal accounts without inheriting team context", async () => {
    const zaiConfig = (metadata: Readonly<Record<string, string>>): PersistedCodexBarConfig => ({
      version: 1,
      providers: [
        {
          id: "zai",
          extensions: {},
          tokenAccounts: {
            version: 2,
            activeIndex: 0,
            accounts: [{ id: "account-0", label: "z.ai", addedAt: 0, ...metadata }],
          },
        },
      ],
    });
    const key = tokenAccountVaultKey("zai", "account-0");

    await expect(
      resolve(
        zaiConfig({
          usageScope: " TEAM ",
          organizationId: " org-account ",
          workspaceID: " proj-account ",
        }),
        "zai",
        { [key]: " 'account-token' " },
      ),
    ).resolves.toEqual({
      id: "account-0",
      secureSettings: { Z_AI_API_KEY: "account-token" },
      plainSettings: {
        Z_AI_USAGE_SCOPE: "team",
        Z_AI_ORGANIZATION: "org-account",
        Z_AI_PROJECT: "proj-account",
      },
    });

    await expect(
      resolve(zaiConfig({ usageScope: "personal" }), "zai", { [key]: "account-token" }),
    ).resolves.toEqual({
      id: "account-0",
      secureSettings: { Z_AI_API_KEY: "account-token" },
      plainSettings: {
        Z_AI_USAGE_SCOPE: "personal",
        Z_AI_ORGANIZATION: null,
        Z_AI_PROJECT: null,
      },
    });

    for (const metadata of [
      { usageScope: "team\u0000" },
      { organizationId: "x".repeat(257) },
      { workspaceID: "x".repeat(257) },
    ]) {
      await expect(
        resolve(zaiConfig(metadata), "zai", { [key]: "account-token" }),
      ).rejects.toMatchObject({ kind: "missing-credential" });
    }
  });

  it("fails closed for empty or malformed selected z.ai vault material", async () => {
    const key = tokenAccountVaultKey("zai", "account-0");
    for (const material of ["", "   ", "''", "account\u0000token", "x".repeat(1024 * 1024 + 1)]) {
      await expect(resolve(config("zai"), "zai", { [key]: material })).rejects.toMatchObject({
        kind: "missing-credential",
      });
    }
  });

  it("selects Claude Admin, OAuth, and cookie accounts with Swift-compatible normalization", async () => {
    await expect(
      resolve(config("claude", 1, ["first", "selected"]), "claude", {
        [tokenAccountVaultKey("claude", "selected")]: "Bearer sk-ant-oat-second",
      }),
    ).resolves.toMatchObject({
      id: "selected",
      secureSettings: {
        CLAUDE_OAUTH_ACCESS_TOKEN: "sk-ant-oat-second",
        CLAUDE_COOKIE_HEADER: null,
        CLAUDE_CLI_USAGE_JSON: null,
      },
      claudeHistoryBinding: {
        selectionKey: sha256Hex("claude:token-account:selected"),
        tokenAccountKey: sha256Hex("claude:token-account:selected"),
      },
    });

    await expect(
      resolve(config("claude"), "claude", {
        [tokenAccountVaultKey("claude", "account-0")]:
          "Cookie: sessionKey=sk-ant-selected; foo=bar",
      }),
    ).resolves.toMatchObject({
      id: "account-0",
      secureSettings: {
        CLAUDE_OAUTH_ACCESS_TOKEN: null,
        CLAUDE_COOKIE_HEADER: "sessionKey=sk-ant-selected; foo=bar",
        CLAUDE_CLI_USAGE_JSON: null,
      },
    });

    await expect(
      resolve(config("claude"), "claude", {
        [tokenAccountVaultKey("claude", "account-0")]: "Bearer sk-ant-admin-test",
      }),
    ).resolves.toMatchObject({
      id: "account-0",
      secureSettings: {
        ANTHROPIC_ADMIN_KEY: "sk-ant-admin-test",
        ANTHROPIC_ADMIN_API_KEY: null,
        CLAUDE_OAUTH_ACCESS_TOKEN: null,
        CLAUDE_COOKIE_HEADER: null,
        CLAUDE_CLI_USAGE_JSON: null,
      },
    });

    await expect(
      resolve(config("claude"), "claude", {
        [tokenAccountVaultKey("claude", "account-0")]: "Cookie:",
      }),
    ).rejects.toMatchObject({ kind: "missing-credential" });
  });

  it("selects Grok bearer and cookie credentials while controlling both routes", async () => {
    await expect(
      resolve(config("grok", 1, ["first", "selected"]), "grok", {
        [tokenAccountVaultKey("grok", "selected")]: "  Bearer selected-token  ",
      }),
    ).resolves.toEqual({
      id: "selected",
      secureSettings: {
        GROK_OAUTH_TOKEN: "selected-token",
        GROK_COOKIE_HEADER: null,
      },
    });

    await expect(
      resolve(config("grok"), "grok", {
        [tokenAccountVaultKey("grok", "account-0")]:
          "curl -H 'Cookie: sso=abc; sso-rw=def' https://grok.com",
      }),
    ).resolves.toEqual({
      id: "account-0",
      secureSettings: {
        GROK_OAUTH_TOKEN: null,
        GROK_COOKIE_HEADER: "sso=abc; sso-rw=def",
      },
    });
  });

  it("fails closed for malformed Grok selected material", async () => {
    for (const material of ["Cookie:", "xai-mgmt-key", "Bearer xai-mgmt-key", "   "]) {
      await expect(
        resolve(config("grok"), "grok", {
          [tokenAccountVaultKey("grok", "account-0")]: material,
        }),
      ).rejects.toMatchObject({ kind: "missing-credential" });
    }
  });
});
