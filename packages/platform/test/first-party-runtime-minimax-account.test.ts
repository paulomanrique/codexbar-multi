import { Effect } from "effect";
import { InfrastructureError, type HttpRequest, type HttpResponse } from "@codexbar/core";
import { minimax } from "@codexbar/providers";
import { describe, expect, it } from "vite-plus/test";
import { makeFirstPartyProviderRuntime } from "../src/first-party-runtime.ts";

const cookieToken = "minimax-selected-cookie";
const bearerToken = "minimax-selected-bearer";
const groupId = "654321";
const cookie = `session=${cookieToken}; locale=en`;
const userAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
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

const remains = {
  model_remains: [
    {
      model_name: "General",
      current_interval_total_count: 100,
      current_interval_usage_count: 20,
      current_weekly_total_count: 1_000,
      current_weekly_usage_count: 400,
      end_time: 1_756_000_000,
      weekly_end_time: 1_756_600_000,
    },
  ],
  current_subscribe_title: "Coding Plan Pro",
};

const makeRuntime = (
  selectedMaterial: {
    readonly cookie: string;
    readonly bearer?: string;
    readonly group?: string;
  },
  requests: HttpRequest[],
  execute: (request: HttpRequest) => Effect.Effect<HttpResponse, InfrastructureError> = (request) =>
    Effect.succeed(response(request, remains)),
) =>
  makeFirstPartyProviderRuntime({
    providers: [minimax],
    settings: {
      read: (_providerId, key) =>
        key === "MINIMAX_API_REGION"
          ? Effect.succeed("global")
          : Effect.die(`selected MiniMax account must suppress ambient setting ${key}`),
    },
    selectedAccounts: {
      resolve: () =>
        Effect.succeed({
          id: "minimax-selected",
          secureSettings: {
            MINIMAX_COOKIE: null,
            MINIMAX_COOKIE_HEADER: selectedMaterial.cookie,
            MINIMAX_AUTHORIZATION_TOKEN: selectedMaterial.bearer ?? null,
            MINIMAX_API_TOKEN: null,
            MINIMAX_API_KEY: null,
            MINIMAX_CODING_API_KEY: null,
            MINIMAX_GROUP_ID: selectedMaterial.group ?? null,
          },
        }),
    },
    browserSessions: {
      cookieHeader: () => Effect.die("selected MiniMax account must suppress browser sessions"),
    },
    credentials: {
      read: (key) => Effect.die(`selected MiniMax account must suppress keyring ${key}`),
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

describe("first-party runtime selected MiniMax accounts", () => {
  it.each([
    ["cookie-only", { cookie }, { Cookie: cookie, Authorization: undefined, group: undefined }],
    [
      "cookie, bearer and group ID",
      { cookie, bearer: bearerToken, group: groupId },
      { Cookie: cookie, Authorization: `Bearer ${bearerToken}`, group: groupId },
    ],
  ] as const)(
    "uses the selected %s account under Auto and web",
    async (_label, material, expected) => {
      for (const sourceMode of ["auto", "web"] as const) {
        const requests: HttpRequest[] = [];
        const outcome = await Effect.runPromise(
          makeRuntime(material, requests).fetch("minimax", { sourceMode, includeCredits: false }),
        );
        expect(outcome).toMatchObject({
          strategyId: "minimax.web",
          source: "web",
          snapshot: { identity: { providerId: "minimax" } },
        });
        expect(requests).toHaveLength(1);
        const request = requests[0]!;
        expect(request).toMatchObject({
          method: "GET",
          url: expected.group
            ? `https://platform.minimax.io/v1/api/openplatform/coding_plan/remains?GroupId=${expected.group}`
            : "https://platform.minimax.io/v1/api/openplatform/coding_plan/remains",
          headers: {
            Cookie: expected.Cookie,
            Accept: "application/json, text/plain, */*",
            "X-Requested-With": "XMLHttpRequest",
            "User-Agent": userAgent,
            "Accept-Language": "en-US,en;q=0.9",
            Origin: "https://platform.minimax.io",
            Referer: "https://platform.minimax.io/user-center/payment/coding-plan",
          },
        });
        expect(request.headers?.Authorization).toBe(expected.Authorization);
        expect(new URL(request.url).searchParams.get("GroupId")).toBe(expected.group ?? null);
        expect(JSON.stringify(outcome)).not.toContain(cookieToken);
        expect(JSON.stringify(outcome)).not.toContain(bearerToken);
        expect(JSON.stringify(outcome)).not.toContain(groupId);
      }
    },
  );

  it.each(["api", "cli", "oauth"] as const)(
    "keeps selected MiniMax web credentials terminal under %s source",
    async (sourceMode) => {
      const requests: HttpRequest[] = [];
      await expect(
        Effect.runPromise(
          makeRuntime({ cookie }, requests).fetch("minimax", {
            sourceMode,
            includeCredits: false,
          }),
        ),
      ).rejects.toMatchObject({ name: "NoAvailableStrategy", providerId: "minimax" });
      expect(requests).toHaveLength(0);
    },
  );

  it("redacts cookie, bearer and group ID from transport failures", async () => {
    const requests: HttpRequest[] = [];
    const failure = await Effect.runPromise(
      Effect.flip(
        makeRuntime({ cookie, bearer: bearerToken, group: groupId }, requests, () =>
          Effect.fail(
            new InfrastructureError(
              "MiniMax transport",
              `rejected cookie ${cookie}, bearer ${bearerToken}, group ${groupId}`,
            ),
          ),
        ).fetch("minimax", { sourceMode: "auto", includeCredits: false }),
      ),
    );
    expect(failure).toMatchObject({ kind: "network-failure" });
    expect(failure.message).toContain("[REDACTED]");
    expect(failure.message).not.toContain(cookie);
    expect(failure.message).not.toContain(cookieToken);
    expect(failure.message).not.toContain(bearerToken);
    expect(failure.message).not.toContain(groupId);
  });

  it("uses www only for an allowed remains fallback and derives its Origin from that host", async () => {
    const requests: HttpRequest[] = [];
    const outcome = await Effect.runPromise(
      makeRuntime({ cookie }, requests, (request) =>
        Effect.succeed(
          request.url.startsWith("https://platform.minimax.io/")
            ? response(request, {}, 404)
            : response(request, remains),
        ),
      ).fetch("minimax", { sourceMode: "web", includeCredits: false }),
    );
    expect(outcome.strategyId).toBe("minimax.web");
    expect(requests).toHaveLength(2);
    expect(requests[0]?.headers?.Origin).toBe("https://platform.minimax.io");
    expect(requests[1]).toMatchObject({
      url: "https://www.minimax.io/v1/api/openplatform/coding_plan/remains",
      headers: {
        Origin: "https://www.minimax.io",
        Referer: "https://platform.minimax.io/user-center/payment/coding-plan",
      },
    });
  });

  it.each([
    [401, "authentication-expired"],
    [500, "provider-unavailable"],
  ] as const)("keeps HTTP %i terminal without probing www", async (status, kind) => {
    const requests: HttpRequest[] = [];
    const failure = await Effect.runPromise(
      Effect.flip(
        makeRuntime({ cookie }, requests, (request) =>
          Effect.succeed(response(request, {}, status)),
        ).fetch("minimax", { sourceMode: "web", includeCredits: false }),
      ),
    );
    expect(failure).toMatchObject({ kind });
    expect(requests).toHaveLength(1);
  });
});
