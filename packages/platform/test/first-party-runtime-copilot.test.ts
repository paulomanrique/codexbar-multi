import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { InfrastructureError, type HttpRequest } from "@codexbar/core";
import { copilot } from "@codexbar/providers";
import { makeFirstPartyProviderRuntime } from "../src/first-party-runtime.ts";

const usage = {
  copilot_plan: "pro",
  quota_snapshots: {
    premium_interactions: {
      entitlement: 300,
      remaining: 240,
      percent_remaining: 80,
      quota_id: "premium",
    },
  },
};

const response = (request: HttpRequest, body: unknown, contentType = "application/json") => ({
  status: 200,
  headers: { "content-type": contentType },
  body: new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body)),
  url: request.url,
});

describe("first-party runtime selected Copilot accounts", () => {
  it("keeps selected OAuth auth on APIs and suppresses it on cookie budget pages", async () => {
    const requests: HttpRequest[] = [];
    const settingReads: string[] = [];
    const credentialReads: string[] = [];
    const cookieAccountIds: Array<string | undefined> = [];
    const runtime = makeFirstPartyProviderRuntime({
      providers: [copilot],
      settings: {
        read: (_provider, key) => {
          settingReads.push(key);
          return Effect.succeed(
            key === "COPILOT_API_TOKEN"
              ? "ambient-token"
              : key === "COPILOT_BUDGET_EXTRAS_ENABLED"
                ? "true"
                : key === "COPILOT_BUDGET_COOKIE_SOURCE"
                  ? "auto"
                  : undefined,
          );
        },
      },
      selectedAccounts: {
        resolve: () =>
          Effect.succeed({
            id: "copilot-selected",
            externalIdentifier: "github:user:42",
            secureSettings: { COPILOT_API_TOKEN: "selected-token" },
          }),
      },
      browserSessions: {
        cookieHeader: (_provider, _domain, accountId) => {
          cookieAccountIds.push(accountId);
          return Effect.succeed("user_session=cookie-secret");
        },
      },
      credentials: {
        read: (key) => {
          credentialReads.push(key);
          return Effect.succeed("keyring-token");
        },
        write: () => Effect.void,
        remove: () => Effect.void,
      },
      http: {
        execute: (request) => {
          requests.push(request);
          const url = new URL(request.url);
          if (url.pathname === "/copilot_internal/user") {
            return Effect.succeed(response(request, usage));
          }
          if (url.pathname === "/user") {
            return Effect.succeed(response(request, { id: 42, login: "selected-login" }));
          }
          if (url.pathname === "/settings/billing/budgets" && url.search === "") {
            return Effect.succeed(
              response(
                request,
                '<meta name="octolytics-actor-id" content="42"><meta name="user-login" content="selected-login"><meta name="x-fetch-nonce" content="nonce">',
                "text/html",
              ),
            );
          }
          return Effect.succeed(response(request, { budgets: [], has_next_page: false }));
        },
      },
      clock: { now: Effect.succeed(Date.parse("2026-08-24T12:00:00Z")), sleep: () => Effect.void },
    });

    const outcome = await Effect.runPromise(
      runtime.fetch("copilot", { sourceMode: "auto", includeCredits: false }),
    );
    expect(outcome.strategyId).toBe("copilot.api");
    const apiRequests = requests.filter(
      (request) => new URL(request.url).hostname === "api.github.com",
    );
    const budgetRequests = requests.filter(
      (request) => new URL(request.url).pathname === "/settings/billing/budgets",
    );
    expect(apiRequests.map((request) => request.headers?.Authorization)).toEqual([
      "token selected-token",
      "token selected-token",
    ]);
    expect(budgetRequests).toHaveLength(2);
    expect(budgetRequests.every((request) => request.headers?.Authorization === undefined)).toBe(
      true,
    );
    expect(
      budgetRequests.every((request) => request.headers?.Cookie === "user_session=cookie-secret"),
    ).toBe(true);
    expect(cookieAccountIds).toEqual([undefined]);
    expect(settingReads).not.toContain("COPILOT_API_TOKEN");
    expect(credentialReads).not.toContain("provider/copilot/secret/COPILOT_API_TOKEN");
    expect(JSON.stringify(outcome)).not.toContain("selected-token");
    expect(JSON.stringify(outcome)).not.toContain("cookie-secret");
  });

  it("redacts a selected token echoed by a transport failure", async () => {
    const runtime = makeFirstPartyProviderRuntime({
      providers: [copilot],
      settings: { read: () => Effect.succeed(undefined) },
      selectedAccounts: {
        resolve: () =>
          Effect.succeed({
            id: "copilot-selected",
            secureSettings: { COPILOT_API_TOKEN: "selected-token" },
          }),
      },
      browserSessions: { cookieHeader: () => Effect.succeed("") },
      credentials: {
        read: () => Effect.succeed(undefined),
        write: () => Effect.void,
        remove: () => Effect.void,
      },
      http: {
        execute: () =>
          Effect.fail(new InfrastructureError("test transport", "selected-token rejected")),
      },
      clock: { now: Effect.succeed(0), sleep: () => Effect.void },
    });

    const error = await Effect.runPromise(
      Effect.flip(runtime.fetch("copilot", { sourceMode: "auto", includeCredits: false })),
    );
    expect(error.message).toContain("[REDACTED]");
    expect(error.message).not.toContain("selected-token");
  });

  it.each(["web", "cli", "oauth"] as const)(
    "keeps selected Copilot terminal outside auto/api under %s source",
    async (sourceMode) => {
      let requests = 0;
      const runtime = makeFirstPartyProviderRuntime({
        providers: [copilot],
        settings: { read: () => Effect.succeed(undefined) },
        selectedAccounts: {
          resolve: () =>
            Effect.succeed({
              id: "copilot-selected",
              secureSettings: { COPILOT_API_TOKEN: "selected-token" },
            }),
        },
        browserSessions: { cookieHeader: () => Effect.succeed("") },
        credentials: {
          read: () => Effect.succeed(undefined),
          write: () => Effect.void,
          remove: () => Effect.void,
        },
        http: {
          execute: (request) => {
            requests += 1;
            return Effect.succeed(response(request, usage));
          },
        },
        clock: { now: Effect.succeed(0), sleep: () => Effect.void },
      });

      await expect(
        Effect.runPromise(runtime.fetch("copilot", { sourceMode, includeCredits: false })),
      ).rejects.toMatchObject({ name: "NoAvailableStrategy", providerId: "copilot" });
      expect(requests).toBe(0);
    },
  );

  it("rejects managed-auth suppression outside the allowlisted Copilot budget URL", async () => {
    const malicious = {
      ...copilot,
      fetchUsage: async (ctx: Parameters<typeof copilot.fetchUsage>[0]) => {
        await ctx.http.get("https://api.github.com/user", {
          __codexbarSuppressManagedAuth: true,
        });
        return usage as never;
      },
    };
    const runtime = makeFirstPartyProviderRuntime({
      providers: [malicious],
      settings: {
        read: (_provider, key) => Effect.succeed(key === "COPILOT_API_TOKEN" ? "token" : undefined),
      },
      browserSessions: { cookieHeader: () => Effect.succeed("") },
      credentials: {
        read: () => Effect.succeed(undefined),
        write: () => Effect.void,
        remove: () => Effect.void,
      },
      http: { execute: (request) => Effect.succeed(response(request, {})) },
      clock: { now: Effect.succeed(0), sleep: () => Effect.void },
    });

    await expect(
      Effect.runPromise(runtime.fetch("copilot", { sourceMode: "auto", includeCredits: false })),
    ).rejects.toMatchObject({ kind: "permission-denied" });
  });
});
