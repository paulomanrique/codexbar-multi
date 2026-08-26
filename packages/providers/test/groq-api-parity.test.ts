import { describe, expect, it } from "vite-plus/test";

import {
  groq,
  GroqPrometheusAPIError,
  InvalidGroqPrometheusScalar,
  parseGroqPrometheusScalar,
  resolveGroqAPIKey,
  resolveGroqMetricsEndpoint,
  resolveGroqMetricsQueryURL,
} from "../src/providers/groq.ts";
import type { ProviderContext, ProviderResponse } from "../src/types.ts";

const now = new Date("2026-08-20T12:00:00.000Z");

type Request = {
  readonly method: "GET";
  readonly url: URL;
  readonly options?: Record<string, unknown>;
};

const failure = (kind: string) => (message: string) => new Error(`${kind}: ${message}`);

function context(
  fixture: (request: Request) => ProviderResponse | Promise<ProviderResponse>,
  options: {
    readonly settings?: Readonly<Record<string, string>>;
    readonly requests?: Request[];
  } = {},
): ProviderContext {
  const settings = options.settings ?? {};
  return {
    settings: {
      get: (key) => settings[key],
      getSecret: (key) => settings[key],
    },
    http: {
      get: async (url, requestOptions) => {
        const request: Request = {
          method: "GET",
          url: new URL(url),
          ...(requestOptions === undefined ? {} : { options: requestOptions }),
        };
        options.requests?.push(request);
        return fixture(request);
      },
      getJSON: async () => {
        throw new Error("unused");
      },
      postJSON: async () => {
        throw new Error("unused");
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
      number: (value) => new Intl.NumberFormat("en-US").format(value),
      usd: (value) =>
        new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value),
      monthDay: (value) =>
        new Intl.DateTimeFormat("en-US", {
          month: "short",
          day: "numeric",
          timeZone: "UTC",
        }).format(value),
    },
    pct: (used, limit) => (used / limit) * 100,
    amountFromPercent: (usedPercent, limit) => (usedPercent / 100) * limit,
    fail: {
      authenticationExpired: failure("authentication-expired"),
      missingCredential: failure("missing-credential"),
      permissionDenied: failure("permission-denied"),
      rateLimited: failure("rate-limited"),
      providerUnavailable: failure("provider-unavailable"),
      parseFailure: failure("parse-failure"),
      networkFailure: failure("network-failure"),
      apiFailure: failure("api-failure"),
    },
  };
}

const json = (body: unknown, status = 200): ProviderResponse => ({
  status,
  bodyText: JSON.stringify(body),
});

describe("Groq Prometheus API parity", () => {
  it("exposes Swift-compatible key cleanup and endpoint normalization helpers", () => {
    const ctx = context(() => json({ status: "success", data: { result: [] } }), {
      settings: {
        GROQ_API_KEY: "  'fixture-key'  ",
        GROQ_API_URL: "groq.example.test/v1/",
      },
    });

    expect(resolveGroqAPIKey(ctx)).toBe("fixture-key");
    expect(resolveGroqMetricsEndpoint(ctx)?.href).toBe("https://groq.example.test/v1/");
  });

  it("builds query URLs with the Prometheus query characters left literal like Swift URLComponents", () => {
    const url = resolveGroqMetricsQueryURL(
      new URL("https://api.groq.com/v1/"),
      "sum(model_project_id_status_code:requests:rate5m)",
    );

    expect(url).toBe(
      "https://api.groq.com/v1/metrics/prometheus/api/v1/query?query=sum(model_project_id_status_code:requests:rate5m)",
    );
  });

  it("parses Prometheus scalars using the last value entry from each series", () => {
    expect(
      parseGroqPrometheusScalar({
        status: "success",
        data: {
          result: [
            { value: [1710000000, "1.5", "2.5"] },
            { value: [1710000000, 3] },
            { value: [1710000000, "not-a-number"] },
            { value: [1710000000, ""] },
            { value: [1710000000, " "] },
            { value: null },
          ],
        },
      }),
    ).toBe(5.5);
  });

  it("keeps Swift optional-data behavior but rejects malformed declared data", () => {
    expect(parseGroqPrometheusScalar({ status: "success" })).toBe(0);
    expect(parseGroqPrometheusScalar({ status: "success", data: null })).toBe(0);
    expect(() => parseGroqPrometheusScalar({ status: "success", data: {} })).toThrow(
      InvalidGroqPrometheusScalar,
    );
    expect(() =>
      parseGroqPrometheusScalar({ status: "success", data: { result: [{ value: "1" }] } }),
    ).toThrow(InvalidGroqPrometheusScalar);
    expect(() =>
      parseGroqPrometheusScalar({ status: "success", data: { result: [{ value: [{}] }] } }),
    ).toThrow(InvalidGroqPrometheusScalar);
  });

  it("treats non-success Prometheus status as an API error", () => {
    expect(() =>
      parseGroqPrometheusScalar({
        status: "error",
        error: "enterprise metrics disabled",
      }),
    ).toThrow(GroqPrometheusAPIError);
    expect(() => parseGroqPrometheusScalar({ data: { result: [] } })).toThrow(
      InvalidGroqPrometheusScalar,
    );
  });

  it("starts the four exact Swift Prometheus queries concurrently", async () => {
    const requests: Request[] = [];
    const release: Array<() => void> = [];

    const pending = groq.fetchUsage(
      context(
        async () => {
          await new Promise<void>((resolve) => {
            release.push(resolve);
          });
          return json({ status: "success", data: { result: [] } });
        },
        { settings: { GROQ_API_KEY: "fixture-key" }, requests },
      ),
    );

    while (requests.length < 4) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(requests.map(({ url }) => url.toString()).sort()).toEqual(
      [
        "https://api.groq.com/v1/metrics/prometheus/api/v1/query?query=sum(model_project_id:prompt_cache_hits:rate5m)",
        "https://api.groq.com/v1/metrics/prometheus/api/v1/query?query=sum(model_project_id:tokens_in:rate5m)",
        "https://api.groq.com/v1/metrics/prometheus/api/v1/query?query=sum(model_project_id:tokens_out:rate5m)",
        "https://api.groq.com/v1/metrics/prometheus/api/v1/query?query=sum(model_project_id_status_code:requests:rate5m)",
      ].sort(),
    );

    release.forEach((resolve) => resolve());
    await expect(pending).resolves.toMatchObject({
      primary: { resetDescription: "0.00 req/min" },
      secondary: { resetDescription: "0.00 tok/min" },
      identity: { loginMethod: "Prometheus metrics" },
    });
  });

  it.each([200, 299])("accepts any HTTP 2xx response before parsing: %s", async (status) => {
    const snapshot = await groq.fetchUsage(
      context(
        (request) =>
          json(
            {
              status: "success",
              data: {
                result: [
                  {
                    value: [
                      now.getTime() / 1_000,
                      request.url.search.includes("requests") ? "1" : "0",
                    ],
                  },
                ],
              },
            },
            status,
          ),
        { settings: { GROQ_API_KEY: "fixture-key" } },
      ),
    );

    expect(snapshot.primary).toMatchObject({ resetDescription: "60.0 req/min" });
  });

  it.each([
    [401, "authentication-expired: Groq metrics access denied: denied"],
    [403, "permission-denied: Groq metrics access denied: denied"],
    [429, "api-failure: Groq metrics API error: HTTP 429: denied"],
    [500, "api-failure: Groq metrics API error: HTTP 500: denied"],
  ])("matches Swift HTTP status classification for %s", async (status, message) => {
    await expect(
      groq.fetchUsage(
        context(() => ({ status, bodyText: " denied\n" }), {
          settings: { GROQ_API_KEY: "fixture-key" },
        }),
      ),
    ).rejects.toThrow(message);
  });

  it("maps invalid JSON and strict Prometheus JSON failures without fallback", async () => {
    await expect(
      groq.fetchUsage(
        context(() => ({ status: 200, bodyText: "{" }), {
          settings: { GROQ_API_KEY: "fixture-key" },
        }),
      ),
    ).rejects.toThrow("parse-failure: Groq response was not valid JSON.");

    await expect(
      groq.fetchUsage(
        context(() => json({ status: "success", data: { result: {} } }), {
          settings: { GROQ_API_KEY: "fixture-key" },
        }),
      ),
    ).rejects.toThrow("parse-failure: Groq metrics parse error: result must be an array.");

    await expect(
      groq.fetchUsage(
        context(() => json({ status: "error", error: "query failed upstream" }), {
          settings: { GROQ_API_KEY: "fixture-key" },
        }),
      ),
    ).rejects.toThrow("api-failure: Groq metrics API error: query failed upstream");
  });

  it("preserves transport cancellation", async () => {
    const aborted = new Error("cancelled");
    aborted.name = "AbortError";

    await expect(
      groq.fetchUsage(
        context(
          () => {
            throw aborted;
          },
          { settings: { GROQ_API_KEY: "fixture-key" } },
        ),
      ),
    ).rejects.toBe(aborted);
  });
});
