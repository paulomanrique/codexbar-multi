import { Effect } from "effect";
import { InfrastructureError, type HttpRequest, type HttpResponse } from "@codexbar/core";
import { factory } from "@codexbar/providers";
import { describe, expect, it } from "vite-plus/test";
import { makeFirstPartyProviderRuntime } from "../src/first-party-runtime.ts";

const cookieToken = "factory-selected-cookie";
const bearerToken = "factory-selected-bearer";
const cookie = `session=${cookieToken}; theme=dark`;
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
  if (new URL(request.url).pathname === "/api/app/auth/me") {
    return response(request, {
      userProfile: { id: "selected-user", email: "selected@factory.example" },
      organization: {
        name: "Selected Organization",
        subscription: {
          factoryTier: "pro",
          orbSubscription: { plan: { name: "Pro" } },
        },
      },
    });
  }
  return response(request, {
    usesTokenRateLimitsBilling: true,
    limits: {
      standard: {
        fiveHour: { usedPercent: 20, secondsRemaining: 600 },
        weekly: { usedPercent: 40, windowEnd: "2026-08-31T00:00:00Z" },
      },
    },
  });
};

const makeRuntime = (
  selectedMaterial: string,
  requests: HttpRequest[],
  execute: (request: HttpRequest) => Effect.Effect<HttpResponse, InfrastructureError> = (request) =>
    Effect.succeed(fixtureResponse(request)),
) =>
  makeFirstPartyProviderRuntime({
    providers: [factory],
    settings: {
      read: (_providerId, key) =>
        Effect.die(`selected Factory account must suppress ambient setting ${key}`),
    },
    selectedAccounts: {
      resolve: () =>
        Effect.succeed({
          id: "factory-selected",
          secureSettings: {
            FACTORY_COOKIE_HEADER: selectedMaterial,
            FACTORY_API_KEY: null,
          },
        }),
    },
    browserSessions: {
      cookieHeader: () => Effect.die("selected Factory account must suppress browser sessions"),
    },
    credentials: {
      read: (key) => Effect.die(`selected Factory account must suppress keyring ${key}`),
      write: () => Effect.void,
      remove: () => Effect.void,
    },
    http: {
      execute: (request) => {
        requests.push(request);
        return execute(request);
      },
    },
    clock,
  });

describe("first-party runtime selected Factory accounts", () => {
  it.each([
    ["cookie-only", `Cookie: ${cookie}`, { Cookie: cookie }],
    [
      "bearer-only",
      `Authorization: Bearer ${bearerToken}`,
      { Authorization: `Bearer ${bearerToken}` },
    ],
    [
      "combined Cookie and Authorization",
      `Cookie: ${cookie}\nAuthorization: Bearer ${bearerToken}`,
      { Cookie: cookie, Authorization: `Bearer ${bearerToken}` },
    ],
  ] as const)(
    "uses the selected %s material under Auto and web",
    async (_label, material, headers) => {
      const expectedHeaders: Readonly<Record<string, string>> = headers;
      for (const sourceMode of ["auto", "web"] as const) {
        const requests: HttpRequest[] = [];
        const outcome = await Effect.runPromise(
          makeRuntime(material, requests).fetch("factory", { sourceMode, includeCredits: false }),
        );
        expect(outcome).toMatchObject({
          strategyId: "factory.web",
          source: "web",
          snapshot: { identity: { providerId: "factory" } },
        });
        expect(requests).toHaveLength(2);
        for (const request of requests) {
          expect(request.method).toBe("GET");
          expect(request.headers).toMatchObject({
            Accept: "application/json",
            "Content-Type": "application/json",
            Origin: "https://app.factory.ai",
            Referer: "https://app.factory.ai/",
            "x-factory-client": "web-app",
            ...expectedHeaders,
          });
          expect(request.headers?.Cookie).toBe(expectedHeaders.Cookie);
          expect(request.headers?.Authorization).toBe(expectedHeaders.Authorization);
        }
        expect(JSON.stringify(outcome)).not.toContain(cookieToken);
        expect(JSON.stringify(outcome)).not.toContain(bearerToken);
      }
    },
  );

  it.each(["api", "cli", "oauth"] as const)(
    "keeps selected Factory web credentials terminal under %s source",
    async (sourceMode) => {
      const requests: HttpRequest[] = [];
      await expect(
        Effect.runPromise(
          makeRuntime(`Cookie: ${cookie}`, requests).fetch("factory", {
            sourceMode,
            includeCredits: false,
          }),
        ),
      ).rejects.toMatchObject({ name: "NoAvailableStrategy", providerId: "factory" });
      expect(requests).toHaveLength(0);
    },
  );

  it("redacts both selected Factory credential components from transport failures", async () => {
    const requests: HttpRequest[] = [];
    const failure = await Effect.runPromise(
      Effect.flip(
        makeRuntime(`Cookie: ${cookie}\nAuthorization: Bearer ${bearerToken}`, requests, () =>
          Effect.fail(
            new InfrastructureError(
              "Factory transport",
              `rejected cookie ${cookie} and bearer ${bearerToken}`,
            ),
          ),
        ).fetch("factory", { sourceMode: "auto", includeCredits: false }),
      ),
    );
    expect(failure).toMatchObject({ kind: "network-failure" });
    expect(failure.message).toContain("[REDACTED]");
    expect(failure.message).not.toContain(cookie);
    expect(failure.message).not.toContain(cookieToken);
    expect(failure.message).not.toContain(bearerToken);
  });
});
