import { Effect } from "effect";
import { InfrastructureError, type HttpRequest, type HttpResponse } from "@codexbar/core";
import { manus, stepfun } from "@codexbar/providers";
import { describe, expect, it } from "vite-plus/test";
import { makeFirstPartyProviderRuntime } from "../src/first-party-runtime.ts";

const manusToken = "manus-selected-session";
const stepFunToken = "stepfun-selected-token";
const clock = {
  now: Effect.succeed(Date.parse("2026-08-25T12:00:00Z")),
  sleep: () => Effect.void,
};

const response = (request: HttpRequest, body: unknown, status = 200): HttpResponse => ({
  status,
  headers: { "content-type": "application/json" },
  body: new TextEncoder().encode(JSON.stringify(body)),
  url: request.url,
});

const fixtureResponse = (request: HttpRequest): HttpResponse => {
  const path = new URL(request.url).pathname;
  if (path.endsWith("GetAvailableCredits")) {
    return response(request, {
      totalCredits: 1_000,
      freeCredits: 100,
      proMonthlyCredits: 800,
      periodicCredits: 600,
    });
  }
  if (path.endsWith("QueryStepPlanRateLimit")) {
    return response(request, {
      status: 1,
      five_hour_usage_left_rate: 0.8,
      weekly_usage_left_rate: 0.6,
      five_hour_usage_reset_time: 1_777_528_800,
      weekly_usage_reset_time: 1_777_899_600,
    });
  }
  return response(request, { subscription: { name: "Selected Plan" } });
};

const makeRuntime = (
  requests: HttpRequest[],
  execute?: (request: HttpRequest) => Effect.Effect<HttpResponse, InfrastructureError>,
) =>
  makeFirstPartyProviderRuntime({
    providers: [manus, stepfun],
    settings: {
      read: (providerId, key) =>
        Effect.die(`selected ${providerId} account must suppress ambient setting ${key}`),
    },
    selectedAccounts: {
      resolve: (providerId) =>
        Effect.succeed(
          providerId === "manus"
            ? {
                id: "manus-selected",
                secureSettings: { MANUS_COOKIE_HEADER: `session_id=${manusToken}` },
              }
            : {
                id: "stepfun-selected",
                secureSettings: { STEPFUN_TOKEN: stepFunToken },
              },
        ),
    },
    browserSessions: {
      cookieHeader: (providerId) =>
        Effect.die(`selected ${providerId} account must suppress browser sessions`),
    },
    credentials: {
      read: (key) => Effect.die(`selected account must suppress keyring credential ${key}`),
      write: () => Effect.void,
      remove: () => Effect.void,
    },
    http: {
      execute: (request) => {
        requests.push(request);
        return execute?.(request) ?? Effect.succeed(fixtureResponse(request));
      },
    },
    clock,
  });

describe("first-party runtime selected Manus and StepFun accounts", () => {
  it.each([
    ["manus", "auto"],
    ["manus", "web"],
    ["stepfun", "auto"],
    ["stepfun", "web"],
  ] as const)(
    "isolates the selected %s account under %s source",
    async (providerId, sourceMode) => {
      const requests: HttpRequest[] = [];
      const outcome = await Effect.runPromise(
        makeRuntime(requests).fetch(providerId, { sourceMode, includeCredits: false }),
      );
      expect(outcome.strategyId).toBe(`${providerId}.web`);
      expect(JSON.stringify(outcome)).not.toContain(manusToken);
      expect(JSON.stringify(outcome)).not.toContain(stepFunToken);
      if (providerId === "manus") {
        expect(requests).toHaveLength(1);
        expect(requests[0]?.headers?.Authorization).toBe(`Bearer ${manusToken}`);
        expect(outcome.snapshot).toMatchObject({
          primary: { usedPercent: 25 },
          identity: { providerId: "manus", loginMethod: "Balance: 1,000 credits" },
        });
      } else {
        expect(requests).toHaveLength(2);
        expect(requests.every(({ headers }) => headers?.["Oasis-Token"] === stepFunToken)).toBe(
          true,
        );
        expect(requests.every(({ headers }) => headers?.Cookie?.includes(stepFunToken))).toBe(true);
        expect(outcome.snapshot).toMatchObject({
          primary: { usedPercent: expect.closeTo(20, 8) },
          secondary: { usedPercent: 40 },
          identity: { providerId: "stepfun", loginMethod: "Selected Plan" },
        });
      }
    },
  );

  it.each([
    ["manus", "api"],
    ["manus", "cli"],
    ["manus", "oauth"],
    ["stepfun", "api"],
    ["stepfun", "cli"],
    ["stepfun", "oauth"],
  ] as const)(
    "keeps selected %s web credentials terminal under %s source",
    async (providerId, sourceMode) => {
      const requests: HttpRequest[] = [];
      await expect(
        Effect.runPromise(
          makeRuntime(requests).fetch(providerId, { sourceMode, includeCredits: false }),
        ),
      ).rejects.toMatchObject({ name: "NoAvailableStrategy", providerId });
      expect(requests).toHaveLength(0);
    },
  );

  it.each(["manus", "stepfun"] as const)(
    "redacts the selected %s credential from transport failures",
    async (providerId) => {
      const requests: HttpRequest[] = [];
      const runtime = makeRuntime(requests, () =>
        Effect.fail(
          new InfrastructureError(
            `${providerId} transport`,
            `rejected ${providerId === "manus" ? manusToken : stepFunToken}`,
          ),
        ),
      );
      const failure = await Effect.runPromise(
        Effect.flip(runtime.fetch(providerId, { sourceMode: "auto", includeCredits: false })),
      );
      expect(failure).toMatchObject({ kind: "network-failure" });
      expect(failure.message).toContain("[REDACTED]");
      expect(failure.message).not.toContain(providerId === "manus" ? manusToken : stepFunToken);
    },
  );
});
