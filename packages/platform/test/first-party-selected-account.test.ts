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

  it("fails closed for selected Codex accounts without reinterpreting legacy tokens", async () => {
    await expect(
      resolve(config("codex"), "codex", {
        [tokenAccountVaultKey("codex", "account-0")]: "could-be-any-legacy-format",
      }),
    ).rejects.toMatchObject({ kind: "missing-credential" });
  });

  it("fails closed for selected accounts whose first-party mapper is not ported", async () => {
    for (const providerId of ["cursor"] as const) {
      await expect(
        resolve(config(providerId), providerId, {
          [tokenAccountVaultKey(providerId, "account-0")]: "must-not-be-reinterpreted",
        }),
      ).rejects.toMatchObject({ kind: "missing-credential" });
    }
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
