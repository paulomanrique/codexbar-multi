import { describe, expect, it } from "vite-plus/test";

import { azureopenai } from "../src/providers/azureopenai.ts";
import { gemini } from "../src/providers/gemini.ts";
import { vertexai } from "../src/providers/vertexai.ts";
import type { ProviderContext, ProviderResponse } from "../src/types.ts";

const now = new Date("2026-08-20T12:00:00.000Z");
type Request = {
  readonly method: "GET" | "POST";
  readonly url: URL;
  readonly options?: Record<string, unknown>;
};
type Fixture = (request: Request) => ProviderResponse;

const error = (kind: string) => (message: string) => new Error(`${kind}: ${message}`);

function context(
  fixture: Fixture,
  settings: Readonly<Record<string, string>>,
  requests: Request[] = [],
): ProviderContext {
  const request = async (
    method: Request["method"],
    url: string,
    options?: Record<string, unknown>,
  ) => {
    const result = { method, url: new URL(url), ...(options === undefined ? {} : { options }) };
    requests.push(result);
    return fixture(result);
  };
  return {
    settings: { get: (key) => settings[key], getSecret: (key) => settings[key] },
    http: {
      get: (url, options) => request("GET", url, options),
      getJSON: async (url, options) => {
        const response = await request("GET", url, options);
        return { ...response, json: JSON.parse(response.bodyText) as unknown };
      },
      postJSON: async (url, options) => {
        const response = await request("POST", url, options);
        return { ...response, json: JSON.parse(response.bodyText) as unknown };
      },
    },
    browser: { cookieHeader: async () => "" },
    env: {},
    date: {
      now: () => now,
      nowMillis: () => now.getTime(),
      iso: (value) => new Date(value).toISOString(),
      unixSeconds: (value) => new Date(value * 1_000).toISOString(),
      unixMillis: (value) => new Date(value).toISOString(),
      nextDailyReset: () => "2026-08-21T00:00:00.000Z",
    },
    format: {
      number: (value) => String(value),
      usd: (value) => `$${value}`,
      monthDay: () => "Aug 20",
    },
    pct: (used, limit) => (limit > 0 ? (used / limit) * 100 : 100),
    amountFromPercent: (usedPercent, limit) => (usedPercent / 100) * limit,
    fail: {
      authenticationExpired: error("authentication-expired"),
      missingCredential: error("missing-credential"),
      permissionDenied: error("permission-denied"),
      rateLimited: error("rate-limited"),
      providerUnavailable: error("provider-unavailable"),
      parseFailure: error("parse-failure"),
      networkFailure: error("network-failure"),
      apiFailure: error("api-failure"),
    },
  };
}

const json = (body: unknown, responseStatus = 200): ProviderResponse => ({
  status: responseStatus,
  bodyText: JSON.stringify(body),
});

const idToken = (payload: unknown) =>
  `header.${btoa(JSON.stringify(payload)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=/gu, "")}.signature`;

const monitoring = (quotaMetric: string, limitName: string, location: string, amount: number) => ({
  timeSeries: [
    {
      metric: {
        labels: { quota_metric: quotaMetric, ...(limitName ? { limit_name: limitName } : {}) },
      },
      resource: { labels: { location, service: "aiplatform.googleapis.com" } },
      points: [{ value: { int64Value: String(amount) } }],
    },
  ],
});

describe("Swift-derived Azure OpenAI, Gemini, and Vertex AI parity", () => {
  it("keeps cloud provider descriptor and strategy IDs aligned with upstream", () => {
    expect([azureopenai, gemini, vertexai].map((provider) => provider.descriptor.id)).toEqual([
      "azureopenai",
      "gemini",
      "vertexai",
    ]);
    expect([azureopenai, gemini, vertexai].map((provider) => provider.id)).toEqual([
      "azureopenai.api",
      "gemini.api",
      "vertexai.oauth",
    ]);
  });

  it("matches Azure deployment validation paths, v1 payloads, endpoint paths and identity", async () => {
    const requests: Request[] = [];
    const snapshot = await azureopenai.fetchUsage(
      context(
        () => json({ id: "cmpl-1", model: "gpt-4o-mini" }),
        {
          AZURE_OPENAI_API_KEY: "  azure-key  ",
          AZURE_OPENAI_ENDPOINT: " 'https://proxy.example.com/base/openai' ",
          AZURE_OPENAI_DEPLOYMENT_NAME: " chat prod ",
        },
        requests,
      ),
    );
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.url.href).toBe(
      "https://proxy.example.com/base/openai/deployments/chat%20prod/chat/completions?api-version=2024-10-21",
    );
    expect(requests[0]?.options).toMatchObject({
      headers: {
        "api-key": "azure-key",
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: { messages: [{ role: "user", content: "ping" }], max_tokens: 1 },
    });
    expect(snapshot).toEqual({
      primary: { usedPercent: 0, resetDescription: "Deployment: chat prod · Model: gpt-4o-mini" },
      identity: { organization: "proxy.example.com", loginMethod: "Deployment: chat prod" },
    });

    const v1 = await azureopenai.fetchUsage(
      context(
        () => json({ model: "gpt-4o-mini" }),
        {
          AZURE_OPENAI_API_KEY: "azure-key",
          AZURE_OPENAI_ENDPOINT: "https://proxy.example.com/base/openai/v1",
          AZURE_OPENAI_DEPLOYMENT_NAME: "chat-prod",
          AZURE_OPENAI_API_VERSION: "v1",
        },
        requests,
      ),
    );
    expect(requests[1]?.url.href).toBe("https://proxy.example.com/base/openai/v1/chat/completions");
    expect(requests[1]?.options).toMatchObject({
      body: {
        messages: [{ role: "user", content: "ping" }],
        model: "chat-prod",
        max_completion_tokens: 64,
      },
    });
    expect(v1.primary).toMatchObject({ usedPercent: 0 });
  });

  it("rejects Azure insecure endpoints before issuing a request", async () => {
    await expect(
      azureopenai.fetchUsage(
        context(() => json({}), {
          AZURE_OPENAI_API_KEY: "fixture",
          AZURE_OPENAI_ENDPOINT: "http://127.0.0.1:31337",
          AZURE_OPENAI_DEPLOYMENT_NAME: "chat",
        }),
      ),
    ).rejects.toThrow("api-failure: AZURE_OPENAI_ENDPOINT must be an HTTPS endpoint.");
  });

  it("matches Gemini Code Assist project selection, tier resolution and lowest quota per model/tier", async () => {
    const requests: Request[] = [];
    const snapshot = await gemini.fetchUsage(
      context(
        (request) => {
          if (request.url.pathname.endsWith("loadCodeAssist")) {
            return json({
              currentTier: { id: "free-tier" },
              paidTier: { name: "Gemini Code Assist in Google One AI Pro" },
              cloudaicompanionProject: { projectId: "cloud-project" },
            });
          }
          if (request.url.pathname.endsWith("retrieveUserQuota")) {
            return json({
              buckets: [
                {
                  modelId: "gemini-2.5-pro",
                  remainingFraction: 0.6,
                  resetTime: "2026-08-20T15:20:00Z",
                },
                {
                  modelId: "gemini-2.5-flash",
                  remainingFraction: 0.9,
                  resetTime: "2026-08-20T14:00:00Z",
                },
                {
                  modelId: "gemini-2.5-flash",
                  remainingFraction: 0.4,
                  resetTime: "2026-08-20T13:00:00Z",
                },
                {
                  modelId: "gemini-2.5-flash-lite",
                  remainingFraction: 0.8,
                  resetTime: "2026-08-20T13:40:00Z",
                },
              ],
            });
          }
          throw new Error(`Unexpected URL ${request.url}`);
        },
        {
          GEMINI_ACCESS_TOKEN: "fixture-token",
          GEMINI_ID_TOKEN: idToken({ email: "user@example.com", hd: "example.com" }),
        },
        requests,
      ),
    );
    expect(requests.map((request) => request.url.hostname)).toEqual([
      "cloudcode-pa.googleapis.com",
      "cloudcode-pa.googleapis.com",
    ]);
    expect(requests[1]?.options).toMatchObject({ body: { project: "cloud-project" } });
    expect(snapshot).toEqual({
      primary: {
        usedPercent: 40,
        windowMinutes: 1440,
        resetsAt: "2026-08-20T15:20:00.000Z",
        resetDescription: "Resets in 3h 20m",
      },
      secondary: {
        usedPercent: 60,
        windowMinutes: 1440,
        resetsAt: "2026-08-20T13:00:00.000Z",
        resetDescription: "Resets in 1h 0m",
      },
      tertiary: {
        usedPercent: 20,
        windowMinutes: 1440,
        resetsAt: "2026-08-20T13:40:00.000Z",
        resetDescription: "Resets in 1h 40m",
      },
      identity: {
        email: "user@example.com",
        loginMethod: "Gemini Code Assist in Google One AI Pro",
      },
    });
  });

  it("uses a discovered Gemini API project only when Code Assist did not provide one", async () => {
    const requests: Request[] = [];
    await gemini.fetchUsage(
      context(
        (request) => {
          if (
            request.url.hostname === "cloudcode-pa.googleapis.com" &&
            request.url.pathname.endsWith("loadCodeAssist")
          ) {
            return json({ currentTier: { id: "free-tier" } });
          }
          if (request.url.hostname === "cloudresourcemanager.googleapis.com") {
            return json({
              projects: [{ projectId: "unrelated" }, { projectId: "gen-lang-client-123" }],
            });
          }
          return json({ buckets: [{ modelId: "gemini-2.5-pro", remainingFraction: 1 }] });
        },
        { GEMINI_ACCESS_TOKEN: "fixture-token" },
        requests,
      ),
    );
    expect(requests.map((request) => request.url.hostname)).toEqual([
      "cloudcode-pa.googleapis.com",
      "cloudresourcemanager.googleapis.com",
      "cloudcode-pa.googleapis.com",
    ]);
    expect(requests[2]?.options).toMatchObject({ body: { project: "gen-lang-client-123" } });
  });

  it("turns Gemini consumer-tier deprecation into the migration failure rather than a generic 403", async () => {
    await expect(
      gemini.fetchUsage(
        context(
          () =>
            json(
              {
                error: {
                  message:
                    "IneligibleTierError / UNSUPPORTED_CLIENT: migrate to Antigravity for Gemini",
                },
              },
              403,
            ),
          { GEMINI_ACCESS_TOKEN: "fixture-token" },
        ),
      ),
    ).rejects.toThrow("Gemini CLI consumer tier is no longer supported");
  });

  it("matches Vertex Monitoring pagination and unnamed-regional quota matching while preserving the upstream identity-only snapshot", async () => {
    const requests: Request[] = [];
    const snapshot = await vertexai.fetchUsage(
      context(
        (request) => {
          const limit = request.url.searchParams.get("filter")?.includes("quota/limit") === true;
          const page = request.url.searchParams.get("pageToken");
          if (!limit && !page) {
            return json({
              ...monitoring(
                "aiplatform.googleapis.com/reasoning_engine_service_entities",
                "",
                "us-west1",
                1,
              ),
              nextPageToken: "usage-page-2",
            });
          }
          if (!limit && page === "usage-page-2") return json({ timeSeries: [] });
          return json(
            monitoring(
              "aiplatform.googleapis.com/reasoning_engine_service_entities",
              "ReasoningEngineEntitiesPerProjectPerRegion",
              "us-west1",
              10,
            ),
          );
        },
        {
          VERTEX_AI_ACCESS_TOKEN: "fixture-token",
          VERTEX_AI_PROJECT_ID: "redacted-project",
          VERTEX_AI_ACCOUNT_EMAIL: "vertex@example.com",
        },
        requests,
      ),
    );
    expect(requests).toHaveLength(3);
    expect(
      requests.every(
        (request) => request.url.pathname === "/v3/projects/redacted-project/timeSeries",
      ),
    ).toBe(true);
    expect(requests[0]?.url.searchParams.get("aggregation.perSeriesAligner")).toBe("ALIGN_MAX");
    expect(
      requests.some((request) => request.url.searchParams.get("pageToken") === "usage-page-2"),
    ).toBe(true);
    expect(snapshot).toEqual({
      identity: {
        email: "vertex@example.com",
        organization: "redacted-project",
        loginMethod: "gcloud",
      },
    });
  });

  it("keeps Vertex no-data quota measurements non-fatal but rejects missing project configuration", async () => {
    const snapshot = await vertexai.fetchUsage(
      context(() => json({ timeSeries: [] }), {
        VERTEX_AI_ACCESS_TOKEN: "fixture-token",
        VERTEX_AI_PROJECT_ID: "redacted-project",
      }),
    );
    expect(snapshot).toEqual({
      identity: { organization: "redacted-project", loginMethod: "gcloud" },
    });
    await expect(
      vertexai.fetchUsage(context(() => json({}), { VERTEX_AI_ACCESS_TOKEN: "fixture-token" })),
    ).rejects.toThrow("No Google Cloud project configured");
  });
});
