import { describe, expect, it } from "vite-plus/test";

import {
  DoubaoApiError,
  doubao,
  doubaoPlanSnapshot,
  signDoubaoVolcengineRequest,
} from "../src/providers/doubao.ts";
import type { ProviderContext, ProviderResponse } from "../src/types.ts";

type Request = {
  readonly method: string;
  readonly url: URL;
  readonly options?: Record<string, unknown>;
};
type Scripted =
  | {
      readonly status: number;
      readonly body: unknown;
      readonly headers?: Readonly<Record<string, string>>;
    }
  | { readonly error: Error };

const signedAt = new Date("2026-06-17T00:00:00.000Z");
const emptySha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const goldenAuthorization =
  "HMAC-SHA256 Credential=AKLTTEST/20260617/cn-beijing/ark/request, SignedHeaders=content-type;host;x-content-sha256;x-date, Signature=220f360943ab513c639db31ee72aeee7fa8b915812cde28ce104d6496b0bd24d";
const codingPlanURL =
  "https://open.volcengineapi.com/?Action=GetCodingPlanUsage&Version=2024-01-01";
const agentPlanURL = "https://open.volcengineapi.com/?Action=GetAFPUsage&Version=2024-01-01";
const credentials = {
  VOLCENGINE_ACCESS_KEY_ID: "AKLTTEST",
  VOLCENGINE_SECRET_ACCESS_KEY: "secret",
  VOLCENGINE_REGION: "cn-beijing",
} as const;
const codingPlanBody = {
  Result: {
    Status: "Running",
    UpdateTimestamp: 1_782_226_444,
    QuotaUsage: [
      { Level: "session", Percent: 12.5, ResetTimestamp: 1_782_226_478 },
      { Level: "weekly", Percent: 25, ResetTimestamp: 1_782_662_400 },
      { Level: "monthly", Percent: 50, ResetTimestamp: 1_782_403_199 },
    ],
  },
};
const agentPlanBody = {
  Result: {
    PlanType: "medium",
    AFPFiveHour: { Quota: 10_000, Used: 0, ResetTime: -1 },
    AFPWeekly: { Quota: 35_000, Used: 0, ResetTime: 1_785_686_400_000 },
    AFPMonthly: { Quota: 100_000, Used: 0, ResetTime: 1_787_846_399_000 },
  },
};
const failure = (kind: string) => (message: string) => new Error(`${kind}: ${message}`);

const context = (
  scripted: Scripted[] | ((request: Request) => Scripted),
  settings: Readonly<Record<string, string>> = {},
  requests: Request[] = [],
  now = signedAt,
): ProviderContext => {
  const queue = Array.isArray(scripted) ? [...scripted] : undefined;
  const request = async (method: string, url: string, options?: Record<string, unknown>) => {
    const entry: Request = { method, url: new URL(url), ...(options ? { options } : {}) };
    requests.push(entry);
    const next = typeof scripted === "function" ? scripted(entry) : queue?.shift();
    if (next === undefined) throw new Error("unexpected Doubao request");
    if ("error" in next) throw next.error;
    const bodyText = typeof next.body === "string" ? next.body : JSON.stringify(next.body);
    const response: ProviderResponse = {
      status: next.status,
      bodyText,
      ...(next.headers === undefined ? {} : { headers: next.headers }),
    };
    try {
      return { ...response, json: JSON.parse(bodyText) as unknown };
    } catch {
      throw new Error("parse-failure: Provider response was not valid JSON");
    }
  };
  return {
    settings: { get: (key) => settings[key], getSecret: (key) => settings[key] },
    http: {
      get: (url, options) => request("GET", url, options),
      getJSON: (url, options) => request("GET", url, options),
      postJSON: (url, options) => request("POST", url, options),
    },
    browser: { cookieHeader: async () => "" },
    env: {},
    date: {
      now: () => new Date(now),
      nowMillis: () => now.getTime(),
      iso: (value) => new Date(value).toISOString(),
      unixSeconds: (value) => new Date(value * 1_000).toISOString(),
      unixMillis: (value) => new Date(value).toISOString(),
      nextDailyReset: () => "2026-06-18T00:00:00.000Z",
    },
    format: {
      number: String,
      usd: (value) => `$${value}`,
      monthDay: (value) => value.toISOString().slice(5, 10),
    },
    pct: (used, limit) => (limit > 0 ? (used / limit) * 100 : 100),
    amountFromPercent: (used, limit) => (used / 100) * limit,
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

describe("Doubao signed Volcengine API parity", () => {
  it("declares both Volcengine origins and a fail-closed API strategy without CLI discovery", () => {
    expect(doubao.descriptor.id).toBe("doubao");
    expect(doubao.id).toBe("doubao.api");
    expect(doubao.kind).toBe("api");
    expect(doubao.fallbackOn).toBeUndefined();
    expect(doubao.strategies).toBeUndefined();
    expect(doubao.descriptor.endpoints).toEqual([
      "https://ark.cn-beijing.volces.com",
      "https://open.volcengineapi.com",
    ]);
    expect(doubao.descriptor.auth).toBeUndefined();
  });

  it("signs empty-body GetCodingPlanUsage with sorted Volcengine headers at a fixed time", async () => {
    const headers = await signDoubaoVolcengineRequest({
      url: codingPlanURL,
      accessKeyID: "AKLTTEST",
      secretAccessKey: "secret",
      region: "cn-beijing",
      date: signedAt,
    });
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded; charset=utf-8");
    expect(headers.Host).toBe("open.volcengineapi.com");
    expect(headers["X-Date"]).toBe("20260617T000000Z");
    expect(headers["X-Content-Sha256"]).toBe(emptySha256);
    expect(headers.Authorization).toBe(goldenAuthorization);
    expect(headers.Authorization).toContain(
      "SignedHeaders=content-type;host;x-content-sha256;x-date",
    );
    expect(headers.Authorization).toContain("cn-beijing/ark/request");
  });

  it("maps coding plan session weekly and monthly windows and ignores missing reset sentinels", () => {
    const mapped = doubaoPlanSnapshot({
      status: "Running",
      quotas: [
        { level: "session", percent: 0.116, resetsAt: "2026-06-23T14:54:38.000Z" },
        { level: "weekly", percent: 3.182143, resetsAt: "2026-06-28T16:00:00.000Z" },
        { level: "monthly", percent: 7.5730535, resetsAt: "2026-06-25T15:59:59.000Z" },
      ],
    });
    expect(mapped).toMatchObject({
      primary: { usedPercent: 0.116, windowMinutes: 300, resetsAt: "2026-06-23T14:54:38.000Z" },
      secondary: { usedPercent: 3.182143, windowMinutes: 10_080 },
      tertiary: { usedPercent: 7.5730535, windowMinutes: 43_200 },
      identity: { loginMethod: "Running" },
    });
    expect((mapped.primary as { resetDescription?: string }).resetDescription).toBeUndefined();

    const sentinels = doubaoPlanSnapshot({
      quotas: [
        { level: "session", percent: 12.5 },
        { level: "weekly", percent: 24 },
      ],
    });
    expect(sentinels.primary).toEqual({ usedPercent: 12.5, windowMinutes: 300 });
    expect(sentinels.secondary).toEqual({ usedPercent: 24, windowMinutes: 10_080 });
  });

  it("renders agent, coding-team, and agent-team windows without claiming CLI discovery", () => {
    const snapshot = doubaoPlanSnapshot({
      quotas: [
        { level: "session", percent: 1 },
        { level: "agent_5h", percent: 3 },
        { level: "coding_team_session", percent: 2 },
        { level: "agent_team_5h", percent: 4 },
      ],
    });
    expect(snapshot.primary).toMatchObject({ usedPercent: 1, windowMinutes: 300 });
    expect(snapshot.extraRateWindows).toEqual([
      {
        id: "doubao-agent-session",
        title: "5-hour",
        window: { usedPercent: 3, windowMinutes: 300 },
      },
      {
        id: "doubao-coding-team-session",
        title: "5-hour",
        window: { usedPercent: 2, windowMinutes: 300 },
      },
      {
        id: "doubao-agent-team-session",
        title: "5-hour",
        window: { usedPercent: 4, windowMinutes: 300 },
      },
    ]);
  });

  it("fetches GetCodingPlanUsage with the golden signature and then GetAFPUsage", async () => {
    const requests: Request[] = [];
    const snapshot = await doubao.fetchUsage(
      context(
        [
          { status: 200, body: codingPlanBody },
          { status: 200, body: { Result: {} } },
        ],
        credentials,
        requests,
      ),
    );
    expect(requests.map((item) => item.url.href)).toEqual([codingPlanURL, agentPlanURL]);
    expect(requests[0]?.options).toMatchObject({
      method: "POST",
      headers: {
        Host: "open.volcengineapi.com",
        "X-Date": "20260617T000000Z",
        "X-Content-Sha256": emptySha256,
        Authorization: goldenAuthorization,
      },
    });
    expect(requests[0]?.options).not.toHaveProperty("body");
    expect(snapshot).toMatchObject({
      primary: { usedPercent: 12.5, windowMinutes: 300, resetsAt: "2026-06-23T14:54:38.000Z" },
      secondary: { usedPercent: 25, windowMinutes: 10_080 },
      tertiary: { usedPercent: 50, windowMinutes: 43_200 },
      identity: { loginMethod: "Running" },
    });
    expect(snapshot.extraRateWindows).toBeUndefined();
  });

  it("surfaces Volcengine AccessDenied without treating the body as a byte count", async () => {
    await expect(
      doubao.fetchUsage(
        context(
          [
            {
              status: 403,
              body: {
                ResponseMetadata: {
                  Action: "GetCodingPlanUsage",
                  Error: {
                    CodeN: 100013,
                    Code: "AccessDenied",
                    Message: "User is not authorized to perform: ark:GetCodingPlanUsage",
                  },
                },
              },
            },
          ],
          credentials,
        ),
      ),
    ).rejects.toEqual(
      expect.objectContaining({
        name: "api-failure",
        status: 403,
        message: expect.stringMatching(/AccessDenied.*ark:GetCodingPlanUsage/),
      }),
    );
  });

  it("maps AFP windows onto agent extras and skips the daily bucket", async () => {
    const snapshot = await doubao.fetchUsage(
      context(
        [
          {
            status: 200,
            body: { Result: { Status: "Reclaimed", UpdateTimestamp: 1_785_322_689 } },
          },
          {
            status: 200,
            body: {
              Result: {
                PlanType: "medium",
                AFPFiveHour: { Quota: 10_000, Used: 0, ResetTime: -1 },
                AFPWeekly: { Quota: 35_000, Used: 8_750, ResetTime: 1_785_686_400_000 },
                AFPMonthly: { Quota: 100_000, Used: 25_000, ResetTime: 1_787_846_399_000 },
                AFPDaily: { Quota: 50_000, Used: 0, ResetTime: 1_785_340_800_000 },
              },
            },
          },
        ],
        credentials,
      ),
    );
    expect(snapshot.primary).toBeUndefined();
    expect(snapshot.extraRateWindows).toEqual([
      {
        id: "doubao-agent-session",
        title: "5-hour",
        window: { usedPercent: 0, windowMinutes: 300 },
      },
      {
        id: "doubao-agent-weekly",
        title: "Weekly",
        window: { usedPercent: 25, windowMinutes: 10_080, resetsAt: "2026-08-02T16:00:00.000Z" },
      },
      {
        id: "doubao-agent-monthly",
        title: "Monthly",
        window: { usedPercent: 25, windowMinutes: 43_200, resetsAt: "2026-08-27T15:59:59.000Z" },
      },
    ]);
  });

  it("merges coding and agent windows when both plans are active", async () => {
    const snapshot = await doubao.fetchUsage(
      context(
        [
          { status: 200, body: codingPlanBody },
          { status: 200, body: agentPlanBody },
        ],
        credentials,
      ),
    );
    expect(snapshot.primary).toMatchObject({ usedPercent: 12.5 });
    expect((snapshot.extraRateWindows as Array<{ id: string }>).map((window) => window.id)).toEqual(
      ["doubao-agent-session", "doubao-agent-weekly", "doubao-agent-monthly"],
    );
  });

  it("treats agent-plan 403 as absence and preserves coding plan windows", async () => {
    const snapshot = await doubao.fetchUsage(
      context(
        [
          { status: 200, body: codingPlanBody },
          {
            status: 403,
            body: {
              ResponseMetadata: { Error: { Code: "AccessDenied", Message: "not authorized" } },
            },
          },
        ],
        credentials,
      ),
    );
    expect(snapshot.primary).toMatchObject({ usedPercent: 12.5 });
    expect(snapshot.extraRateWindows).toBeUndefined();
  });

  it("surfaces a malformed agent response when no coding quotas exist", async () => {
    await expect(
      doubao.fetchUsage(
        context(
          [
            { status: 200, body: { Result: { Status: "Reclaimed" } } },
            { status: 200, body: { Result: null } },
          ],
          credentials,
        ),
      ),
    ).rejects.toThrow("parse-failure:");
  });

  it("preserves coding plan windows when the agent probe fails in transit", async () => {
    const snapshot = await doubao.fetchUsage(
      context(
        [{ status: 200, body: codingPlanBody }, { error: new Error("timed out") }],
        credentials,
      ),
    );
    expect(snapshot.primary).toMatchObject({ usedPercent: 12.5 });
    expect(snapshot.extraRateWindows).toBeUndefined();
  });

  it("surfaces agent transport failure when no plan result is available", async () => {
    await expect(
      doubao.fetchUsage(
        context(
          [
            { status: 200, body: { Result: { Status: "Reclaimed" } } },
            { error: new Error("timed out") },
          ],
          credentials,
        ),
      ),
    ).rejects.toThrow("network-failure:");
  });

  it("propagates cancellation after an active coding plan and does not fall back to Ark", async () => {
    const requests: Request[] = [];
    const abort = new DOMException("cancelled", "AbortError");
    await expect(
      doubao.fetchUsage(
        context(
          [{ status: 200, body: codingPlanBody }, { error: abort }],
          { ...credentials, ARK_API_KEY: "ark-env" },
          requests,
        ),
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(requests.map((item) => item.url.host)).toEqual([
      "open.volcengineapi.com",
      "open.volcengineapi.com",
    ]);
  });

  it("uses AK/SK signed credentials and does not probe Ark when signing succeeds", async () => {
    const requests: Request[] = [];
    await doubao.fetchUsage(
      context(
        [
          { status: 200, body: codingPlanBody },
          { status: 200, body: { Result: {} } },
        ],
        { ...credentials, ARK_API_KEY: "ark-env" },
        requests,
      ),
    );
    expect(requests.every((item) => item.url.host === "open.volcengineapi.com")).toBe(true);
  });

  it("falls back to the Ark bearer probe only after a non-cancellation signed failure", async () => {
    const requests: Request[] = [];
    const snapshot = await doubao.fetchUsage(
      context(
        [
          {
            status: 403,
            body: { ResponseMetadata: { Error: { Code: "AccessDenied", Message: "no" } } },
          },
          { status: 200, body: { usage: { total_tokens: 1 } } },
        ],
        { ...credentials, ARK_API_KEY: "ark-env" },
        requests,
      ),
    );
    expect(requests.map((item) => item.url.host)).toEqual([
      "open.volcengineapi.com",
      "ark.cn-beijing.volces.com",
    ]);
    expect(snapshot).toEqual({ identity: {} });
  });

  it("uses the Ark key probe when no AK/SK pair is configured", async () => {
    const requests: Request[] = [];
    const snapshot = await doubao.fetchUsage(
      context(
        [
          {
            status: 200,
            body: { usage: { total_tokens: 1 } },
            headers: {
              "x-ratelimit-limit-requests": "10",
              "x-ratelimit-remaining-requests": "7",
            },
          },
        ],
        { ARK_API_KEY: "ark-env" },
        requests,
      ),
    );
    expect(requests[0]?.url.pathname).toBe("/api/coding/v3/chat/completions");
    expect(requests[0]?.options).toMatchObject({
      headers: { Authorization: "Bearer ark-env" },
      body: { model: "doubao-seed-2.0-code", max_tokens: 1 },
    });
    expect(snapshot).toEqual({
      primary: { usedPercent: 30, resetDescription: "3/10 requests" },
      identity: {},
    });
  });

  it("rejects malformed integer rate-limit headers instead of inventing a window", async () => {
    const snapshot = await doubao.fetchUsage(
      context(
        [
          {
            status: 200,
            body: { usage: { total_tokens: 1 } },
            headers: {
              "x-ratelimit-limit-requests": "10.5",
              "x-ratelimit-remaining-requests": "7requests",
            },
          },
        ],
        { ARK_API_KEY: "ark-env" },
      ),
    );
    expect(snapshot).toEqual({ identity: {} });
  });

  it("surfaces the signed error when no Ark API key is available", async () => {
    await expect(
      doubao.fetchUsage(
        context(
          [
            {
              status: 403,
              body: {
                ResponseMetadata: { Error: { Code: "SignatureExpired", Message: "expired" } },
              },
            },
          ],
          credentials,
        ),
      ),
    ).rejects.toBeInstanceOf(DoubaoApiError);
  });

  it("does not fall through to ambient CLI when API credentials are configured", async () => {
    await expect(
      doubao.fetchUsage(context([], { ARK_API_KEY: "ark-configured-account" })),
    ).rejects.toThrow("unexpected Doubao request");
    await expect(doubao.fetchUsage(context([]))).rejects.toThrow("missing-credential:");
  });

  it("omits unknown request-limit windows and treats double zero-remaining as unreliable", async () => {
    const omitted = await doubao.fetchUsage(
      context([{ status: 200, body: { usage: { total_tokens: 1 } } }], { ARK_API_KEY: "key" }),
    );
    expect(omitted).toEqual({ identity: {} });

    const unreliable = await doubao.fetchUsage(
      context(
        [
          {
            status: 200,
            body: {},
            headers: {
              "x-ratelimit-limit-requests": "1000",
              "x-ratelimit-remaining-requests": "0",
            },
          },
          {
            status: 200,
            body: {},
            headers: {
              "x-ratelimit-limit-requests": "1000",
              "x-ratelimit-remaining-requests": "0",
            },
          },
        ],
        { ARK_API_KEY: "key" },
      ),
    );
    expect(unreliable).toEqual({ identity: {} });

    const exhausted = await doubao.fetchUsage(
      context(
        [
          {
            status: 429,
            body: {},
            headers: {
              "x-ratelimit-limit-requests": "1000",
              "x-ratelimit-remaining-requests": "0",
            },
          },
        ],
        { ARK_API_KEY: "key" },
      ),
    );
    expect(exhausted.primary).toEqual({ usedPercent: 100, resetDescription: "1000/1000 requests" });

    const bare = await doubao.fetchUsage(
      context([{ status: 429, body: {} }], { ARK_API_KEY: "key" }),
    );
    expect(bare).toEqual({ identity: {} });
  });
});
