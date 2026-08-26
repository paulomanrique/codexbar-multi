import { describe, expect, it } from "vite-plus/test";
import providerSpecificFull from "../../../Tests/CodexBarTests/Fixtures/Config/provider-specific-full.json" with { type: "json" };
import providerSpecificSparse from "../../../Tests/CodexBarTests/Fixtures/Config/provider-specific-sparse.json" with { type: "json" };

import {
  CODEXBAR_CONFIG_VERSION,
  type ConfigProviderCapabilities,
  DEFAULT_PROVIDER_CONFIG_NORMALIZERS,
  ConfigDecodeError,
  decodeCodexBarConfig,
  encodeCodexBarConfig,
  makeDefaultCodexBarConfig,
  migrateLegacyConfigValues,
  normalizeCodexBarConfig,
  sanitizedCodexBarConfigForDump,
  validateCodexBarConfig,
} from "../src/config.ts";

describe("CodexBarConfig coding (Swift parity)", () => {
  it("retains every provider-specific extension fixture and restores the flattened wire shape", () => {
    for (const input of [providerSpecificFull, providerSpecificSparse]) {
      const decoded = decodeCodexBarConfig(input);
      expect(encodeCodexBarConfig(decoded)).toEqual(input);
    }
  });

  it("ignores removed providers before decoding their legacy fields", () => {
    const decoded = decodeCodexBarConfig({
      version: 1,
      providers: [
        { id: "kimik2", enabled: true, malformedKnownField: () => undefined },
        { id: "crossmodel", enabled: true },
        { id: "codex", enabled: false, source: "oauth" },
      ],
    });

    expect(decoded.providers).toEqual([
      { id: "codex", enabled: false, source: "oauth", extensions: {} },
    ]);
  });

  it("keeps registered plugins, omits null extensions, and fails closed for malformed known entries", () => {
    const decoded = decodeCodexBarConfig(
      {
        version: 1,
        providers: [{ id: "plugin-example", experimental: { enabled: true }, removed: null }],
      },
      { pluginProviderIds: new Set(["plugin-example"]) },
    );
    expect(decoded.providers[0]?.extensions).toEqual({ experimental: { enabled: true } });
    expect(() =>
      decodeCodexBarConfig({ version: 1, providers: [{ id: "codex", enabled: "yes" }] }),
    ).toThrow(ConfigDecodeError);
  });

  it("round-trips only the typed non-secret token-account deletion marker", () => {
    const input = {
      version: 1,
      providers: [
        {
          id: "codex",
          pendingTokenAccountDeletion: { version: 1, accountId: "account-1" },
        },
      ],
    };
    const decoded = decodeCodexBarConfig(input);
    expect(decoded.providers[0]?.pendingTokenAccountDeletion).toEqual({
      version: 1,
      accountId: "account-1",
    });
    expect(decoded.providers[0]?.extensions).toEqual({});
    expect(encodeCodexBarConfig(decoded)).toEqual(input);

    for (const marker of [
      { version: 2, accountId: "account-1" },
      { version: 1, accountId: "" },
      { version: 1, accountId: "bad\naccount" },
      { version: 1, accountId: "account-1", token: "must-not-persist" },
    ]) {
      expect(() =>
        decodeCodexBarConfig({
          version: 1,
          providers: [{ id: "codex", pendingTokenAccountDeletion: marker }],
        }),
      ).toThrow(ConfigDecodeError);
    }
  });

  it("round-trips only the typed non-secret token-account addition marker", () => {
    const marker = {
      version: 1,
      account: {
        id: "account-2",
        label: "Personal",
        addedAt: 42,
        externalIdentifier: "workspace-1",
      },
      credentialSha256: "a".repeat(64),
      makeActive: true,
    };
    const input = {
      version: 1,
      providers: [{ id: "codex", pendingTokenAccountAddition: marker }],
    };

    const decoded = decodeCodexBarConfig(input);

    expect(decoded.providers[0]?.pendingTokenAccountAddition).toEqual(marker);
    expect(decoded.providers[0]?.extensions).toEqual({});
    expect(encodeCodexBarConfig(decoded)).toEqual(input);

    for (const invalid of [
      { ...marker, version: 2 },
      { ...marker, credentialSha256: "not-a-fingerprint" },
      { ...marker, makeActive: undefined },
      { ...marker, token: "must-not-persist" },
      { ...marker, account: { ...marker.account, token: "must-not-persist" } },
      { ...marker, account: { ...marker.account, id: "bad\naccount" } },
    ]) {
      expect(() =>
        decodeCodexBarConfig({
          version: 1,
          providers: [{ id: "codex", pendingTokenAccountAddition: invalid }],
        }),
      ).toThrow(ConfigDecodeError);
    }
  });

  it("matches Swift encodeIfPresent omissions after decoding null legacy values", () => {
    const decoded = decodeCodexBarConfig({
      version: 1,
      providers: [
        {
          id: "codex",
          enabled: null,
          apiKey: null,
          region: null,
          removedExtension: null,
        },
      ],
      hooks: null,
    });
    expect(encodeCodexBarConfig(decoded)).toEqual({
      version: 1,
      providers: [{ id: "codex" }],
    });
  });

  it("applies Swift hook decoding defaults while retaining its JSON round-trip shape", () => {
    const decoded = decodeCodexBarConfig(
      {
        version: 1,
        providers: [],
        hooks: { events: [{ event: "quota_reached", executable: "/usr/bin/true" }] },
      },
      { createHookId: () => "legacy-hook-id" },
    );
    expect(decoded.hooks).toEqual({
      enabled: false,
      events: [
        {
          id: "legacy-hook-id",
          enabled: true,
          event: "quota_reached",
          executable: "/usr/bin/true",
          arguments: [],
          timeoutSeconds: 10,
        },
      ],
    });
  });

  it("uses exact default ordering and asymmetric Alibaba Token Plan defaults", () => {
    const fresh = makeDefaultCodexBarConfig();
    expect(fresh.version).toBe(CODEXBAR_CONFIG_VERSION);
    expect(fresh.sessionQuotaNotificationsEnabled).toBe(true);
    expect(fresh.providers).toHaveLength(69);
    expect(fresh.providers[0]).toMatchObject({ id: "codex", enabled: true });
    expect(fresh.providers.find((entry) => entry.id === "alibabatokenplan")).toMatchObject({
      region: "international",
    });

    const normalized = normalizeCodexBarConfig({
      version: 99,
      providers: [
        { id: "codex", enabled: false, extensions: {} },
        { id: "codex", enabled: true, extensions: {} },
        { id: "alibabatokenplan", extensions: {} },
      ],
    });
    expect(normalized.version).toBe(1);
    expect(normalized.providers[0]).toMatchObject({ id: "codex", enabled: false });
    expect(normalized.providers.find((entry) => entry.id === "alibabatokenplan")).toEqual({
      id: "alibabatokenplan",
      extensions: {},
    });

    const missingAlibaba = normalizeCodexBarConfig({
      version: 1,
      providers: [{ id: "codex", extensions: {} }],
    });
    expect(missingAlibaba.providers.find((entry) => entry.id === "alibabatokenplan")).toMatchObject(
      {
        region: "china-mainland",
      },
    );
  });

  it("preserves Swift's global session-notification opt-out without forcing legacy configs", () => {
    const disabled = decodeCodexBarConfig({
      version: 1,
      providers: [],
      sessionQuotaNotificationsEnabled: false,
    });
    expect(disabled.sessionQuotaNotificationsEnabled).toBe(false);
    expect(encodeCodexBarConfig(disabled)).toMatchObject({
      sessionQuotaNotificationsEnabled: false,
    });
    expect(
      decodeCodexBarConfig({ version: 1, providers: [] }).sessionQuotaNotificationsEnabled,
    ).toBeUndefined();
    expect(() =>
      decodeCodexBarConfig({ version: 1, providers: [], sessionQuotaNotificationsEnabled: "yes" }),
    ).toThrow(ConfigDecodeError);
  });

  it("normalizes the two upstream descriptor-owned extension values", () => {
    const normalized = normalizeCodexBarConfig(
      {
        version: 1,
        providers: [
          { id: "moonshot", apiKey: " token ", region: "china", extensions: {} },
          {
            id: "deepseek",
            extensions: { deepseekProfileID: "  profile ", deepseekProfileScope: "   " },
          },
        ],
      },
      DEFAULT_PROVIDER_CONFIG_NORMALIZERS,
    );
    expect(normalized.providers.find((entry) => entry.id === "moonshot")?.extensions).toEqual({
      apiKeyRegion: "china",
    });
    expect(normalized.providers.find((entry) => entry.id === "deepseek")?.extensions).toEqual({
      deepseekProfileID: "profile",
    });
  });

  it("redacts all persisted credential locations in config dumps", () => {
    const redacted = sanitizedCodexBarConfigForDump({
      version: 1,
      providers: [
        {
          id: "codex",
          apiKey: "key",
          secretKey: "secret",
          cookieHeader: "cookie",
          pluginSecrets: { session: "private" },
          tokenAccounts: {
            version: 1,
            activeIndex: 0,
            accounts: [{ id: "id", label: "Main", token: "account-token", addedAt: 0 }],
          },
          extensions: {},
        },
      ],
    });
    expect(redacted.providers[0]).toMatchObject({
      apiKey: "[REDACTED]",
      secretKey: "[REDACTED]",
      cookieHeader: "[REDACTED]",
      pluginSecrets: { session: "[REDACTED]" },
      tokenAccounts: { accounts: [{ token: "[REDACTED]" }] },
    });
  });

  it("decodes and encodes tokenAccounts v1 without changing the legacy plaintext model", () => {
    const input = {
      version: 1,
      providers: [
        {
          id: "claude",
          tokenAccounts: {
            version: 1,
            activeIndex: 0,
            accounts: [
              {
                id: "account-1",
                label: "Main",
                token: "legacy-token",
                addedAt: 1,
                lastUsed: 2,
                externalIdentifier: "external",
                usageScope: "scope",
                organizationId: "organization",
                workspaceID: "workspace",
              },
            ],
          },
        },
      ],
    };
    expect(encodeCodexBarConfig(decodeCodexBarConfig(input))).toEqual(input);
  });

  it("decodes and encodes tokenAccounts v2 metadata without synthesizing a token", () => {
    const input = {
      version: 1,
      providers: [
        {
          id: "claude",
          tokenAccounts: {
            version: 2,
            activeIndex: 0,
            accounts: [{ id: "account-1", label: "Main", addedAt: 1, lastUsed: 2 }],
          },
        },
      ],
    };
    const decoded = decodeCodexBarConfig(input);
    expect(decoded.providers[0]?.tokenAccounts?.accounts[0]).not.toHaveProperty("token");
    expect(encodeCodexBarConfig(decoded)).toEqual(input);
    expect(
      sanitizedCodexBarConfigForDump(decoded).providers[0]?.tokenAccounts?.accounts[0],
    ).toEqual({
      id: "account-1",
      label: "Main",
      addedAt: 1,
      lastUsed: 2,
    });
  });

  it("fails closed for unknown or mixed tokenAccounts versions", () => {
    const provider = (tokenAccounts: unknown) => ({
      version: 1,
      providers: [{ id: "claude", tokenAccounts }],
    });
    expect(() =>
      decodeCodexBarConfig(provider({ version: 99, activeIndex: 0, accounts: [] })),
    ).toThrow(ConfigDecodeError);
    expect(() =>
      decodeCodexBarConfig(
        provider({
          version: 1,
          activeIndex: 0,
          accounts: [{ id: "id", label: "Main", addedAt: 0 }],
        }),
      ),
    ).toThrow(ConfigDecodeError);
    expect(() =>
      decodeCodexBarConfig(
        provider({
          version: 2,
          activeIndex: 0,
          accounts: [{ id: "id", label: "Main", token: "secret", addedAt: 0 }],
        }),
      ),
    ).toThrow(ConfigDecodeError);
  });
});

describe("CodexBarConfig validation (Swift parity)", () => {
  const capabilities: readonly ConfigProviderCapabilities[] = [
    { id: "codex", sourceModes: ["auto", "oauth"] as const },
    { id: "zai", sourceModes: ["auto", "api"] as const, supportsTokenAccounts: true },
    {
      id: "wayfinder",
      sourceModes: ["auto", "api"] as const,
      requiresApiKeyForApiSource: false,
      supportsEnterpriseHost: true,
    },
    {
      id: "azureopenai",
      sourceModes: ["auto", "api"] as const,
      supportsEnterpriseHost: true,
      supportsWorkspaceID: true,
      workspaceIDValidationOrder: 0,
    },
    {
      id: "openai",
      sourceModes: ["auto", "api"] as const,
      supportsWorkspaceID: true,
      workspaceIDValidationOrder: 1,
    },
    { id: "doubao", sourceModes: ["auto", "api"] as const, usesSecretKey: true, usesRegion: true },
  ];

  it("reports unsafe hook fields and quota workload limits", () => {
    const config = {
      version: 1,
      providers: [],
      hooks: {
        enabled: true,
        events: Array.from({ length: 33 }, (_, index) => ({
          id: index === 0 ? "duplicate" : index === 1 ? "duplicate" : "x".repeat(129),
          enabled: true,
          event: "quota_low" as const,
          provider: "unknown",
          threshold: 1.1,
          executable: "echo",
          arguments: Array.from({ length: 33 }, () => "x"),
          timeoutSeconds: 301,
        })),
      },
    };
    const codes = new Set(
      validateCodexBarConfig(config, { providers: capabilities }).map((entry) => entry.code),
    );
    expect(codes).toEqual(
      expect.objectContaining(
        new Set([
          "too_many_hook_rules",
          "duplicate_hook_id",
          "invalid_hook_executable",
          "invalid_hook_provider",
          "invalid_hook_threshold",
          "invalid_hook_timeout",
          "invalid_hook_command_size",
        ]),
      ),
    );
  });

  it("accepts portable absolute executable paths without consulting the host OS", () => {
    for (const executable of [
      "/usr/bin/true",
      "C:\\Program Files\\CodexBar\\hook.exe",
      "\\\\server\\share\\hook.exe",
    ]) {
      const issues = validateCodexBarConfig({
        version: 1,
        providers: [],
        hooks: {
          enabled: true,
          events: [
            {
              id: executable,
              enabled: true,
              event: "quota_reached",
              executable,
              arguments: [],
              timeoutSeconds: 10,
            },
          ],
        },
      });
      expect(issues.map((entry) => entry.code)).not.toContain("invalid_hook_executable");
    }
    const relative = validateCodexBarConfig({
      version: 1,
      providers: [],
      hooks: {
        enabled: true,
        events: [
          {
            id: "relative",
            enabled: true,
            event: "quota_reached",
            executable: "hooks/run.exe",
            arguments: [],
            timeoutSeconds: 10,
          },
        ],
      },
    });
    expect(relative.map((entry) => entry.code)).toContain("invalid_hook_executable");
  });

  it("uses descriptor capabilities for source, credentials, and known provider fields", () => {
    const config = {
      version: 1,
      providers: [
        {
          id: "codex",
          source: "api" as const,
          apiKey: "key",
          cookieSource: "manual" as const,
          extensions: {},
        },
        { id: "zai", source: "api" as const, extensions: {} },
        {
          id: "wayfinder",
          source: "api" as const,
          enterpriseHost: "http://127.0.0.1:9191",
          extensions: {},
        },
        { id: "doubao", apiKey: "key", secretKey: "secret", region: "cn-shanghai", extensions: {} },
        {
          id: "azureopenai",
          workspaceID: "deployment",
          enterpriseHost: "https://example.com",
          extensions: {},
        },
      ],
    };
    const issues = validateCodexBarConfig(config, { providers: capabilities });
    expect(issues.map((entry) => entry.code)).toContain("unsupported_source");
    expect(issues.map((entry) => entry.code)).toContain("api_source_unsupported");
    expect(issues.map((entry) => entry.code)).toContain("cookie_header_missing");
    expect(
      issues.filter((entry) => entry.provider === "wayfinder" && entry.code === "api_key_missing"),
    ).toEqual([]);
    expect(
      issues.filter((entry) => entry.provider === "doubao" && entry.code === "secret_key_unused"),
    ).toEqual([]);
    expect(
      issues.filter(
        (entry) => entry.provider === "azureopenai" && entry.code === "workspace_unused",
      ),
    ).toEqual([]);
  });

  it("treats non-empty v2 token account metadata as configured API credential intent", () => {
    const issues = validateCodexBarConfig(
      {
        version: 1,
        providers: [
          {
            id: "zai",
            source: "api" as const,
            tokenAccounts: {
              version: 2,
              activeIndex: 0,
              accounts: [{ id: "account-1", label: "Main", addedAt: 0 }],
            },
            extensions: {},
          },
        ],
      },
      { providers: capabilities },
    );
    expect(issues.map((entry) => entry.code)).not.toContain("api_key_missing");
  });
});

describe("CodexBarConfig legacy value migration (Swift parity)", () => {
  it("applies legacy order/toggles/cookie sources without overwriting configured values", () => {
    const migrated = migrateLegacyConfigValues(
      {
        version: 1,
        providers: [
          { id: "moonshot", apiKey: "legacy-key", region: "china", extensions: {} },
          { id: "codex", cookieSource: "manual", extensions: {} },
          { id: "opencode", extensions: {} },
          { id: "minimax", extensions: {} },
          { id: "kimi", cookieHeader: "existing", extensions: {} },
        ],
      },
      {
        providerOrder: ["opencode", "codex", "codex", "removed"],
        providerToggles: { codex: false, "opencode-cli": true },
        providerCLINameById: { opencode: "opencode-cli" },
        cookieSources: { codex: "auto", opencode: "manual" },
        minimaxAPIRegion: "china",
        opencodeWorkspaceID: "workspace-1",
        kimiManualCookieHeader: "new-cookie",
      },
    );
    expect(migrated.providers.slice(0, 2).map((entry) => entry.id)).toEqual(["opencode", "codex"]);
    expect(migrated.providers.find((entry) => entry.id === "codex")).toMatchObject({
      enabled: false,
      cookieSource: "manual",
    });
    expect(migrated.providers.find((entry) => entry.id === "opencode")).toMatchObject({
      enabled: true,
      cookieSource: "manual",
      workspaceID: "workspace-1",
    });
    expect(migrated.providers.find((entry) => entry.id === "minimax")).toMatchObject({
      region: "china",
    });
    expect(migrated.providers.find((entry) => entry.id === "kimi")).toMatchObject({
      cookieHeader: "existing",
    });
    expect(migrated.providers.find((entry) => entry.id === "moonshot")?.extensions).toEqual({
      apiKeyRegion: "china",
    });
  });
});
