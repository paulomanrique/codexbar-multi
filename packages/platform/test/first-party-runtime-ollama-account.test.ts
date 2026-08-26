import { Effect } from "effect";
import {
  InfrastructureError,
  MissingBrowserCredentialError,
  type HttpRequest,
  type HttpResponse,
} from "@codexbar/core";
import { ollama } from "@codexbar/providers";
import { describe, expect, it } from "vite-plus/test";
import { makeFirstPartyProviderRuntime } from "../src/first-party-runtime.ts";

const selectedSession = "ollama-selected-session";
const selectedCookie = `__Secure-session=${selectedSession}`;
const clock = {
  now: Effect.succeed(Date.parse("2026-08-25T12:00:00Z")),
  sleep: () => Effect.void,
};
const usageHTML =
  '<span>Cloud Usage</span><span>Pro</span><div id="header-email">selected@example.com</div>' +
  '<span>Session usage</span><span>20% used</span><div data-time="2026-08-25T14:00:00Z"></div>' +
  '<span>Weekly usage</span><span>40% used</span><div data-time="2026-08-31T00:00:00Z"></div>';

const response = (request: HttpRequest, bodyText = usageHTML): HttpResponse => ({
  status: 200,
  headers: { "content-type": "text/html" },
  body: new TextEncoder().encode(bodyText),
  url: request.url,
});

const makeRuntime = (
  requests: HttpRequest[],
  execute?: (request: HttpRequest) => Effect.Effect<HttpResponse, InfrastructureError>,
) =>
  makeFirstPartyProviderRuntime({
    providers: [ollama],
    settings: {
      read: (_providerId, key) =>
        Effect.die(`selected Ollama account must suppress ambient setting ${key}`),
    },
    selectedAccounts: {
      resolve: () =>
        Effect.succeed({
          id: "ollama-selected",
          secureSettings: {
            OLLAMA_COOKIE: selectedCookie,
            OLLAMA_API_KEY: null,
            OLLAMA_KEY: null,
          },
        }),
    },
    browserSessions: {
      cookieHeader: () => Effect.die("selected Ollama account must suppress browser sessions"),
    },
    credentials: {
      read: (key) => Effect.die(`selected Ollama account must suppress keyring ${key}`),
      write: () => Effect.void,
      remove: () => Effect.void,
    },
    http: {
      execute: (request) => {
        requests.push(request);
        return execute?.(request) ?? Effect.succeed(response(request));
      },
    },
    clock,
  });

describe("first-party runtime selected Ollama accounts", () => {
  const makeAmbientRuntime = (requests: HttpRequest[], apiKey: string | undefined) =>
    makeFirstPartyProviderRuntime({
      providers: [ollama],
      settings: {
        read: (_providerId, key) => Effect.succeed(key === "OLLAMA_KEY" ? apiKey : undefined),
      },
      browserSessions: {
        cookieHeader: () =>
          Effect.fail(new MissingBrowserCredentialError("Ollama browser missing")),
      },
      credentials: {
        read: () => Effect.succeed(undefined),
        write: () => Effect.void,
        remove: () => Effect.void,
      },
      http: {
        execute: (request) => {
          requests.push(request);
          return Effect.succeed(
            response(
              request,
              new URL(request.url).pathname.endsWith("/web_search")
                ? "validation reached"
                : JSON.stringify({ models: [{ name: "fixture" }] }),
            ),
          );
        },
      },
      clock,
    });

  it("reports the API strategy when Auto falls back from unavailable browser cookies", async () => {
    const requests: HttpRequest[] = [];
    const outcome = await Effect.runPromise(
      makeAmbientRuntime(requests, "legacy-api-key").fetch("ollama", {
        sourceMode: "auto",
        includeCredits: false,
      }),
    );
    expect(outcome).toMatchObject({
      strategyId: "ollama.api",
      source: "api-token",
      attempts: [
        { strategyId: "ollama.web", available: true, error: { kind: "missing-credential" } },
        { strategyId: "ollama.api", available: true },
      ],
    });
    expect(requests).toHaveLength(2);
  });

  it("preserves the web error when Auto has no API key", async () => {
    const requests: HttpRequest[] = [];
    await expect(
      Effect.runPromise(
        makeAmbientRuntime(requests, undefined).fetch("ollama", {
          sourceMode: "auto",
          includeCredits: false,
        }),
      ),
    ).rejects.toMatchObject({ kind: "missing-credential" });
    expect(requests).toHaveLength(0);
  });

  it("keeps the legacy API-key alias usable only on the explicit API strategy", async () => {
    const requests: HttpRequest[] = [];
    const runtime = makeFirstPartyProviderRuntime({
      providers: [ollama],
      settings: {
        read: (_providerId, key) =>
          Effect.succeed(key === "OLLAMA_KEY" ? "legacy-api-key" : undefined),
      },
      browserSessions: { cookieHeader: () => Effect.die("API mode must not read browser cookies") },
      credentials: {
        read: () => Effect.succeed(undefined),
        write: () => Effect.void,
        remove: () => Effect.void,
      },
      http: {
        execute: (request) => {
          requests.push(request);
          return Effect.succeed(
            response(
              request,
              new URL(request.url).pathname.endsWith("/web_search")
                ? "validation reached"
                : JSON.stringify({ models: [{ name: "fixture" }] }),
            ),
          );
        },
      },
      clock,
    });
    const outcome = await Effect.runPromise(
      runtime.fetch("ollama", { sourceMode: "api", includeCredits: false }),
    );
    expect(outcome).toMatchObject({
      strategyId: "ollama.api",
      source: "api-token",
      snapshot: { identity: { providerId: "ollama", loginMethod: "API key" } },
    });
    expect(requests).toHaveLength(2);
    expect(
      requests.every(({ headers }) => headers?.Authorization === "Bearer legacy-api-key"),
    ).toBe(true);
  });

  it.each(["auto", "web"] as const)(
    "uses only the selected web session under %s source",
    async (sourceMode) => {
      const requests: HttpRequest[] = [];
      const outcome = await Effect.runPromise(
        makeRuntime(requests).fetch("ollama", { sourceMode, includeCredits: false }),
      );
      expect(outcome).toMatchObject({
        strategyId: "ollama.web",
        source: "web",
        snapshot: {
          primary: { usedPercent: 20, windowMinutes: 300 },
          secondary: { usedPercent: 40, windowMinutes: 10_080 },
          identity: {
            providerId: "ollama",
            accountEmail: "selected@example.com",
            loginMethod: "Pro",
          },
        },
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        method: "GET",
        url: "https://ollama.com/settings",
        headers: { Cookie: selectedCookie },
      });
      expect(JSON.stringify(outcome)).not.toContain(selectedSession);
    },
  );

  it.each(["api", "cli", "oauth"] as const)(
    "keeps the selected web account terminal under %s source",
    async (sourceMode) => {
      const requests: HttpRequest[] = [];
      await expect(
        Effect.runPromise(
          makeRuntime(requests).fetch("ollama", { sourceMode, includeCredits: false }),
        ),
      ).rejects.toMatchObject({ name: "NoAvailableStrategy", providerId: "ollama" });
      expect(requests).toHaveLength(0);
    },
  );

  it("redacts the selected session from transport failures", async () => {
    const requests: HttpRequest[] = [];
    const failure = await Effect.runPromise(
      Effect.flip(
        makeRuntime(requests, () =>
          Effect.fail(
            new InfrastructureError(
              "Ollama transport",
              `request rejected cookie ${selectedCookie} token ${selectedSession}`,
            ),
          ),
        ).fetch("ollama", { sourceMode: "auto", includeCredits: false }),
      ),
    );
    expect(failure).toMatchObject({ kind: "network-failure" });
    expect(failure.message).toContain("[REDACTED]");
    expect(failure.message).not.toContain(selectedCookie);
    expect(failure.message).not.toContain(selectedSession);
  });
});
