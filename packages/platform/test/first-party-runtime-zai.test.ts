import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import type { HttpRequest } from "@codexbar/core";
import { zai } from "@codexbar/providers";
import {
  makeFirstPartyProviderRuntime,
  type FirstPartySelectedAccount,
} from "../src/first-party-runtime.ts";

const now = Date.parse("2026-08-24T12:00:00Z");
const clock = { now: Effect.succeed(now), sleep: () => Effect.void };

const quota = {
  success: true,
  code: 200,
  data: {
    planName: "GLM Coding Plan",
    limits: [
      {
        type: "CREDIT_LIMIT",
        unit: 3,
        number: 5,
        percentage: 20,
        usage: 100,
        currentValue: 20,
        remaining: 80,
        usageDetails: [],
      },
    ],
  },
};

const response = (request: HttpRequest) => ({
  status: 200,
  headers: {},
  body: new TextEncoder().encode(JSON.stringify(quota)),
  url: request.url,
});

const selectedRuntime = (
  selected: FirstPartySelectedAccount,
  requests: HttpRequest[],
  reads: string[],
  overrides: Readonly<Record<string, string>> = {},
) =>
  makeFirstPartyProviderRuntime({
    providers: [zai],
    settings: {
      read: (_provider, key) => {
        reads.push(key);
        return Effect.succeed(
          overrides[key] ??
            (key === "Z_AI_API_KEY"
              ? "ambient-token"
              : key === "Z_AI_REGION"
                ? "global"
                : key === "Z_AI_USAGE_SCOPE"
                  ? "team"
                  : key === "Z_AI_ORGANIZATION"
                    ? "ambient-org"
                    : key === "Z_AI_PROJECT"
                      ? "ambient-project"
                      : undefined),
        );
      },
    },
    selectedAccounts: { resolve: () => Effect.succeed(selected) },
    browserSessions: { cookieHeader: () => Effect.succeed("") },
    credentials: {
      read: (key) => {
        reads.push(`credential:${key}`);
        return Effect.succeed("ambient-keyring-token");
      },
      write: () => Effect.void,
      remove: () => Effect.void,
    },
    http: {
      execute: (request) => {
        requests.push(request);
        return Effect.succeed(response(request));
      },
    },
    clock,
  });

describe("first-party runtime selected z.ai accounts", () => {
  it("injects selected team context while preserving global region settings", async () => {
    const requests: HttpRequest[] = [];
    const reads: string[] = [];
    const runtime = selectedRuntime(
      {
        id: "zai-team",
        secureSettings: { Z_AI_API_KEY: "selected-token" },
        plainSettings: {
          Z_AI_USAGE_SCOPE: "team",
          Z_AI_ORGANIZATION: "selected-org",
          Z_AI_PROJECT: "selected-project",
        },
      },
      requests,
      reads,
    );

    const outcome = await Effect.runPromise(
      runtime.fetch("zai", { sourceMode: "auto", includeCredits: false }),
    );
    expect(outcome.strategyId).toBe("zai.api");
    expect(requests.length).toBeGreaterThan(0);
    expect(requests[0]?.url).toContain("https://api.z.ai/");
    expect(new URL(requests[0]?.url ?? "https://invalid").searchParams.get("type")).toBe("2");
    expect(
      requests.every(
        (request) =>
          request.headers?.Authorization === "Bearer selected-token" &&
          request.headers?.["Bigmodel-Organization"] === "selected-org" &&
          request.headers?.["Bigmodel-Project"] === "selected-project",
      ),
    ).toBe(true);
    expect(reads).not.toContain("Z_AI_API_KEY");
    expect(reads.some((key) => key.startsWith("credential:"))).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain("selected-token");
    expect(JSON.stringify(outcome)).not.toContain("ambient-token");
  });

  it("clears ambient team context for a selected personal account", async () => {
    const requests: HttpRequest[] = [];
    const runtime = selectedRuntime(
      {
        id: "zai-personal",
        secureSettings: { Z_AI_API_KEY: "selected-token" },
        plainSettings: {
          Z_AI_USAGE_SCOPE: "personal",
          Z_AI_ORGANIZATION: null,
          Z_AI_PROJECT: null,
        },
      },
      requests,
      [],
    );

    await Effect.runPromise(runtime.fetch("zai", { sourceMode: "auto", includeCredits: false }));
    expect(requests.length).toBeGreaterThan(0);
    expect(new URL(requests[0]?.url ?? "https://invalid").searchParams.has("type")).toBe(false);
    expect(
      requests.every(
        (request) =>
          request.headers?.["Bigmodel-Organization"] === undefined &&
          request.headers?.["Bigmodel-Project"] === undefined,
      ),
    ).toBe(true);
  });

  it("preserves a validated global endpoint override for the selected account", async () => {
    const requests: HttpRequest[] = [];
    const runtime = selectedRuntime(
      {
        id: "zai-endpoint",
        secureSettings: { Z_AI_API_KEY: "selected-token" },
        plainSettings: {
          Z_AI_USAGE_SCOPE: "team",
          Z_AI_ORGANIZATION: "selected-org",
          Z_AI_PROJECT: "selected-project",
        },
      },
      requests,
      [],
      { Z_AI_QUOTA_ENDPOINT: "https://quota.example.test/custom" },
    );

    await Effect.runPromise(runtime.fetch("zai", { sourceMode: "auto", includeCredits: false }));
    expect(requests[0]?.url).toContain("https://quota.example.test/custom");
    expect(requests[0]?.headers?.Authorization).toBe("Bearer selected-token");
  });

  it("fails incomplete selected team context before transport without ambient fallback", async () => {
    const requests: HttpRequest[] = [];
    const runtime = selectedRuntime(
      {
        id: "zai-incomplete-team",
        secureSettings: { Z_AI_API_KEY: "selected-token" },
        plainSettings: {
          Z_AI_USAGE_SCOPE: "team",
          Z_AI_ORGANIZATION: null,
          Z_AI_PROJECT: null,
        },
      },
      requests,
      [],
    );

    await expect(
      Effect.runPromise(runtime.fetch("zai", { sourceMode: "auto", includeCredits: false })),
    ).rejects.toMatchObject({ kind: "missing-credential" });
    expect(requests).toHaveLength(0);
  });

  it("redacts the selected token from provider error messages", async () => {
    const requests: HttpRequest[] = [];
    const runtime = makeFirstPartyProviderRuntime({
      providers: [zai],
      settings: { read: () => Effect.succeed(undefined) },
      selectedAccounts: {
        resolve: () =>
          Effect.succeed({
            id: "zai-redaction",
            secureSettings: { Z_AI_API_KEY: "selected-token" },
            plainSettings: {
              Z_AI_USAGE_SCOPE: "personal",
              Z_AI_ORGANIZATION: null,
              Z_AI_PROJECT: null,
            },
          }),
      },
      browserSessions: { cookieHeader: () => Effect.succeed("") },
      credentials: {
        read: () => Effect.succeed(undefined),
        write: () => Effect.void,
        remove: () => Effect.void,
      },
      http: {
        execute: (request) => {
          requests.push(request);
          return Effect.succeed({
            status: 200,
            headers: {},
            body: new TextEncoder().encode(
              JSON.stringify({ success: false, code: 401, msg: "selected-token rejected" }),
            ),
            url: request.url,
          });
        },
      },
      clock,
    });

    const error = await Effect.runPromise(
      Effect.flip(runtime.fetch("zai", { sourceMode: "auto", includeCredits: false })),
    );
    expect(error).toMatchObject({ kind: "api-failure" });
    expect(error.message).toContain("[REDACTED]");
    expect(error.message).not.toContain("selected-token");
    expect(requests).toHaveLength(1);
  });

  it.each(["web", "cli", "oauth"] as const)(
    "does not reinterpret a selected z.ai account under %s source",
    async (sourceMode) => {
      const requests: HttpRequest[] = [];
      const runtime = selectedRuntime(
        {
          id: "zai-source",
          secureSettings: { Z_AI_API_KEY: "selected-token" },
          plainSettings: {
            Z_AI_USAGE_SCOPE: "personal",
            Z_AI_ORGANIZATION: null,
            Z_AI_PROJECT: null,
          },
        },
        requests,
        [],
      );

      await expect(
        Effect.runPromise(runtime.fetch("zai", { sourceMode, includeCredits: false })),
      ).rejects.toMatchObject({ name: "NoAvailableStrategy", providerId: "zai" });
      expect(requests).toHaveLength(0);
    },
  );
});
