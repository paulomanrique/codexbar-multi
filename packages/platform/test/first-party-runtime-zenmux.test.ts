import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import type { HttpRequest } from "@codexbar/core";
import { zenmux } from "@codexbar/providers";

import { makeFirstPartyProviderRuntime } from "../src/first-party-runtime.ts";

const clock = { now: Effect.succeed(Date.parse("2026-08-25T12:00:00Z")), sleep: () => Effect.void };

const body = (request: HttpRequest, value: unknown) => ({
  status: 200,
  headers: { "content-type": "application/json" },
  body: new TextEncoder().encode(JSON.stringify(value)),
  url: request.url,
});

const subscription = {
  success: true,
  data: {
    plan: { tier: "ultra" },
    account_status: "healthy",
    quota_5_hour: {
      usage_percentage: 0.1,
      max_flows: 100,
      used_flows: 10,
      remaining_flows: 90,
    },
    quota_7_day: {
      usage_percentage: 0.2,
      max_flows: 200,
      used_flows: 40,
      remaining_flows: 160,
    },
  },
};

const runtime = (requests: HttpRequest[]) =>
  makeFirstPartyProviderRuntime({
    providers: [zenmux],
    settings: {
      read: (_provider, key) =>
        Effect.succeed(key === "ZENMUX_MANAGEMENT_API_KEY" ? "management-key" : undefined),
    },
    browserSessions: { cookieHeader: () => Effect.succeed("") },
    credentials: {
      read: () => Effect.succeed(undefined),
      write: () => Effect.void,
      remove: () => Effect.void,
    },
    http: {
      execute: (request) => {
        requests.push(request);
        return Effect.succeed(
          body(
            request,
            request.url.endsWith("/payg/balance")
              ? { success: true, data: { currency: "usd", total_credits: 42 } }
              : subscription,
          ),
        );
      },
    },
    clock,
  });

describe("first-party runtime ZenMux optional usage", () => {
  it.each([
    { includeCredits: false, expectedPaths: ["/api/v1/management/subscription/detail"] },
    {
      includeCredits: true,
      expectedPaths: ["/api/v1/management/subscription/detail", "/api/v1/management/payg/balance"],
    },
  ])("propagates includeCredits=$includeCredits", async ({ includeCredits, expectedPaths }) => {
    const requests: HttpRequest[] = [];
    const outcome = await Effect.runPromise(
      runtime(requests).fetch("zenmux", { sourceMode: "auto", includeCredits }),
    );

    expect(outcome.strategyId).toBe("zenmux.api");
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual(expectedPaths);
    if (includeCredits) expect(outcome.snapshot.providerCost).toMatchObject({ used: 42 });
    else expect(outcome.snapshot).not.toHaveProperty("providerCost");
  });
});
