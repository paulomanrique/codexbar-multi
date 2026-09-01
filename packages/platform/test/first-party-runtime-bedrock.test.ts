import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import type { HttpRequest } from "@codexbar/core";
import { amp, bedrock, type FirstPartyProvider } from "@codexbar/providers";
import { makeFirstPartyProviderRuntime } from "../src/first-party-runtime.ts";

const clock = {
  now: Effect.succeed(Date.parse("2026-06-19T12:00:00.000Z")),
  sleep: () => Effect.void,
};

const credentials = {
  read: () => Effect.succeed(undefined),
  write: () => Effect.void,
  remove: () => Effect.void,
};

const response = (request: HttpRequest, body: unknown) => ({
  status: 200,
  headers: {},
  body: new TextEncoder().encode(JSON.stringify(body)),
  url: request.url,
});

const unusedLocal = {
  run: () => Effect.succeed({ exitCode: 0, signal: undefined, stdout: "", stderr: "" }),
  readData: () => Effect.succeed(undefined),
};

describe("first-party runtime Bedrock capability broker", () => {
  it("passes only the allowlisted profile environment and returns a Bedrock snapshot", async () => {
    let sourceEnvironment: unknown;
    const requests: HttpRequest[] = [];
    const settings: Readonly<Record<string, string>> = {
      CODEXBAR_BEDROCK_AUTH_MODE: "profile",
      AWS_PROFILE: "work",
      AWS_ACCESS_KEY_ID: "persisted-access",
      AWS_SECRET_ACCESS_KEY: "persisted-secret",
      AWS_SESSION_TOKEN: "persisted-session",
      AWS_REGION: "eu-west-1",
    };
    const runtime = makeFirstPartyProviderRuntime({
      providers: [bedrock],
      settings: { read: (_providerId, key) => Effect.succeed(settings[key]) },
      credentials,
      browserSessions: { cookieHeader: () => Effect.fail(new Error("not used")) },
      local: {
        ...unusedLocal,
        fetchBedrockAwsCredentials: (_providerId, profile, source) => {
          expect(profile).toBe("work");
          sourceEnvironment = source;
          return Effect.succeed({
            accessKeyId: "resolved-access",
            secretAccessKey: "resolved-secret",
            sessionToken: "resolved-session",
            region: "ap-southeast-2",
          });
        },
      },
      http: {
        execute: (request) => {
          requests.push(request);
          return Effect.succeed(
            response(
              request,
              request.url.startsWith("https://ce.")
                ? {
                    ResultsByTime: [
                      {
                        Groups: [
                          {
                            Keys: ["Amazon Bedrock"],
                            Metrics: { UnblendedCost: { Amount: "1.25" } },
                          },
                        ],
                      },
                    ],
                  }
                : { MetricDataResults: [] },
            ),
          );
        },
      },
      clock,
    });

    const outcome = await Effect.runPromise(
      runtime.fetch("bedrock", { sourceMode: "auto", includeCredits: false }),
    );

    expect(sourceEnvironment).toEqual({
      region: "eu-west-1",
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.maximumResponseBytes).toBeUndefined();
    expect(requests[1]?.maximumResponseBytes).toBe(4 * 1024 * 1024);
    expect(outcome.snapshot.providerCost).toMatchObject({ used: 1.25, currencyCode: "USD" });
    expect(JSON.stringify(outcome)).not.toContain("resolved-secret");
    expect(JSON.stringify(outcome)).not.toContain("persisted-secret");
  });

  it("redacts persisted credentials from adapter failures without projecting them", async () => {
    const adapterError = Object.assign(new Error("failed with persisted-secret"), {
      name: "NodeBedrockAwsError",
      code: "api-error",
    });
    const runtime = makeFirstPartyProviderRuntime({
      providers: [bedrock],
      settings: {
        read: (_providerId, key) =>
          Effect.succeed(
            {
              CODEXBAR_BEDROCK_AUTH_MODE: "profile",
              AWS_PROFILE: "work",
              AWS_SECRET_ACCESS_KEY: "persisted-secret",
            }[key],
          ),
      },
      credentials,
      browserSessions: { cookieHeader: () => Effect.fail(new Error("not used")) },
      local: {
        ...unusedLocal,
        fetchBedrockAwsCredentials: () => Effect.fail(adapterError),
      },
      http: { execute: () => Effect.die("not used") },
      clock,
    });

    await expect(
      Effect.runPromise(runtime.fetch("bedrock", { sourceMode: "auto", includeCredits: false })),
    ).rejects.toMatchObject({
      kind: "api-failure",
      message: "failed with [REDACTED]",
    });
  });

  it("denies Bedrock credential export to other providers before calling the adapter", async () => {
    let calls = 0;
    const ampMisusingBedrock: FirstPartyProvider = {
      ...amp,
      strategies: [
        {
          id: "amp.bedrock-misuse",
          kind: "cli",
          fetchUsage: async (ctx) => {
            await ctx.local?.fetchBedrockAwsCredentials?.({ profile: "work" });
            return { identity: { loginMethod: "unreachable" } };
          },
        },
      ],
    };
    const runtime = makeFirstPartyProviderRuntime({
      providers: [ampMisusingBedrock],
      settings: { read: () => Effect.succeed(undefined) },
      credentials,
      browserSessions: { cookieHeader: () => Effect.fail(new Error("not used")) },
      local: {
        ...unusedLocal,
        fetchBedrockAwsCredentials: () => {
          calls += 1;
          return Effect.die("must not run");
        },
      },
      http: { execute: () => Effect.die("not used") },
      clock,
    });

    await expect(
      Effect.runPromise(runtime.fetch("amp", { sourceMode: "cli", includeCredits: false })),
    ).rejects.toMatchObject({ kind: "permission-denied" });
    expect(calls).toBe(0);
  });
});
