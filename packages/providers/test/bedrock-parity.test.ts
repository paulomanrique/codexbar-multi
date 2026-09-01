import { describe, expect, it } from "vite-plus/test";
import {
  bedrock,
  bedrockAuthMode,
  bedrockCloudWatchEndpoint,
  bedrockCloudWatchPartitionSuffix,
  fetchBedrockCloudWatchActivity,
  parseBedrockCloudWatchPage,
  resolveBedrockCredentials,
  signBedrockAwsRequest,
} from "../src/providers/bedrock.ts";
import type { ProviderContext, ProviderJSONResponse } from "../src/types.ts";

type Request = { readonly url: URL; readonly options?: Record<string, unknown> };

const now = new Date("2026-06-19T12:00:00.000Z");
const keys = { AWS_ACCESS_KEY_ID: "AKIATEST", AWS_SECRET_ACCESS_KEY: "testSecret" };
const response = (json: unknown, status = 200): ProviderJSONResponse => ({
  status,
  bodyText: JSON.stringify(json),
  json,
});
const fail = (kind: string) => (message: string) =>
  Object.assign(new Error(message), { name: kind });

const context = (
  fixture: (request: Request) => ProviderJSONResponse | Error,
  settings: Readonly<Record<string, string>> = {},
  requests: Request[] = [],
  local?: ProviderContext["local"],
): ProviderContext => ({
  settings: { get: (key) => settings[key], getSecret: (key) => settings[key] },
  http: {
    get: async () => response({}),
    getJSON: async () => response({}),
    postJSON: async (url, options) => {
      const request = { url: new URL(url), ...(options === undefined ? {} : { options }) };
      requests.push(request);
      const result = fixture(request);
      if (result instanceof Error) throw result;
      return result;
    },
  },
  browser: { cookieHeader: async () => "" },
  ...(local === undefined ? {} : { local }),
  env: {},
  date: {
    now: () => new Date(now),
    nowMillis: () => now.getTime(),
    iso: (value) => new Date(value).toISOString(),
    unixSeconds: (value) => new Date(value * 1_000).toISOString(),
    unixMillis: (value) => new Date(value).toISOString(),
    nextDailyReset: () => "2026-06-20T00:00:00.000Z",
  },
  format: { number: String, usd: (value) => `$${value}`, monthDay: () => "Jun 19" },
  pct: (used, limit) => (limit === 0 ? 0 : (used / limit) * 100),
  amountFromPercent: (used, limit) => (used / 100) * limit,
  fail: {
    authenticationExpired: fail("authentication-expired"),
    missingCredential: fail("missing-credential"),
    permissionDenied: fail("permission-denied"),
    rateLimited: fail("rate-limited"),
    providerUnavailable: fail("provider-unavailable"),
    parseFailure: fail("parse-failure"),
    networkFailure: fail("network-failure"),
    apiFailure: fail("api-failure"),
  },
});

const costResponse = {
  ResultsByTime: [
    {
      Groups: [
        { Keys: ["Amazon Bedrock"], Metrics: { UnblendedCost: { Amount: "12.50" } } },
        { Keys: ["Amazon EC2"], Metrics: { UnblendedCost: { Amount: "9.25" } } },
      ],
    },
  ],
};
const cloudWatchResponse = {
  MetricDataResults: [
    { Id: "inputTokens", StatusCode: "Complete", Values: [1000, 2500] },
    { Id: "outputTokens", StatusCode: "Complete", Values: [400, 600] },
    { Id: "requests", StatusCode: "Complete", Values: [7, 8] },
  ],
};

describe("Bedrock parity", () => {
  it("uses static credentials, signs Cost Explorer, and reports only Bedrock monthly cost", async () => {
    const requests: Request[] = [];
    const snapshot = await bedrock.fetchUsage(
      context(
        (request) =>
          request.url.hostname.startsWith("monitoring.")
            ? response(cloudWatchResponse)
            : response(costResponse),
        { ...keys, AWS_BEDROCK_MONTHLY_BUDGET: "50" },
        requests,
      ),
    );
    const headers = requests[0]?.options?.headers as Record<string, string>;
    expect(headers.Authorization).toContain(
      "Credential=AKIATEST/20260619/us-east-1/ce/aws4_request",
    );
    expect(snapshot).toMatchObject({
      primary: { usedPercent: 25, resetDescription: "Monthly budget" },
      cost: { used: 12.5, limit: 50, period: "Monthly" },
      identity: {
        loginMethod: "Spend: $12.50 - Budget: $50.00 - Claude 14d: 4.5K tokens - Requests: 15",
      },
    });
  });

  it("uses tomorrow as the exclusive Cost Explorer bound and aggregates all pages", async () => {
    const requests: Request[] = [];
    const snapshot = await bedrock.fetchUsage(
      context(
        () =>
          requests.length === 1
            ? response({
                ...costResponse,
                NextPageToken: "page-2",
              })
            : response({
                ResultsByTime: [
                  {
                    Groups: [
                      {
                        Keys: ["Amazon Bedrock"],
                        Metrics: { UnblendedCost: { Amount: "2.50" } },
                      },
                    ],
                  },
                ],
              }),
        {
          ...keys,
          CODEXBAR_BEDROCK_API_URL: "https://bedrock.test",
        },
        requests,
      ),
    );

    expect(requests).toHaveLength(2);
    expect(requests[0]?.options?.body).toMatchObject({
      TimePeriod: { Start: "2026-06-01", End: "2026-06-20" },
    });
    expect(requests[1]?.options?.body).toMatchObject({ NextPageToken: "page-2" });
    expect(snapshot.cost).toMatchObject({ used: 15 });
  });

  it("maps Cost Explorer data-unavailable to zero and rejects malformed pagination", async () => {
    await expect(
      bedrock.fetchUsage(
        context(
          () => response({ Error: { Code: "com.amazonaws.ce#DataUnavailableException" } }, 400),
          { ...keys, CODEXBAR_BEDROCK_API_URL: "https://bedrock.test" },
        ),
      ),
    ).resolves.toMatchObject({ cost: { used: 0 } });

    await expect(
      bedrock.fetchUsage(
        context(() => response({ ResultsByTime: [], NextPageToken: "repeat" }), {
          ...keys,
          CODEXBAR_BEDROCK_API_URL: "https://bedrock.test",
        }),
      ),
    ).rejects.toThrow("Cost Explorer returned repeated NextPageToken");

    await expect(
      bedrock.fetchUsage(
        context(() => response({}), { ...keys, CODEXBAR_BEDROCK_API_URL: "https://bedrock.test" }),
      ),
    ).rejects.toThrow("Missing ResultsByTime in Cost Explorer response");
  });

  it("uses profile auth only when static credentials are absent and keeps explicit region precedence", async () => {
    const local: NonNullable<ProviderContext["local"]> = {
      run: async () => ({ exitCode: 0, signal: undefined, stdout: "", stderr: "" }),
      readData: async () => undefined,
      fetchBedrockAwsCredentials: async ({ profile }) => {
        expect(profile).toBe("work");
        return {
          accessKeyId: "AKIAPROFILE",
          secretAccessKey: "profile-secret",
          region: "ap-southeast-2",
        };
      },
    };
    expect(bedrockAuthMode(context(() => response({}), { AWS_PROFILE: "work" }))).toBe("profile");
    expect(bedrockAuthMode(context(() => response({}), { ...keys, AWS_PROFILE: "work" }))).toBe(
      "keys",
    );
    await expect(
      resolveBedrockCredentials(
        context(() => response({}), { AWS_PROFILE: "work", AWS_REGION: "eu-central-1" }, [], local),
      ),
    ).resolves.toMatchObject({
      region: "eu-central-1",
      credentials: { accessKeyId: "AKIAPROFILE" },
    });
  });

  it("uses reusable SigV4 signing for CloudWatch and supports AWS partitions", async () => {
    const headers = await signBedrockAwsRequest({
      credentials: { accessKeyId: "AKIATEST", secretAccessKey: "testSecret" },
      service: "monitoring",
      region: "us-west-2",
      url: new URL("https://monitoring.us-west-2.amazonaws.com"),
      body: {},
      now,
      target: "GraniteServiceVersion20100801.GetMetricData",
      contentType: "application/x-amz-json-1.0",
    });
    expect(headers.Authorization).toContain("/us-west-2/monitoring/aws4_request");
    expect(headers["Content-Type"]).toBe("application/x-amz-json-1.0");
    expect(bedrockCloudWatchPartitionSuffix("cn-north-1")).toBe("amazonaws.com.cn");
    expect(bedrockCloudWatchEndpoint("us-iso-east-1")).toBe(
      "https://monitoring.us-iso-east-1.c2s.ic.gov",
    );
  });

  it("aggregates bounded CloudWatch pages and rejects invalid endpoint/result data", async () => {
    const activity = await fetchBedrockCloudWatchActivity({
      ctx: context(() => response(cloudWatchResponse)),
      credentials: { accessKeyId: "AKIATEST", secretAccessKey: "testSecret" },
      region: "us-east-1",
      now,
      endpointOverride: "http://localhost:8080",
    });
    expect(activity).toEqual({ inputTokens: 3500, outputTokens: 1000, requestCount: 15 });
    expect(() => bedrockCloudWatchEndpoint("us-east-1", "http://cloudwatch.test")).toThrow(
      "invalid endpoint override",
    );
    expect(() =>
      parseBedrockCloudWatchPage({
        MetricDataResults: [{ Id: "unknown", StatusCode: "Complete", Values: [1] }],
      }),
    ).toThrow("unknown ID");

    await expect(
      fetchBedrockCloudWatchActivity({
        ctx: context(() => response({ ...cloudWatchResponse, NextToken: "repeat" })),
        credentials: { accessKeyId: "AKIATEST", secretAccessKey: "testSecret" },
        region: "us-east-1",
        now,
        endpointOverride: "http://localhost:8080",
      }),
    ).rejects.toThrow("repeated NextToken");
  });

  it("keeps Cost Explorer data when optional CloudWatch activity fails", async () => {
    const snapshot = await bedrock.fetchUsage(
      context(
        (request) =>
          request.url.hostname.startsWith("monitoring.")
            ? response({}, 403)
            : response(costResponse),
        { ...keys, CODEXBAR_BEDROCK_BUDGET: "200" },
      ),
    );
    expect(snapshot.identity).toEqual({ loginMethod: "Spend: $12.50 - Budget: $200.00" });
  });
});
