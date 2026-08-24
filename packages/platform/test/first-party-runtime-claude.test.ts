import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { ClassifiedFetchFailure, type HttpRequest } from "@codexbar/core";
import { amp, claude } from "@codexbar/providers";
import type { FirstPartyProvider } from "@codexbar/providers";
import { makeFirstPartyProviderRuntime } from "../src/first-party-runtime.ts";

const clock = { now: Effect.succeed(1), sleep: () => Effect.void };

const credentials = {
  read: () => Effect.succeed(undefined),
  write: () => Effect.void,
  remove: () => Effect.void,
};
const claudeUsage = {
  five_hour: { utilization: 10, resets_at: "2026-08-24T17:00:00Z" },
  seven_day: { utilization: 20 },
};
const response = (url: string, value: unknown, status = 200) => ({
  status,
  headers: {},
  body: new TextEncoder().encode(JSON.stringify(value)),
  url,
});

const unusedLocal = {
  run: () => Effect.succeed({ exitCode: 0, signal: undefined, stdout: "", stderr: "" }),
  readData: () => Effect.succeed(undefined),
};

describe("first-party runtime Claude scoping and bounds", () => {
  for (const sourceMode of ["auto", "api", "web", "cli", "oauth"] as const) {
    it(`routes selected Claude OAuth only through OAuth under ${sourceMode}`, async () => {
      const requests: HttpRequest[] = [];
      let ambientReads = 0;
      let cliCalls = 0;
      let browserCalls = 0;
      const runtime = makeFirstPartyProviderRuntime({
        providers: [claude],
        settings: {
          read: (_provider, key) => {
            if (key.startsWith("CLAUDE_")) ambientReads += 1;
            return Effect.succeed(
              key === "CLAUDE_COOKIE_HEADER" ? "sessionKey=ambient" : undefined,
            );
          },
        },
        selectedAccounts: {
          resolve: () =>
            Effect.succeed({
              id: "account-oauth",
              secureSettings: {
                ANTHROPIC_ADMIN_KEY: null,
                ANTHROPIC_ADMIN_API_KEY: null,
                CLAUDE_OAUTH_ACCESS_TOKEN: "sk-ant-oat-selected-secret",
                CLAUDE_COOKIE_HEADER: null,
                CLAUDE_CLI_USAGE_JSON: null,
              },
              plainSettings: { CLAUDE_ORGANIZATION_ID: null },
            }),
        },
        credentials: {
          read: () => Effect.succeed("ambient-secret"),
          write: () => Effect.void,
          remove: () => Effect.void,
        },
        browserSessions: {
          cookieHeader: () => {
            browserCalls += 1;
            return Effect.succeed("sessionKey=browser");
          },
        },
        local: {
          ...unusedLocal,
          fetchClaudeCliUsage: () => {
            cliCalls += 1;
            return Effect.succeed({ stdout: "", stderr: "", loggedIn: true });
          },
        },
        http: {
          execute: (request) => {
            requests.push(request);
            return Effect.succeed(response(request.url, claudeUsage));
          },
        },
        clock,
      });

      const outcome = await Effect.runPromise(
        runtime.fetch("claude", { sourceMode, includeCredits: false }),
      );
      expect(outcome.strategyId).toBe("claude.oauth");
      expect(outcome.attempts.map((attempt) => attempt.strategyId)).toEqual(["claude.oauth"]);
      expect(requests[0]?.headers?.Authorization).toBe("Bearer sk-ant-oat-selected-secret");
      expect(ambientReads).toBe(0);
      expect(cliCalls).toBe(0);
      expect(browserCalls).toBe(0);
      expect(JSON.stringify(outcome)).not.toContain("sk-ant-oat-selected-secret");
      expect(JSON.stringify(outcome)).not.toContain("ambient-secret");
    });

    it(`routes selected Claude cookie only through web under ${sourceMode}`, async () => {
      const requests: HttpRequest[] = [];
      let cliCalls = 0;
      let browserCalls = 0;
      const runtime = makeFirstPartyProviderRuntime({
        providers: [claude],
        settings: {
          read: (_provider, key) =>
            Effect.succeed(key === "CLAUDE_OAUTH_ACCESS_TOKEN" ? "sk-ant-oat-ambient" : undefined),
        },
        selectedAccounts: {
          resolve: () =>
            Effect.succeed({
              id: "account-web",
              secureSettings: {
                ANTHROPIC_ADMIN_KEY: null,
                ANTHROPIC_ADMIN_API_KEY: null,
                CLAUDE_OAUTH_ACCESS_TOKEN: null,
                CLAUDE_COOKIE_HEADER: "sessionKey=selected-cookie-secret",
                CLAUDE_CLI_USAGE_JSON: null,
              },
              plainSettings: { CLAUDE_ORGANIZATION_ID: null },
            }),
        },
        credentials,
        browserSessions: {
          cookieHeader: () => {
            browserCalls += 1;
            return Effect.succeed("sessionKey=browser");
          },
        },
        local: {
          ...unusedLocal,
          fetchClaudeCliUsage: () => {
            cliCalls += 1;
            return Effect.succeed({ stdout: "", stderr: "", loggedIn: true });
          },
        },
        http: {
          execute: (request) => {
            requests.push(request);
            const body = request.url.includes("/organizations/")
              ? claudeUsage
              : [{ uuid: "org-1", name: "Selected Org" }];
            return Effect.succeed(response(request.url, body));
          },
        },
        clock,
      });

      const outcome = await Effect.runPromise(
        runtime.fetch("claude", { sourceMode, includeCredits: false }),
      );
      expect(outcome.strategyId).toBe("claude.web");
      expect(outcome.attempts.map((attempt) => attempt.strategyId)).toEqual(["claude.web"]);
      expect(requests.map((request) => request.headers?.Cookie)).toEqual([
        "sessionKey=selected-cookie-secret",
        "sessionKey=selected-cookie-secret",
      ]);
      expect(cliCalls).toBe(0);
      expect(browserCalls).toBe(0);
      expect(JSON.stringify(outcome)).not.toContain("selected-cookie-secret");
      expect(JSON.stringify(outcome)).not.toContain("sk-ant-oat-ambient");
    });

    it(`routes selected Claude Admin API only through Admin API under ${sourceMode}`, async () => {
      const requests: HttpRequest[] = [];
      let cliCalls = 0;
      let browserCalls = 0;
      const runtime = makeFirstPartyProviderRuntime({
        providers: [claude],
        settings: {
          read: (_provider, key) =>
            Effect.succeed(key === "CLAUDE_OAUTH_ACCESS_TOKEN" ? "sk-ant-oat-ambient" : undefined),
        },
        selectedAccounts: {
          resolve: () =>
            Effect.succeed({
              id: "account-admin",
              secureSettings: {
                ANTHROPIC_ADMIN_KEY: "sk-ant-admin-selected-secret",
                ANTHROPIC_ADMIN_API_KEY: null,
                CLAUDE_OAUTH_ACCESS_TOKEN: null,
                CLAUDE_COOKIE_HEADER: null,
                CLAUDE_CLI_USAGE_JSON: null,
              },
              plainSettings: { CLAUDE_ORGANIZATION_ID: "org-not-sent" },
            }),
        },
        credentials,
        browserSessions: {
          cookieHeader: () => {
            browserCalls += 1;
            return Effect.succeed("sessionKey=browser");
          },
        },
        local: {
          ...unusedLocal,
          fetchClaudeCliUsage: () => {
            cliCalls += 1;
            return Effect.succeed({ stdout: "", stderr: "", loggedIn: true });
          },
        },
        http: {
          execute: (request) => {
            requests.push(request);
            const body = request.url.includes("/cost_report")
              ? { data: [], has_more: false, next_page: null }
              : { data: [], has_more: false, next_page: null };
            return Effect.succeed(response(request.url, body));
          },
        },
        clock,
      });

      const outcome = await Effect.runPromise(
        runtime.fetch("claude", { sourceMode, includeCredits: false }),
      );
      expect(outcome.strategyId).toBe("claude.admin-api");
      expect(outcome.attempts.map((attempt) => attempt.strategyId)).toEqual(["claude.admin-api"]);
      expect(requests).toHaveLength(2);
      expect(
        requests.every(
          (request) => request.headers?.["x-api-key"] === "sk-ant-admin-selected-secret",
        ),
      ).toBe(true);
      expect(requests.every((request) => !request.url.includes("org-not-sent"))).toBe(true);
      expect(cliCalls).toBe(0);
      expect(browserCalls).toBe(0);
      expect(JSON.stringify(outcome)).not.toContain("sk-ant-admin-selected-secret");
      expect(JSON.stringify(outcome)).not.toContain("sk-ant-oat-ambient");
    });
  }

  it("fails closed for malformed selected Claude credentials instead of ambient fallback", async () => {
    let httpCalls = 0;
    let browserCalls = 0;
    let cliCalls = 0;
    const runtime = makeFirstPartyProviderRuntime({
      providers: [claude],
      settings: {
        read: (_provider, key) =>
          Effect.succeed(key === "CLAUDE_OAUTH_ACCESS_TOKEN" ? "sk-ant-oat-ambient" : undefined),
      },
      selectedAccounts: {
        resolve: () =>
          Effect.succeed({
            id: "account-invalid",
            secureSettings: {
              ANTHROPIC_ADMIN_KEY: null,
              ANTHROPIC_ADMIN_API_KEY: null,
              CLAUDE_OAUTH_ACCESS_TOKEN: null,
              CLAUDE_COOKIE_HEADER: null,
              CLAUDE_CLI_USAGE_JSON: null,
            },
            plainSettings: { CLAUDE_ORGANIZATION_ID: null },
          }),
      },
      credentials,
      browserSessions: {
        cookieHeader: () => {
          browserCalls += 1;
          return Effect.succeed("sessionKey=browser");
        },
      },
      local: {
        ...unusedLocal,
        fetchClaudeCliUsage: () => {
          cliCalls += 1;
          return Effect.succeed({ stdout: "", stderr: "", loggedIn: true });
        },
      },
      http: {
        execute: () => {
          httpCalls += 1;
          return Effect.succeed(response("https://api.anthropic.com/api/oauth/usage", claudeUsage));
        },
      },
      clock,
    });

    await expect(
      Effect.runPromise(runtime.fetch("claude", { sourceMode: "auto", includeCredits: false })),
    ).rejects.toMatchObject({ name: "NoAvailableStrategy", providerId: "claude" });
    expect(httpCalls).toBe(0);
    expect(browserCalls).toBe(0);
    expect(cliCalls).toBe(0);
  });

  it.each([
    [401, "authentication-expired"],
    [403, "permission-denied"],
    [429, "rate-limited"],
    [500, "api-failure"],
  ] as const)("keeps selected Claude Admin HTTP %i terminal as %s", async (status, kind) => {
    let httpCalls = 0;
    let browserCalls = 0;
    let cliCalls = 0;
    const runtime = makeFirstPartyProviderRuntime({
      providers: [claude],
      settings: {
        read: (_provider, key) =>
          Effect.succeed(key === "CLAUDE_OAUTH_ACCESS_TOKEN" ? "sk-ant-oat-ambient" : undefined),
      },
      selectedAccounts: {
        resolve: () =>
          Effect.succeed({
            id: "account-admin-terminal",
            secureSettings: {
              ANTHROPIC_ADMIN_KEY: "sk-ant-admin-selected-secret",
              ANTHROPIC_ADMIN_API_KEY: null,
              CLAUDE_OAUTH_ACCESS_TOKEN: null,
              CLAUDE_COOKIE_HEADER: null,
              CLAUDE_CLI_USAGE_JSON: null,
            },
            plainSettings: { CLAUDE_ORGANIZATION_ID: null },
          }),
      },
      credentials,
      browserSessions: {
        cookieHeader: () => {
          browserCalls += 1;
          return Effect.succeed("sessionKey=browser");
        },
      },
      local: {
        ...unusedLocal,
        fetchClaudeCliUsage: () => {
          cliCalls += 1;
          return Effect.succeed({ stdout: "", stderr: "", loggedIn: true });
        },
      },
      http: {
        execute: (request) => {
          httpCalls += 1;
          return Effect.succeed(response(request.url, {}, status));
        },
      },
      clock,
    });

    await expect(
      Effect.runPromise(runtime.fetch("claude", { sourceMode: "auto", includeCredits: false })),
    ).rejects.toMatchObject({ kind });
    expect(httpCalls).toBe(1);
    expect(browserCalls).toBe(0);
    expect(cliCalls).toBe(0);
  });

  it("falls back from ambient Claude Admin API failures in app-auto", async () => {
    const requests: HttpRequest[] = [];
    const runtime = makeFirstPartyProviderRuntime({
      runtime: "app",
      providers: [claude],
      settings: {
        read: (_provider, key) =>
          Effect.succeed(
            key === "ANTHROPIC_ADMIN_KEY"
              ? "sk-ant-admin-ambient"
              : key === "CLAUDE_OAUTH_ACCESS_TOKEN"
                ? "sk-ant-oat-ambient"
                : undefined,
          ),
      },
      credentials,
      browserSessions: { cookieHeader: () => Effect.succeed("") },
      local: unusedLocal,
      http: {
        execute: (request) => {
          requests.push(request);
          return request.url.includes("/cost_report")
            ? Effect.succeed(response(request.url, {}, 500))
            : Effect.succeed(response(request.url, claudeUsage));
        },
      },
      clock,
    });

    const outcome = await Effect.runPromise(
      runtime.fetch("claude", { sourceMode: "auto", includeCredits: false }),
    );
    expect(outcome.strategyId).toBe("claude.oauth");
    expect(outcome.attempts.map((attempt) => attempt.strategyId)).toEqual([
      "claude.admin-api",
      "claude.oauth",
    ]);
    expect(requests).toHaveLength(2);
  });

  it("keeps ambient Claude Admin API failures terminal in the CLI runtime", async () => {
    const requests: HttpRequest[] = [];
    const runtime = makeFirstPartyProviderRuntime({
      runtime: "cli",
      providers: [claude],
      settings: {
        read: (_provider, key) =>
          Effect.succeed(
            key === "ANTHROPIC_ADMIN_KEY"
              ? "sk-ant-admin-ambient"
              : key === "CLAUDE_OAUTH_ACCESS_TOKEN"
                ? "sk-ant-oat-ambient"
                : undefined,
          ),
      },
      credentials,
      browserSessions: { cookieHeader: () => Effect.succeed("") },
      local: unusedLocal,
      http: {
        execute: (request) => {
          requests.push(request);
          return Effect.succeed(response(request.url, {}, 500));
        },
      },
      clock,
    });

    await expect(
      Effect.runPromise(runtime.fetch("claude", { sourceMode: "auto", includeCredits: false })),
    ).rejects.toMatchObject({ kind: "api-failure" });
    expect(requests).toHaveLength(1);
  });

  it("passes selected Claude web organization as plain settings without falling back to first org", async () => {
    const requests: HttpRequest[] = [];
    const runtime = makeFirstPartyProviderRuntime({
      providers: [claude],
      settings: {
        read: (_provider, key) =>
          Effect.succeed(key === "CLAUDE_ORGANIZATION_ID" ? "ambient-org" : undefined),
      },
      selectedAccounts: {
        resolve: () =>
          Effect.succeed({
            id: "account-web-org",
            secureSettings: {
              ANTHROPIC_ADMIN_KEY: null,
              ANTHROPIC_ADMIN_API_KEY: null,
              CLAUDE_OAUTH_ACCESS_TOKEN: null,
              CLAUDE_COOKIE_HEADER: "sessionKey=selected-cookie-secret",
              CLAUDE_CLI_USAGE_JSON: null,
            },
            plainSettings: { CLAUDE_ORGANIZATION_ID: "org-selected" },
          }),
      },
      credentials,
      browserSessions: { cookieHeader: () => Effect.fail(new Error("not used")) },
      local: unusedLocal,
      http: {
        execute: (request) => {
          requests.push(request);
          const body = request.url.endsWith("/api/organizations")
            ? [
                { uuid: "ambient-org", name: "Ambient" },
                { uuid: "org-selected", name: "Selected" },
              ]
            : claudeUsage;
          return Effect.succeed(response(request.url, body));
        },
      },
      clock,
    });

    const outcome = await Effect.runPromise(
      runtime.fetch("claude", { sourceMode: "auto", includeCredits: false }),
    );
    expect(outcome.strategyId).toBe("claude.web");
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/api/organizations",
      "/api/organizations/org-selected/usage",
    ]);
    expect(outcome.snapshot.identity?.accountOrganization).toBe("Selected");
  });

  it("rejects fetchClaudeCliUsage for non-claude providers with permission-denied", async () => {
    let capabilityCalls = 0;
    const ampCallingClaude: FirstPartyProvider = {
      ...amp,
      strategies: [
        {
          id: "amp.claude-misuse",
          kind: "cli",
          fetchUsage: async (ctx) => {
            await ctx.local!.fetchClaudeCliUsage!();
            return {
              primary: { usedPercent: 0, windowMinutes: 1 },
              identity: { providerId: "amp" },
            };
          },
        },
      ],
    };
    const runtime = makeFirstPartyProviderRuntime({
      providers: [ampCallingClaude],
      settings: { read: () => Effect.succeed(undefined) },
      credentials,
      browserSessions: { cookieHeader: () => Effect.fail(new Error("missing")) },
      local: {
        ...unusedLocal,
        fetchClaudeCliUsage: () => {
          capabilityCalls += 1;
          return Effect.succeed({ stdout: "x", stderr: "", loggedIn: true });
        },
      },
      http: { execute: () => Effect.fail(new Error("not used")) } as never,
      clock,
    });
    await expect(
      Effect.runPromise(runtime.fetch("amp", { sourceMode: "cli", includeCredits: false })),
    ).rejects.toMatchObject({
      name: "ClassifiedFetchFailure",
      kind: "permission-denied",
      message: expect.stringMatching(/not declared/i),
    });
    const rejected = await Effect.runPromise(
      runtime.fetch("amp", { sourceMode: "cli", includeCredits: false }),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(rejected).toBeInstanceOf(ClassifiedFetchFailure);
    expect(rejected).not.toMatchObject({ operation: "read Claude CLI usage" });
    expect(capabilityCalls).toBe(0);
  });

  it("rejects 1 MiB/NUL limits on the production Claude path", async () => {
    const runtime = makeFirstPartyProviderRuntime({
      providers: [claude],
      settings: { read: () => Effect.succeed(undefined) },
      credentials,
      browserSessions: { cookieHeader: () => Effect.fail(new Error("missing")) },
      local: {
        ...unusedLocal,
        fetchClaudeCliUsage: () =>
          Effect.succeed({ stdout: "x".repeat(1024 * 1024 + 1), stderr: "", loggedIn: true }),
      },
      http: { execute: () => Effect.fail(new Error("not used")) } as never,
      clock,
    });
    await expect(
      Effect.runPromise(runtime.fetch("claude", { sourceMode: "cli", includeCredits: false })),
    ).rejects.toMatchObject({ kind: "api-failure" });

    const runtime2 = makeFirstPartyProviderRuntime({
      providers: [claude],
      settings: { read: () => Effect.succeed(undefined) },
      credentials,
      browserSessions: { cookieHeader: () => Effect.fail(new Error("missing")) },
      local: {
        ...unusedLocal,
        fetchClaudeCliUsage: () =>
          Effect.succeed({ stdout: "x\u0000", stderr: "", loggedIn: true }),
      },
      http: { execute: () => Effect.fail(new Error("not used")) } as never,
      clock,
    });
    await expect(
      Effect.runPromise(runtime2.fetch("claude", { sourceMode: "cli", includeCredits: false })),
    ).rejects.toMatchObject({ kind: "api-failure" });
  });

  it("bounds Claude output by UTF-8 bytes rather than JavaScript characters", async () => {
    const runtime = makeFirstPartyProviderRuntime({
      providers: [claude],
      settings: { read: () => Effect.succeed(undefined) },
      credentials: {
        read: () => Effect.succeed(undefined),
        write: () => Effect.void,
        remove: () => Effect.void,
      },
      browserSessions: { cookieHeader: () => Effect.fail(new Error("missing")) },
      local: {
        ...unusedLocal,
        fetchClaudeCliUsage: () =>
          Effect.succeed({ stdout: "é".repeat(600_000), stderr: "", loggedIn: true }),
      },
      http: { execute: () => Effect.fail(new Error("not used")) } as never,
      clock,
    });
    await expect(
      Effect.runPromise(runtime.fetch("claude", { sourceMode: "cli", includeCredits: false })),
    ).rejects.toMatchObject({ kind: "api-failure" });
  });
});
