import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import type { HttpRequest, PersistedCodexBarConfig } from "@codexbar/core";
import { fireworks, moonshot } from "@codexbar/providers";
import {
  makeFirstPartyProviderRuntime,
  type FirstPartySettings,
} from "../src/first-party-runtime.ts";
import { makePersistedFirstPartySettings } from "../src/persisted-provider-settings.ts";

const ambient: FirstPartySettings = {
  read: () => Effect.succeed(undefined),
};

const response = (request: HttpRequest, body: unknown) => ({
  status: 200,
  headers: {},
  body: new TextEncoder().encode(JSON.stringify(body)),
  url: request.url,
});

const runtime = (
  config: PersistedCodexBarConfig,
  requests: HttpRequest[],
  body: unknown,
  keyring: Readonly<Record<string, string>> = {},
) =>
  makeFirstPartyProviderRuntime({
    providers: [fireworks, moonshot],
    settings: ambient,
    resolveFetchState: (providerId) =>
      Effect.succeed({
        settings: makePersistedFirstPartySettings(config, providerId, ambient),
      }),
    credentials: {
      read: (key) => Effect.succeed(keyring[key]),
      write: () => Effect.void,
      remove: () => Effect.void,
    },
    browserSessions: { cookieHeader: () => Effect.fail(new Error("not used")) },
    http: {
      execute: (request) => {
        requests.push(request);
        return Effect.succeed(response(request, body));
      },
    },
    clock: { now: Effect.succeed(Date.parse("2026-08-26T12:00:00Z")), sleep: () => Effect.void },
  });

describe("first-party runtime persisted settings", () => {
  it("executes Fireworks from persisted key/slug and lets the native keyring win", async () => {
    const config: PersistedCodexBarConfig = {
      version: 1,
      providers: [
        {
          id: "fireworks",
          apiKey: "persisted-fireworks-key",
          extensions: { accountSlug: "persisted-account" },
        },
      ],
    };
    const persistedRequests: HttpRequest[] = [];
    const persistedOutcome = await Effect.runPromise(
      runtime(config, persistedRequests, {
        lineItems: [{ totalCost: { currencyCode: "USD", units: "1", nanos: 250_000_000 } }],
      }).fetch("fireworks", { sourceMode: "api", includeCredits: false }),
    );
    expect(persistedRequests).toHaveLength(1);
    expect(persistedRequests[0]).toMatchObject({
      headers: { Authorization: "Bearer persisted-fireworks-key", Accept: "application/json" },
    });
    expect(persistedRequests[0]?.url).toContain("/accounts/persisted-account/billing/summary");
    expect(persistedOutcome.snapshot.providerCost?.used).toBe(1.25);
    expect(JSON.stringify(persistedOutcome)).not.toContain("persisted-fireworks-key");

    const keyringRequests: HttpRequest[] = [];
    await Effect.runPromise(
      runtime(
        config,
        keyringRequests,
        { lineItems: [] },
        {
          "provider/fireworks/secret/CODEXBAR_FIREWORKS_API_KEY": "keyring-fireworks-key",
        },
      ).fetch("fireworks", { sourceMode: "api", includeCredits: false }),
    );
    expect(keyringRequests[0]?.headers?.Authorization).toBe("Bearer keyring-fireworks-key");
  });

  it("keeps a persisted Moonshot key bound to the matching regional host", async () => {
    const config: PersistedCodexBarConfig = {
      version: 1,
      providers: [
        {
          id: "moonshot",
          apiKey: "persisted-moonshot-key",
          region: "china",
          extensions: { apiKeyRegion: "china" },
        },
      ],
    };
    const requests: HttpRequest[] = [];
    const outcome = await Effect.runPromise(
      runtime(config, requests, {
        code: 0,
        scode: "0x0",
        status: true,
        data: { available_balance: 10, voucher_balance: 0, cash_balance: 10 },
      }).fetch("moonshot", { sourceMode: "api", includeCredits: false }),
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.moonshot.cn/v1/users/me/balance");
    expect(requests[0]?.headers?.Authorization).toBe("Bearer persisted-moonshot-key");
    expect(outcome.snapshot.identity?.loginMethod).toBe("Balance: $10.00");
    expect(JSON.stringify(outcome)).not.toContain("persisted-moonshot-key");
  });

  it("never mixes host/path and bearer values across concurrent config generations", async () => {
    const moonshotConfigs: readonly PersistedCodexBarConfig[] = [
      {
        version: 1,
        providers: [
          {
            id: "moonshot",
            apiKey: "china-generation-key",
            region: "china",
            extensions: { apiKeyRegion: "china" },
          },
        ],
      },
      {
        version: 1,
        providers: [
          {
            id: "moonshot",
            apiKey: "international-generation-key",
            region: "international",
            extensions: { apiKeyRegion: "international" },
          },
        ],
      },
    ];
    const moonshotRequests: HttpRequest[] = [];
    let moonshotGeneration = 0;
    const moonshotRuntime = makeFirstPartyProviderRuntime({
      providers: [moonshot],
      settings: ambient,
      resolveFetchState: (providerId) => {
        const config = moonshotConfigs[moonshotGeneration++];
        if (config === undefined) return Effect.die("unexpected Moonshot fetch");
        return Effect.succeed({
          settings: makePersistedFirstPartySettings(config, providerId, ambient),
        });
      },
      credentials: {
        read: () => Effect.succeed(undefined),
        write: () => Effect.void,
        remove: () => Effect.void,
      },
      browserSessions: { cookieHeader: () => Effect.fail(new Error("not used")) },
      http: {
        execute: (request) => {
          moonshotRequests.push(request);
          return Effect.succeed(
            response(request, {
              code: 0,
              scode: "0x0",
              status: true,
              data: { available_balance: 1, voucher_balance: 0, cash_balance: 1 },
            }),
          );
        },
      },
      clock: { now: Effect.succeed(1), sleep: () => Effect.void },
    });
    await Promise.all([
      Effect.runPromise(
        moonshotRuntime.fetch("moonshot", { sourceMode: "api", includeCredits: false }),
      ),
      Effect.runPromise(
        moonshotRuntime.fetch("moonshot", { sourceMode: "api", includeCredits: false }),
      ),
    ]);
    expect(
      moonshotRequests
        .map((request) => `${new URL(request.url).hostname}|${request.headers?.Authorization}`)
        .sort(),
    ).toEqual([
      "api.moonshot.ai|Bearer international-generation-key",
      "api.moonshot.cn|Bearer china-generation-key",
    ]);

    const fireworksConfigs: readonly PersistedCodexBarConfig[] = [
      {
        version: 1,
        providers: [{ id: "fireworks", apiKey: "key-a", extensions: { accountSlug: "account-a" } }],
      },
      {
        version: 1,
        providers: [{ id: "fireworks", apiKey: "key-b", extensions: { accountSlug: "account-b" } }],
      },
    ];
    const fireworksRequests: HttpRequest[] = [];
    let fireworksGeneration = 0;
    const fireworksRuntime = makeFirstPartyProviderRuntime({
      providers: [fireworks],
      settings: ambient,
      resolveFetchState: (providerId) => {
        const config = fireworksConfigs[fireworksGeneration++];
        if (config === undefined) return Effect.die("unexpected Fireworks fetch");
        return Effect.succeed({
          settings: makePersistedFirstPartySettings(config, providerId, ambient),
        });
      },
      credentials: {
        read: () => Effect.succeed(undefined),
        write: () => Effect.void,
        remove: () => Effect.void,
      },
      browserSessions: { cookieHeader: () => Effect.fail(new Error("not used")) },
      http: {
        execute: (request) => {
          fireworksRequests.push(request);
          return Effect.succeed(response(request, { lineItems: [] }));
        },
      },
      clock: { now: Effect.succeed(1), sleep: () => Effect.void },
    });
    await Promise.all([
      Effect.runPromise(
        fireworksRuntime.fetch("fireworks", { sourceMode: "api", includeCredits: false }),
      ),
      Effect.runPromise(
        fireworksRuntime.fetch("fireworks", { sourceMode: "api", includeCredits: false }),
      ),
    ]);
    expect(
      fireworksRequests
        .map(
          (request) =>
            `${new URL(request.url).pathname.match(/accounts\/([^/]+)/u)?.[1]}|${request.headers?.Authorization}`,
        )
        .sort(),
    ).toEqual(["account-a|Bearer key-a", "account-b|Bearer key-b"]);
  });
});
