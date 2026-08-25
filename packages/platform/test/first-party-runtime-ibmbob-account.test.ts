import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { InfrastructureError, type HttpRequest } from "@codexbar/core";
import { ibmbob } from "@codexbar/providers";
import { makeFirstPartyProviderRuntime } from "../src/first-party-runtime.ts";

const clock = { now: Effect.succeed(Date.parse("2026-08-24T12:00:00Z")), sleep: () => Effect.void };

const payloadFor = (request: HttpRequest, regionDomain: string): unknown =>
  request.url.endsWith("/admin/v1/profile")
    ? {
        instances: [
          {
            instance_id: "instance-1",
            instance_name: "Enterprise",
            user_id: "user-1",
            plan_name: "Pro",
            region_domain: regionDomain,
            teams: [{ id: "team-1", name: "Core", budget_limit: 100 }],
          },
        ],
      }
    : { usage: 25, budget_limit: 100 };

const response = (request: HttpRequest, regionDomain: string) => ({
  status: 200,
  headers: { "content-type": "application/json" },
  body: new TextEncoder().encode(JSON.stringify(payloadFor(request, regionDomain))),
  url: request.url,
});

const runtime = (credential: string, requests: HttpRequest[], regionDomain = "eu-de.bob.ibm.com") =>
  makeFirstPartyProviderRuntime({
    providers: [ibmbob],
    settings: {
      read: (_provider, key) =>
        key === "BOBSHELL_API_KEY"
          ? Effect.die("selected account must suppress ambient IBM Bob credentials")
          : Effect.succeed(undefined),
    },
    selectedAccounts: {
      resolve: () =>
        Effect.succeed({
          id: "ibmbob-selected",
          secureSettings: { BOBSHELL_API_KEY: credential },
        }),
    },
    browserSessions: { cookieHeader: () => Effect.succeed("") },
    credentials: {
      read: () => Effect.die("selected account must suppress keyring IBM Bob credentials"),
      write: () => Effect.void,
      remove: () => Effect.void,
    },
    http: {
      execute: (request) => {
        requests.push(request);
        return Effect.succeed(response(request, regionDomain));
      },
    },
    clock,
  });

describe("first-party runtime selected IBM Bob accounts", () => {
  it.each([
    ["selected-api-key", "Apikey selected-api-key"],
    ["header.eyJzdWIiOiJ1c2VyIn0.signature", "Bearer header.eyJzdWIiOiJ1c2VyIn0.signature"],
  ] as const)(
    "preserves provider-managed authorization for %s",
    async (credential, authorization) => {
      const requests: HttpRequest[] = [];
      const outcome = await Effect.runPromise(
        runtime(credential, requests).fetch("ibmbob", {
          sourceMode: "auto",
          includeCredits: false,
        }),
      );

      expect(outcome.strategyId).toBe("ibmbob.api");
      expect(requests).toHaveLength(2);
      expect(requests.map((request) => request.url)).toEqual([
        "https://api.us-east.bob.ibm.com/admin/v1/profile",
        "https://api.eu-de.bob.ibm.com/admin/v1/teams/team-1/users/user-1",
      ]);
      expect(requests.every((request) => request.headers?.Authorization === authorization)).toBe(
        true,
      );
      expect(requests[1]?.headers).toMatchObject({
        "x-instance-id": "instance-1",
        "x-team-id": "team-1",
      });
      expect(JSON.stringify(outcome)).not.toContain(credential);
    },
  );

  it("uses the selected IBM Bob key under explicit API source", async () => {
    const requests: HttpRequest[] = [];
    const outcome = await Effect.runPromise(
      runtime("selected-api-key", requests).fetch("ibmbob", {
        sourceMode: "api",
        includeCredits: false,
      }),
    );

    expect(outcome.strategyId).toBe("ibmbob.api");
    expect(requests).toHaveLength(2);
  });

  it.each(["web", "cli", "oauth"] as const)(
    "keeps a selected IBM Bob account terminal under %s source",
    async (sourceMode) => {
      const requests: HttpRequest[] = [];
      await expect(
        Effect.runPromise(
          runtime("selected-api-key", requests).fetch("ibmbob", {
            sourceMode,
            includeCredits: false,
          }),
        ),
      ).rejects.toMatchObject({ name: "NoAvailableStrategy", providerId: "ibmbob" });
      expect(requests).toHaveLength(0);
    },
  );

  it.each(["eu-de.bob.ibm.com?unexpected=value", "eu-de.bob.ibm.com#fragment"])(
    "rejects selected-account regional host suffix data in %s before transport",
    async (regionDomain) => {
      const requests: HttpRequest[] = [];
      await expect(
        Effect.runPromise(
          runtime("selected-api-key", requests, regionDomain).fetch("ibmbob", {
            sourceMode: "auto",
            includeCredits: false,
          }),
        ),
      ).rejects.toMatchObject({ kind: "permission-denied" });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe("https://api.us-east.bob.ibm.com/admin/v1/profile");
    },
  );

  it("redacts selected IBM Bob material from transport failures", async () => {
    const selected = makeFirstPartyProviderRuntime({
      providers: [ibmbob],
      settings: { read: () => Effect.succeed(undefined) },
      selectedAccounts: {
        resolve: () =>
          Effect.succeed({
            id: "ibmbob-selected",
            secureSettings: { BOBSHELL_API_KEY: "selected-api-key" },
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
          Effect.fail(new InfrastructureError("test transport", "selected-api-key rejected")),
      },
      clock,
    });

    const error = await Effect.runPromise(
      Effect.flip(selected.fetch("ibmbob", { sourceMode: "auto", includeCredits: false })),
    );
    expect(error).toMatchObject({ kind: "network-failure" });
    expect(error.message).toContain("[REDACTED]");
    expect(error.message).not.toContain("selected-api-key");
  });
});
