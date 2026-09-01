import { describe, expect, it } from "vite-plus/test";

import {
  GROQ_STYTCH_DEFAULT_PUBLIC_TOKEN,
  groqConsoleEnvironmentSession,
  groqConsoleStytchSDKClientHeader,
  refreshGroqConsoleSessionJWT,
  resolveGroqConsoleJWT,
  resolveGroqConsoleStytchEndpoint,
} from "../src/providers/groq-console-stytch.ts";
import type { ProviderContext, ProviderResponse } from "../src/types.ts";

type Request = {
  readonly url: URL;
  readonly options?: Record<string, unknown>;
};

const failure = (kind: string) => (message: string) => {
  const error = new Error(`${kind}: ${message}`);
  Object.defineProperty(error, "kind", { value: kind, enumerable: true });
  return error;
};

const context = (
  fixture: (request: Request) => ProviderResponse | Promise<ProviderResponse>,
  options: {
    readonly settings?: Readonly<Record<string, string>>;
    readonly requests?: Request[];
  } = {},
): ProviderContext => {
  const settings = options.settings ?? {};
  return {
    settings: {
      get: (key) => settings[key],
      getSecret: (key) => settings[key],
    },
    http: {
      get: async () => {
        throw new Error("unused");
      },
      post: async (url, requestOptions) => {
        const request: Request = {
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
      now: () => new Date("2026-08-26T00:00:00.000Z"),
      nowMillis: () => Date.parse("2026-08-26T00:00:00.000Z"),
      iso: (value) => new Date(value).toISOString(),
      unixSeconds: (value) => new Date(value * 1_000).toISOString(),
      unixMillis: (value) => new Date(value).toISOString(),
      nextDailyReset: () => "2026-08-27T00:00:00.000Z",
    },
    format: {
      number: (value) => new Intl.NumberFormat("en-US").format(value),
      usd: (value) =>
        new Intl.NumberFormat("en-US", { currency: "USD", style: "currency" }).format(value),
      monthDay: (value) =>
        new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(value),
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
};

const json = (body: unknown, status = 200): ProviderResponse => ({
  status,
  bodyText: JSON.stringify(body),
});

describe("Groq console Stytch parity", () => {
  it("posts the Swift-compatible Stytch authenticate request", async () => {
    const requests: Request[] = [];
    const ctx = context(() => json({ data: { session_jwt: " jwt-refreshed " } }), { requests });

    await expect(refreshGroqConsoleSessionJWT(ctx, " session-token ")).resolves.toBe(
      "jwt-refreshed",
    );

    const request = requests[0];
    expect(request?.url.href).toBe(
      "https://api.stytchb2b.groq.com/sdk/v1/b2b/sessions/authenticate",
    );
    expect(request?.options?.timeoutSeconds).toBe(20);
    expect(request?.options?.body).toBe(
      JSON.stringify({
        session_token: "session-token",
        session_duration_minutes: 30,
      }),
    );
    const headers = request?.options?.headers as Readonly<Record<string, string>>;
    expect(headers.Authorization).toBe(
      `Basic ${btoa(`${GROQ_STYTCH_DEFAULT_PUBLIC_TOKEN}:session-token`)}`,
    );
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Origin).toBe("https://console.groq.com");
    expect(headers["X-SDK-Parent-Host"]).toBe("https://console.groq.com");
    const sdkClient = headers["X-SDK-Client"];
    expect(sdkClient).toBeDefined();
    expect(atob(sdkClient ?? "")).toBe(
      JSON.stringify({
        app: { identifier: "console.groq.com" },
        sdk: { identifier: "Stytch.js Javascript SDK", version: "5.43.0" },
      }),
    );
  });

  it("uses exact public-token and base-URL overrides after HTTPS validation", async () => {
    const requests: Request[] = [];
    const ctx = context(() => json({ data: { session_jwt: "jwt" } }), {
      requests,
      settings: {
        GROQ_STYTCH_PUBLIC_TOKEN: " override-public ",
        GROQ_STYTCH_URL: "https://stytch.example.test/base/",
      },
    });

    await expect(refreshGroqConsoleSessionJWT(ctx, "opaque")).resolves.toBe("jwt");

    expect(requests[0]?.url.href).toBe(
      "https://stytch.example.test/base/sdk/v1/b2b/sessions/authenticate",
    );
    const headers = requests[0]?.options?.headers as Readonly<Record<string, string>>;
    expect(headers.Authorization).toBe(`Basic ${btoa("override-public:opaque")}`);
  });

  it.each([
    "http://api.stytchb2b.groq.com",
    "https://user:pass@api.stytchb2b.groq.com",
    "https://api.stytchb2b.groq.com?x=1",
    "https://api.stytchb2b.groq.com#frag",
  ])("hardens invalid Stytch URL override %s", async (baseURL) => {
    await expect(
      refreshGroqConsoleSessionJWT(
        context(() => json({ data: { session_jwt: "unused" } }), {
          settings: { GROQ_STYTCH_URL: baseURL },
        }),
        "opaque",
      ),
    ).rejects.toThrow("api-failure:");
  });

  it("accepts any 2xx response with strict data.session_jwt JSON", async () => {
    await expect(
      refreshGroqConsoleSessionJWT(
        context(() => ({
          status: 204,
          bodyText: JSON.stringify({ data: { session_jwt: "jwt204" } }),
        })),
        "opaque",
      ),
    ).resolves.toBe("jwt204");
  });

  it.each([
    [401, "authentication-expired: Groq Stytch authentication failed: denied"],
    [403, "authentication-expired: Groq Stytch authentication failed: denied"],
    [500, "api-failure: Groq Stytch API returned HTTP 500: denied"],
  ])("classifies Stytch HTTP %s", async (status, message) => {
    await expect(
      refreshGroqConsoleSessionJWT(
        context(() => ({ status, bodyText: " denied\n" })),
        "opaque",
      ),
    ).rejects.toThrow(message);
  });

  it.each([
    ["{", "parse-failure: Groq Stytch response was not valid JSON."],
    [
      JSON.stringify({ session_jwt: "direct" }),
      "parse-failure: Groq Stytch response missing data.",
    ],
    [
      JSON.stringify({ data: { session_jwt: "" } }),
      "parse-failure: Groq Stytch response missing session_jwt.",
    ],
  ])("rejects malformed Stytch JSON %#", async (bodyText, message) => {
    await expect(
      refreshGroqConsoleSessionJWT(
        context(() => ({ status: 200, bodyText })),
        "opaque",
      ),
    ).rejects.toThrow(message);
  });

  it("prefers refreshing the long session token before falling back to direct JWT", async () => {
    const requests: Request[] = [];
    await expect(
      resolveGroqConsoleJWT(
        context(() => json({ data: { session_jwt: "fresh" } }), { requests }),
        { sessionToken: "opaque", directJWT: "direct", sourceLabel: "manual" },
      ),
    ).resolves.toBe("fresh");
    expect(requests).toHaveLength(1);
  });

  it("falls back to direct JWT only after a non-cancellation refresh failure", async () => {
    await expect(
      resolveGroqConsoleJWT(
        context(() => ({ status: 500, bodyText: "temporary" })),
        { sessionToken: "opaque", directJWT: "direct", sourceLabel: "manual" },
      ),
    ).resolves.toBe("direct");
  });

  it("preserves AbortError without falling back to direct JWT", async () => {
    const aborted = new Error("cancelled");
    aborted.name = "AbortError";

    await expect(
      resolveGroqConsoleJWT(
        context(() => {
          throw aborted;
        }),
        { sessionToken: "opaque", directJWT: "direct", sourceLabel: "manual" },
      ),
    ).rejects.toBe(aborted);
  });

  it("uses the direct JWT when there is no long session token", async () => {
    await expect(
      resolveGroqConsoleJWT(
        context(() => json({ data: { session_jwt: "unused" } })),
        {
          directJWT: " direct ",
          sourceLabel: "manual",
        },
      ),
    ).resolves.toBe("direct");
  });

  it("matches Swift environment-session precedence", () => {
    expect(
      groqConsoleEnvironmentSession(
        context(() => json({}), {
          settings: {
            GROQ_SESSION_TOKEN: " opaque ",
            GROQ_SESSION_JWT: " direct ",
          },
        }),
      ),
    ).toEqual({ sessionToken: "opaque", directJWT: "direct", sourceLabel: "env" });
    expect(
      groqConsoleEnvironmentSession(
        context(() => json({}), { settings: { GROQ_SESSION_JWT: " direct " } }),
      ),
    ).toEqual({ directJWT: "direct", sourceLabel: "env" });
  });

  it("exposes deterministic URL and SDK header helpers", () => {
    expect(resolveGroqConsoleStytchEndpoint("https://stytch.example.test").href).toBe(
      "https://stytch.example.test/sdk/v1/b2b/sessions/authenticate",
    );
    expect(atob(groqConsoleStytchSDKClientHeader())).toBe(
      JSON.stringify({
        app: { identifier: "console.groq.com" },
        sdk: { identifier: "Stytch.js Javascript SDK", version: "5.43.0" },
      }),
    );
  });
});
