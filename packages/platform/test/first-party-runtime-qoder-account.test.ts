import { Effect } from "effect";
import { InfrastructureError, type HttpRequest, type HttpResponse } from "@codexbar/core";
import { qoder } from "@codexbar/providers";
import { describe, expect, it } from "vite-plus/test";
import { makeFirstPartyProviderRuntime } from "../src/first-party-runtime.ts";

const selectedToken = "qoder-selected-session-token";
const selectedCookie = `session=${selectedToken}; locale=en`;
const clock = {
  now: Effect.succeed(Date.parse("2026-08-25T12:00:00Z")),
  sleep: () => Effect.void,
};

const quotaResponse = (request: HttpRequest): HttpResponse => ({
  status: 200,
  headers: { "content-type": "application/json" },
  body: new TextEncoder().encode(
    JSON.stringify({
      totalQuota: {
        quotaSummary: { usedValue: 1_500, limitValue: 1_500, usagePercentage: 100 },
      },
      sharedQuota: {
        quotaSummary: { usedValue: 200, limitValue: 1_000 },
      },
      nextResetAt: "2027-01-15T00:00:00Z",
    }),
  ),
  url: request.url,
});

const makeRuntime = (
  site: "qoder.com" | "qoder.com.cn",
  requests: HttpRequest[],
  execute: (request: HttpRequest) => Effect.Effect<HttpResponse, InfrastructureError> = (request) =>
    Effect.succeed(quotaResponse(request)),
) =>
  makeFirstPartyProviderRuntime({
    providers: [qoder],
    settings: {
      read: (_providerId, key) =>
        Effect.die(`selected Qoder account must suppress ambient setting ${key}`),
    },
    selectedAccounts: {
      resolve: () =>
        Effect.succeed({
          id: `qoder-selected-${site}`,
          plainSettings: { QODER_SITE: site },
          secureSettings: { QODER_COOKIE_HEADER: selectedCookie },
        }),
    },
    browserSessions: {
      cookieHeader: () => Effect.die("selected Qoder account must suppress browser sessions"),
    },
    credentials: {
      read: (key) => Effect.die(`selected Qoder account must suppress keyring ${key}`),
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

describe("first-party runtime selected Qoder accounts", () => {
  it.each(["qoder.com", "qoder.com.cn"] as const)(
    "uses the selected cookie-only account on the exact %s host under Auto and web",
    async (site) => {
      for (const sourceMode of ["auto", "web"] as const) {
        const requests: HttpRequest[] = [];
        const outcome = await Effect.runPromise(
          makeRuntime(site, requests).fetch("qoder", { sourceMode, includeCredits: false }),
        );
        const origin = `https://${site}`;
        expect(outcome).toMatchObject({
          strategyId: "qoder.web",
          source: "web",
          snapshot: {
            primary: {
              usedPercent: 68,
              resetDescription: "1,700 / 2,500 credits",
            },
          },
        });
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({
          method: "GET",
          url: `${origin}/api/v2/me/usages/big_model_credits`,
          headers: {
            Cookie: selectedCookie,
            Origin: origin,
            Referer: `${origin}/account/usage`,
            "X-Requested-With": "XMLHttpRequest",
            "Bx-V": "2.5.35",
          },
        });
        expect(new URL(requests[0]!.url).hostname).toBe(site);
        expect(JSON.stringify(outcome)).not.toContain(selectedToken);
      }
    },
  );

  it.each(["api", "cli", "oauth"] as const)(
    "keeps the selected Qoder web account terminal under %s source",
    async (sourceMode) => {
      const requests: HttpRequest[] = [];
      await expect(
        Effect.runPromise(
          makeRuntime("qoder.com", requests).fetch("qoder", {
            sourceMode,
            includeCredits: false,
          }),
        ),
      ).rejects.toMatchObject({ name: "NoAvailableStrategy", providerId: "qoder" });
      expect(requests).toHaveLength(0);
    },
  );

  it("redacts the selected Qoder cookie from transport failures", async () => {
    const requests: HttpRequest[] = [];
    const failure = await Effect.runPromise(
      Effect.flip(
        makeRuntime("qoder.com", requests, () =>
          Effect.fail(
            new InfrastructureError(
              "Qoder transport",
              `request rejected cookie ${selectedCookie} token ${selectedToken}`,
            ),
          ),
        ).fetch("qoder", { sourceMode: "auto", includeCredits: false }),
      ),
    );
    expect(failure).toMatchObject({ kind: "network-failure" });
    expect(failure.message).toContain("[REDACTED]");
    expect(failure.message).not.toContain(selectedCookie);
    expect(failure.message).not.toContain(selectedToken);
  });
});
