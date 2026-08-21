import { describe, expect, it } from "vite-plus/test";
import { Effect, Fiber } from "effect";
import {
  Clock,
  CostUsageRepository,
  HistoryRepository,
  InfrastructureError,
  type HttpRequest,
  refreshProviderAndPersist,
  type HistoryRecord,
} from "@codexbar/core";
import { amp, antigravity, grok, openai } from "@codexbar/providers";
import { ibmbob } from "@codexbar/providers";
import type { FirstPartyProvider } from "@codexbar/providers";
import { makeFirstPartyProviderRuntime, nextDailyReset } from "../src/first-party-runtime.ts";

const response = (value: unknown) => ({
  status: 200,
  headers: {},
  body: new TextEncoder().encode(JSON.stringify(value)),
  url: "https://api.openai.com/fixture",
});

describe("first-party refresh runtime", () => {
  it("prefers the Antigravity local broker in auto mode and keeps host credentials out of the snapshot", async () => {
    const runtime = makeFirstPartyProviderRuntime({
      providers: [antigravity],
      settings: { read: () => Effect.succeed(undefined) },
      credentials: {
        read: () => Effect.succeed(undefined),
        write: () => Effect.void,
        remove: () => Effect.void,
      },
      browserSessions: { cookieHeader: () => Effect.fail(new Error("not used")) },
      local: {
        run: () => Effect.die("not used"),
        readData: () => Effect.succeed(undefined),
        fetchAntigravityLocalSnapshot: () =>
          Effect.succeed({
            quotaSummaryJson: JSON.stringify({
              groups: [
                {
                  displayName: "Gemini",
                  buckets: [
                    {
                      bucketId: "gemini-session",
                      displayName: "5-hour",
                      remainingFraction: 0.75,
                    },
                  ],
                },
              ],
            }),
            userStatusJson: JSON.stringify({
              userStatus: { email: "local@example.test", userTier: { name: "Ultra" } },
            }),
          }),
      },
      http: { execute: () => Effect.fail(new InfrastructureError("test", "not used")) },
      clock: { now: Effect.succeed(1_786_809_600_000), sleep: () => Effect.void },
    });
    await expect(
      Effect.runPromise(
        runtime.fetch("antigravity", { sourceMode: "auto", includeCredits: false }),
      ),
    ).resolves.toMatchObject({
      strategyId: "antigravity.local",
      source: "local-probe",
      snapshot: {
        primary: { usedPercent: 25 },
        identity: {
          accountEmail: "local@example.test",
          loginMethod: "Ultra",
          providerId: "antigravity",
        },
      },
    });
  });

  it("falls back from unavailable Antigravity local usage to OAuth only in auto mode", async () => {
    const requests: HttpRequest[] = [];
    const runtime = makeFirstPartyProviderRuntime({
      providers: [antigravity],
      settings: {
        read: (_provider, key) =>
          Effect.succeed(key === "ANTIGRAVITY_OAUTH_ACCESS_TOKEN" ? "oauth-token" : undefined),
      },
      credentials: {
        read: () => Effect.succeed(undefined),
        write: () => Effect.void,
        remove: () => Effect.void,
      },
      browserSessions: { cookieHeader: () => Effect.fail(new Error("not used")) },
      local: {
        run: () => Effect.die("not used"),
        readData: () => Effect.succeed(undefined),
        fetchAntigravityLocalSnapshot: () =>
          Effect.fail(new InfrastructureError("local probe", "not running")),
      },
      http: {
        execute: (request) => {
          requests.push(request);
          const body = request.url.endsWith("loadCodeAssist")
            ? { currentTier: { id: "standard-tier" }, cloudaicompanionProject: "project" }
            : request.url.endsWith("fetchAvailableModels")
              ? {
                  models: {
                    gemini: {
                      displayName: "Gemini",
                      quotaInfo: { remainingFraction: 0.5 },
                    },
                  },
                }
              : {};
          return Effect.succeed(response(body));
        },
      },
      clock: { now: Effect.succeed(1_786_809_600_000), sleep: () => Effect.void },
    });
    await expect(
      Effect.runPromise(
        runtime.fetch("antigravity", { sourceMode: "auto", includeCredits: false }),
      ),
    ).resolves.toMatchObject({ strategyId: "antigravity.oauth", source: "oauth" });
    expect(requests).toHaveLength(2);
    await expect(
      Effect.runPromise(runtime.fetch("antigravity", { sourceMode: "cli", includeCredits: false })),
    ).rejects.toMatchObject({ kind: "api-failure" });
  });

  it("falls back on an ambient account mismatch and scopes OAuth to the selected account", async () => {
    const requests: HttpRequest[] = [];
    let localCalls = 0;
    let selectedAccountResolutions = 0;
    let ambientAccessReads = 0;
    const runtime = makeFirstPartyProviderRuntime({
      providers: [antigravity],
      settings: {
        read: (_provider, key) => {
          if (key === "ANTIGRAVITY_OAUTH_ACCESS_TOKEN") ambientAccessReads += 1;
          return Effect.succeed(
            key === "ANTIGRAVITY_OAUTH_ACCESS_TOKEN" ? "ambient-value" : undefined,
          );
        },
      },
      selectedAccounts: {
        resolve: () => {
          selectedAccountResolutions += 1;
          return Effect.succeed({
            id: "account-1",
            accountEmail: "selected@example.com",
            secureSettings: {
              ANTIGRAVITY_OAUTH_ACCESS_TOKEN: "selected-access",
              ANTIGRAVITY_ID_TOKEN: "header.eyJlbWFpbCI6InNlbGVjdGVkQGV4YW1wbGUuY29tIn0.signature",
            },
            plainSettings: {
              ANTIGRAVITY_ACCOUNT_EMAIL: "stored@example.com",
              ANTIGRAVITY_PROJECT_ID: "selected-project",
            },
          });
        },
      },
      credentials: {
        read: (key) => {
          if (key.endsWith("/ANTIGRAVITY_OAUTH_ACCESS_TOKEN")) ambientAccessReads += 1;
          return Effect.succeed(
            key.endsWith("/ANTIGRAVITY_OAUTH_ACCESS_TOKEN") ? "ambient-keyring-value" : undefined,
          );
        },
        write: () => Effect.void,
        remove: () => Effect.void,
      },
      browserSessions: { cookieHeader: () => Effect.fail(new Error("not used")) },
      local: {
        run: () => Effect.die("not used"),
        readData: () => Effect.succeed(undefined),
        fetchAntigravityLocalSnapshot: () => {
          localCalls += 1;
          return Effect.succeed({
            quotaSummaryJson: JSON.stringify({
              groups: [
                {
                  displayName: "Gemini",
                  buckets: [
                    { bucketId: "session", displayName: "5-hour", remainingFraction: 0.75 },
                  ],
                },
              ],
            }),
            userStatusJson: JSON.stringify({ userStatus: { email: "ambient@example.com" } }),
          });
        },
      },
      http: {
        execute: (request) => {
          requests.push(request);
          const body = request.url.endsWith("loadCodeAssist")
            ? { currentTier: { id: "standard-tier" } }
            : {
                models: {
                  gemini: {
                    displayName: "Gemini",
                    quotaInfo: { remainingFraction: 0.5 },
                  },
                },
              };
          return Effect.succeed(response(body));
        },
      },
      clock: { now: Effect.succeed(1_786_809_600_000), sleep: () => Effect.void },
    });

    await expect(
      Effect.runPromise(
        runtime.fetch("antigravity", { sourceMode: "auto", includeCredits: false }),
      ),
    ).resolves.toMatchObject({
      strategyId: "antigravity.oauth",
      snapshot: { identity: { accountEmail: "selected@example.com" } },
    });
    expect(requests).toHaveLength(2);
    expect(localCalls).toBe(1);
    expect(selectedAccountResolutions).toBe(1);
    expect(ambientAccessReads).toBe(0);
    expect(requests[0]?.headers?.Authorization).toBe("Bearer selected-access");
    expect(new TextDecoder().decode(requests[1]?.body ?? new Uint8Array())).toContain(
      "selected-project",
    );
    expect(JSON.stringify(requests)).not.toContain("ambient-keyring-value");
  });

  it("keeps explicit Antigravity CLI authoritative despite a selected account mismatch", async () => {
    const runtime = makeFirstPartyProviderRuntime({
      providers: [antigravity],
      settings: { read: () => Effect.succeed(undefined) },
      selectedAccounts: {
        resolve: () => Effect.succeed({ id: "account-1", accountEmail: "selected@example.com" }),
      },
      credentials: {
        read: () => Effect.succeed(undefined),
        write: () => Effect.void,
        remove: () => Effect.void,
      },
      browserSessions: { cookieHeader: () => Effect.fail(new Error("not used")) },
      local: {
        run: () => Effect.die("not used"),
        readData: () => Effect.succeed(undefined),
        fetchAntigravityLocalSnapshot: () =>
          Effect.succeed({
            quotaSummaryJson: JSON.stringify({
              groups: [
                {
                  displayName: "Gemini",
                  buckets: [
                    { bucketId: "session", displayName: "5-hour", remainingFraction: 0.75 },
                  ],
                },
              ],
            }),
            userStatusJson: JSON.stringify({ userStatus: { email: "ambient@example.com" } }),
          }),
      },
      http: { execute: () => Effect.fail(new InfrastructureError("test", "not used")) },
      clock: { now: Effect.succeed(1_786_809_600_000), sleep: () => Effect.void },
    });

    await expect(
      Effect.runPromise(runtime.fetch("antigravity", { sourceMode: "cli", includeCredits: false })),
    ).resolves.toMatchObject({
      strategyId: "antigravity.local",
      snapshot: { identity: { accountEmail: "ambient@example.com" } },
    });
  });

  it("does not reuse ambient OAuth credentials for an invalid selected account", async () => {
    let httpCalls = 0;
    const runtime = makeFirstPartyProviderRuntime({
      providers: [antigravity],
      settings: {
        read: (_provider, key) =>
          Effect.succeed(key === "ANTIGRAVITY_OAUTH_ACCESS_TOKEN" ? "ambient-env" : undefined),
      },
      selectedAccounts: {
        resolve: () =>
          Effect.succeed({
            id: "account-1",
            secureSettings: {
              ANTIGRAVITY_OAUTH_ACCESS_TOKEN: null,
              ANTIGRAVITY_ID_TOKEN: null,
            },
            plainSettings: {
              ANTIGRAVITY_ACCOUNT_EMAIL: null,
              ANTIGRAVITY_PROJECT_ID: null,
            },
          }),
      },
      credentials: {
        read: (key) =>
          Effect.succeed(
            key.endsWith("/ANTIGRAVITY_OAUTH_ACCESS_TOKEN") ? "ambient-keyring" : undefined,
          ),
        write: () => Effect.void,
        remove: () => Effect.void,
      },
      browserSessions: { cookieHeader: () => Effect.fail(new Error("not used")) },
      local: {
        run: () => Effect.die("not used"),
        readData: () => Effect.succeed(undefined),
        fetchAntigravityLocalSnapshot: () =>
          Effect.succeed({
            quotaSummaryJson: JSON.stringify({
              groups: [
                {
                  displayName: "Gemini",
                  buckets: [
                    { bucketId: "session", displayName: "5-hour", remainingFraction: 0.75 },
                  ],
                },
              ],
            }),
            userStatusJson: JSON.stringify({ userStatus: { email: "ambient@example.com" } }),
          }),
      },
      http: {
        execute: () => {
          httpCalls += 1;
          return Effect.succeed(response({}));
        },
      },
      clock: { now: Effect.succeed(1_786_809_600_000), sleep: () => Effect.void },
    });

    await expect(
      Effect.runPromise(
        runtime.fetch("antigravity", { sourceMode: "auto", includeCredits: false }),
      ),
    ).rejects.toMatchObject({ kind: "missing-credential" });
    expect(httpCalls).toBe(0);
  });

  it("never falls through to Antigravity OAuth after caller cancellation", async () => {
    const controller = new AbortController();
    let startedResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    let oauthRequests = 0;
    const runtime = makeFirstPartyProviderRuntime({
      providers: [antigravity],
      settings: {
        read: (_provider, key) =>
          Effect.succeed(key === "ANTIGRAVITY_OAUTH_ACCESS_TOKEN" ? "oauth-token" : undefined),
      },
      credentials: {
        read: () => Effect.succeed(undefined),
        write: () => Effect.void,
        remove: () => Effect.void,
      },
      browserSessions: { cookieHeader: () => Effect.fail(new Error("not used")) },
      local: {
        run: () => Effect.die("not used"),
        readData: () => Effect.succeed(undefined),
        fetchAntigravityLocalSnapshot: () =>
          Effect.tryPromise({
            try: (signal) => {
              startedResolve?.();
              return new Promise((_resolve, reject) =>
                signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
              );
            },
            catch: (error) => error,
          }),
      },
      http: {
        execute: () => {
          oauthRequests += 1;
          return Effect.succeed(response({}));
        },
      },
      clock: { now: Effect.succeed(1_786_809_600_000), sleep: () => Effect.void },
    });
    const pending = Effect.runPromise(
      runtime.fetch("antigravity", { sourceMode: "auto", includeCredits: false }),
      { signal: controller.signal },
    );
    await started;
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(pending).rejects.toBeDefined();
    expect(oauthRequests).toBe(0);
  });

  it("rejects an oversized Antigravity broker DTO before provider parsing", async () => {
    const runtime = makeFirstPartyProviderRuntime({
      providers: [antigravity],
      settings: { read: () => Effect.succeed(undefined) },
      credentials: {
        read: () => Effect.succeed(undefined),
        write: () => Effect.void,
        remove: () => Effect.void,
      },
      browserSessions: { cookieHeader: () => Effect.fail(new Error("not used")) },
      local: {
        run: () => Effect.die("not used"),
        readData: () => Effect.succeed(undefined),
        fetchAntigravityLocalSnapshot: () =>
          Effect.succeed({ quotaSummaryJson: "x".repeat(1024 * 1024 + 1) }),
      },
      http: { execute: () => Effect.fail(new InfrastructureError("test", "not used")) },
      clock: { now: Effect.succeed(1_786_809_600_000), sleep: () => Effect.void },
    });
    await expect(
      Effect.runPromise(runtime.fetch("antigravity", { sourceMode: "cli", includeCredits: false })),
    ).rejects.toMatchObject({ kind: "api-failure" });
  });

  it("routes an explicit Grok OAuth refresh through the private credential capability", async () => {
    const requests: HttpRequest[] = [];
    const runtime = makeFirstPartyProviderRuntime({
      providers: [grok],
      settings: { read: () => Effect.succeed(undefined) },
      credentials: {
        read: () => Effect.succeed(undefined),
        write: () => Effect.void,
        remove: () => Effect.void,
      },
      browserSessions: { cookieHeader: () => Effect.fail(new Error("not used")) },
      local: {
        run: () => Effect.die("not used"),
        readData: () => Effect.succeed(undefined),
        fetchGrokCredentials: () =>
          Effect.succeed({
            accessToken: "fixture-auth-file-token",
            scope: "https://auth.x.ai::fixture",
            authMode: "oidc",
            email: "ada@example.test",
          }),
      },
      http: {
        execute: (request) => {
          requests.push(request);
          return Effect.succeed({
            status: 200,
            headers: {},
            body: new TextEncoder().encode(
              request.url.endsWith("/v1/settings")
                ? '{"subscription_tier_display":"SuperGrok Heavy"}'
                : '{"config":{"creditUsagePercent":25,"currentPeriod":{"end":"2026-08-23T00:00:00Z"}}}',
            ),
            url: request.url,
          });
        },
      },
      clock: { now: Effect.succeed(1_786_809_600_000), sleep: () => Effect.void },
    });
    const outcome = await Effect.runPromise(
      runtime.fetch("grok", { sourceMode: "oauth", includeCredits: false }),
    );
    expect(outcome).toMatchObject({
      strategyId: "grok.oauth",
      source: "oauth",
      snapshot: { primary: { usedPercent: 25 }, identity: { accountEmail: "ada@example.test" } },
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.headers?.Authorization).toBe("Bearer fixture-auth-file-token");
    expect(JSON.stringify(outcome)).not.toContain("fixture-auth-file-token");
  });

  it("fails closed when a local provider is composed without a local capability broker", async () => {
    const clock = { now: Effect.succeed(1), sleep: () => Effect.void };
    const runtime = makeFirstPartyProviderRuntime({
      providers: [amp],
      settings: { read: () => Effect.succeed(undefined) },
      credentials: {
        read: () => Effect.succeed(undefined),
        write: () => Effect.void,
        remove: () => Effect.void,
      },
      browserSessions: { cookieHeader: () => Effect.fail(new Error("not used")) },
      http: { execute: () => Effect.fail(new InfrastructureError("test", "not used")) },
      clock,
    });
    await expect(
      Effect.runPromise(runtime.fetch("amp", { sourceMode: "cli", includeCredits: false })),
    ).rejects.toMatchObject({ kind: "provider-unavailable" });
  });

  it("routes an explicit CLI source through a local provider capability", async () => {
    const runtime = makeFirstPartyProviderRuntime({
      providers: [amp],
      settings: { read: () => Effect.succeed(undefined) },
      credentials: {
        read: () => Effect.succeed(undefined),
        write: () => Effect.void,
        remove: () => Effect.void,
      },
      browserSessions: { cookieHeader: () => Effect.fail(new Error("not used")) },
      local: {
        run: () =>
          Effect.succeed({
            exitCode: 0,
            signal: undefined,
            stdout:
              "Signed in as fixture@example.com\nAmp Free: 58% remaining today (resets daily)",
            stderr: "",
          }),
        readData: () => Effect.succeed(undefined),
      },
      http: { execute: () => Effect.fail(new InfrastructureError("test", "not used")) },
      clock: { now: Effect.succeed(1), sleep: () => Effect.void },
    });

    await expect(
      Effect.runPromise(runtime.fetch("amp", { sourceMode: "cli", includeCredits: false })),
    ).resolves.toMatchObject({ source: "cli" });
  });

  it("injects host credentials, maps the provider result, and persists only the successful snapshot", async () => {
    const records: HistoryRecord[] = [];
    const headers: Array<Readonly<Record<string, string>> | undefined> = [];
    const clock = { now: Effect.succeed(1_700_179_200_000), sleep: () => Effect.void };
    const runtime = makeFirstPartyProviderRuntime({
      providers: [openai],
      settings: {
        read: (_provider, key) => Effect.succeed(key === "OPENAI_HISTORY_DAYS" ? "1" : undefined),
      },
      credentials: {
        read: () => Effect.succeed("fixture-key"),
        write: () => Effect.void,
        remove: () => Effect.void,
      },
      browserSessions: { cookieHeader: () => Effect.fail(new Error("not used")) },
      clock,
      http: {
        execute: (request) => {
          headers.push(request.headers);
          return Effect.succeed(
            request.url.includes("/organization/costs")
              ? response({ object: "page", data: [], has_more: false, next_page: null })
              : response({ object: "page", data: [], has_more: false, next_page: null }),
          );
        },
      },
    });

    const outcome = await Effect.runPromise(
      refreshProviderAndPersist(runtime, "openai", {
        sourceMode: "auto",
        includeCredits: true,
      }).pipe(
        Effect.provideService(Clock, clock),
        Effect.provideService(HistoryRepository, {
          append: (record) => Effect.sync(() => void records.push(record)),
          latest: () => Effect.succeed(undefined),
          list: () => Effect.succeed([]),
          removeProvider: () => Effect.void,
        }),
        Effect.provideService(CostUsageRepository, {
          append: () => Effect.void,
          commitLocalScan: () => Effect.void,
          commitLocalScanFamily: () => Effect.void,
          localScanCheckpoint: () => Effect.succeed(undefined),
          replaceDaily: () => Effect.void,
          dailySourceState: () => Effect.succeed(undefined),
          list: () => Effect.succeed([]),
        }),
      ),
    );

    expect(outcome.source).toBe("api-token");
    expect(outcome.snapshot.providerCost).toMatchObject({ used: 0, currencyCode: "USD" });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ providerId: "openai", recordedAt: 1_700_179_200_000 });
    expect(headers).toHaveLength(2);
    expect(headers.every((value) => value?.Authorization === "Bearer fixture-key")).toBe(true);
  });

  it("does not persist a failed refresh", async () => {
    const records: HistoryRecord[] = [];
    const clock = { now: Effect.succeed(1), sleep: () => Effect.void };
    const runtime = makeFirstPartyProviderRuntime({
      providers: [openai],
      settings: { read: () => Effect.succeed(undefined) },
      credentials: {
        read: () => Effect.succeed(undefined),
        write: () => Effect.void,
        remove: () => Effect.void,
      },
      browserSessions: { cookieHeader: () => Effect.fail(new Error("not used")) },
      clock,
      http: { execute: () => Effect.fail(new InfrastructureError("test", "must not request")) },
    });
    await expect(
      Effect.runPromise(
        refreshProviderAndPersist(runtime, "openai", {
          sourceMode: "auto",
          includeCredits: true,
        }).pipe(
          Effect.provideService(Clock, clock),
          Effect.provideService(HistoryRepository, {
            append: (record) => Effect.sync(() => void records.push(record)),
            latest: () => Effect.succeed(undefined),
            list: () => Effect.succeed([]),
            removeProvider: () => Effect.void,
          }),
          Effect.provideService(CostUsageRepository, {
            append: () => Effect.void,
            commitLocalScan: () => Effect.void,
            commitLocalScanFamily: () => Effect.void,
            localScanCheckpoint: () => Effect.succeed(undefined),
            replaceDaily: () => Effect.void,
            dailySourceState: () => Effect.succeed(undefined),
            list: () => Effect.succeed([]),
          }),
        ),
      ),
    ).rejects.toMatchObject({ kind: "missing-credential" });
    expect(records).toHaveLength(0);
  });

  it("prefers native keyring secrets, falls back to injected secrets, and never exposes either as a plain setting", async () => {
    const clock = { now: Effect.succeed(1), sleep: () => Effect.void };
    const seen: Array<string | undefined> = [];
    const probe: FirstPartyProvider = {
      id: "openai.probe",
      kind: "api",
      descriptor: {
        id: "openai",
        name: "Probe",
        status: "partial",
        endpoints: [],
        auth: { type: "bearer", secret: "PROBE_SECRET" },
        settings: [
          { key: "PROBE_SECRET", title: "Secret", type: "secure" },
          { key: "PROBE_PLAIN", title: "Plain", type: "plain" },
        ],
      },
      fetchUsage: async (context) => {
        seen.push(context.settings.get("PROBE_SECRET"));
        seen.push(context.settings.getSecret("PROBE_SECRET"));
        seen.push(context.settings.get("PROBE_PLAIN"));
        return { identity: { loginMethod: "fixture" } };
      },
    };
    const run = async (native: string | undefined) =>
      Effect.runPromise(
        makeFirstPartyProviderRuntime({
          providers: [probe],
          settings: {
            read: (_provider, key) =>
              Effect.succeed(key === "PROBE_SECRET" ? "environment-secret" : "plain-value"),
          },
          credentials: {
            read: () => Effect.succeed(native),
            write: () => Effect.void,
            remove: () => Effect.void,
          },
          browserSessions: { cookieHeader: () => Effect.fail(new Error("not used")) },
          http: { execute: () => Effect.fail(new InfrastructureError("test", "not used")) },
          clock,
        }).fetch("openai", { sourceMode: "auto", includeCredits: true }),
      );
    await run("keyring-secret");
    expect(seen).toEqual([undefined, "keyring-secret", "plain-value"]);
    seen.length = 0;
    await run(undefined);
    expect(seen).toEqual([undefined, "environment-secret", "plain-value"]);
  });

  it("redacts host secrets and cookie values from provider failures", async () => {
    const secret = "fixture-private-token";
    const cookieValue = "fixture-private-cookie";
    const probe: FirstPartyProvider = {
      id: "t3chat.redaction-probe",
      kind: "web",
      descriptor: {
        id: "t3chat",
        name: "Redaction probe",
        status: "partial",
        endpoints: ["https://t3.chat"],
        auth: { type: "bearer", secret: "PROBE_SECRET" },
        settings: [{ key: "PROBE_SECRET", title: "Secret", type: "secure" }],
        capabilities: ["browser-cookies"],
        cookieDomains: ["t3.chat"],
      },
      fetchUsage: async (context) => {
        const cookie = await context.browser.cookieHeader("t3.chat");
        throw new Error(`${context.settings.getSecret("PROBE_SECRET")} ${cookie} ${cookieValue}`);
      },
    };
    const runtime = makeFirstPartyProviderRuntime({
      providers: [probe],
      settings: { read: () => Effect.succeed(undefined) },
      credentials: {
        read: () => Effect.succeed(secret),
        write: () => Effect.void,
        remove: () => Effect.void,
      },
      browserSessions: {
        cookieHeader: () => Effect.succeed(`session=${cookieValue}`),
      },
      http: { execute: () => Effect.fail(new InfrastructureError("test", "not used")) },
      clock: { now: Effect.succeed(1), sleep: () => Effect.void },
    });

    await expect(
      Effect.runPromise(runtime.fetch("t3chat", { sourceMode: "auto", includeCredits: true })),
    ).rejects.toMatchObject({
      message: "[REDACTED] [REDACTED] [REDACTED]",
    });
  });

  it("calculates the next daily boundary in the requested timezone across DST", () => {
    expect(nextDailyReset(Date.parse("2026-08-20T03:00:00Z"), "America/Chicago", 0)).toBe(
      "2026-08-20T05:00:00.000Z",
    );
    expect(nextDailyReset(Date.parse("2026-03-08T07:00:00Z"), "America/Chicago", 3)).toBe(
      "2026-03-08T08:00:00.000Z",
    );
  });

  it("allows regional IBM Bob hosts and preserves provider-managed JWT/API-key authorization", async () => {
    const requests: HttpRequest[] = [];
    const bobProfile = {
      instances: [
        {
          instance_id: "instance",
          user_id: "user",
          region_domain: "eu-de.bob.ibm.com",
          teams: [{ id: "team", budget_limit: 40 }],
        },
      ],
    };
    const run = async (credential: string) => {
      requests.length = 0;
      const runtime = makeFirstPartyProviderRuntime({
        providers: [ibmbob],
        settings: { read: () => Effect.succeed(undefined) },
        credentials: {
          read: () => Effect.succeed(credential),
          write: () => Effect.void,
          remove: () => Effect.void,
        },
        browserSessions: { cookieHeader: () => Effect.fail(new Error("not used")) },
        clock: { now: Effect.succeed(1_700_000_000_000), sleep: () => Effect.void },
        http: {
          execute: (request) => {
            requests.push(request);
            return Effect.succeed(
              response(request.url.endsWith("/profile") ? bobProfile : { usage: 10 }),
            );
          },
        },
      });
      await Effect.runPromise(
        runtime.fetch("ibmbob", { sourceMode: "auto", includeCredits: true }),
      );
    };

    await run("header.eyJzdWIiOiJ1c2VyIn0.signature");
    expect(requests).toHaveLength(2);
    expect(
      requests.every(
        (request) =>
          request.headers?.Authorization === "Bearer header.eyJzdWIiOiJ1c2VyIn0.signature",
      ),
    ).toBe(true);
    await run("fixture-api-key");
    expect(
      requests.every((request) => request.headers?.Authorization === "Apikey fixture-api-key"),
    ).toBe(true);
  });

  it("enforces domain suffix endpoint boundaries and HTTPS", async () => {
    const target = { value: "https://api.us-east.bob.ibm.com/usage" };
    const probe: FirstPartyProvider = {
      id: "ibmbob",
      kind: "api",
      descriptor: {
        id: "ibmbob",
        name: "Bob endpoint probe",
        status: "partial",
        endpoints: [{ domainSuffix: "bob.ibm.com", policy: "https" }],
        settings: [],
      },
      fetchUsage: async (context) => {
        await context.http.get(target.value);
        return { identity: { loginMethod: "probe" } };
      },
    };
    const execute = (_request: HttpRequest) =>
      Effect.succeed(response({ identity: { loginMethod: "probe" } }));
    const runtime = makeFirstPartyProviderRuntime({
      providers: [probe],
      settings: { read: () => Effect.succeed(undefined) },
      credentials: {
        read: () => Effect.succeed(undefined),
        write: () => Effect.void,
        remove: () => Effect.void,
      },
      browserSessions: { cookieHeader: () => Effect.fail(new Error("not used")) },
      clock: { now: Effect.succeed(1), sleep: () => Effect.void },
      http: { execute },
    });
    await Effect.runPromise(runtime.fetch("ibmbob", { sourceMode: "auto", includeCredits: false }));
    target.value = "https://evilbob.ibm.com/usage";
    await expect(
      Effect.runPromise(runtime.fetch("ibmbob", { sourceMode: "auto", includeCredits: false })),
    ).rejects.toMatchObject({ kind: "api-failure" });
    target.value = "http://api.us-east.bob.ibm.com/usage";
    await expect(
      Effect.runPromise(runtime.fetch("ibmbob", { sourceMode: "auto", includeCredits: false })),
    ).rejects.toMatchObject({ kind: "api-failure" });
  });

  it("allowlists a provider-owned default endpoint when its setting is absent", async () => {
    const requests: HttpRequest[] = [];
    const probe: FirstPartyProvider = {
      id: "openai.default-endpoint-probe",
      kind: "api",
      descriptor: {
        id: "openai",
        name: "Default endpoint probe",
        status: "partial",
        endpoints: [
          {
            setting: "PROBE_ENDPOINT",
            policy: "https-or-loopback-http",
            default: "http://127.0.0.1:8088",
          },
        ],
        settings: [{ key: "PROBE_ENDPOINT", title: "Endpoint", type: "plain" }],
      },
      fetchUsage: async (context) => {
        await context.http.get("http://127.0.0.1:8088/healthz");
        return { identity: { loginMethod: "probe" } };
      },
    };
    const runtime = makeFirstPartyProviderRuntime({
      providers: [probe],
      settings: { read: () => Effect.succeed(undefined) },
      credentials: {
        read: () => Effect.succeed(undefined),
        write: () => Effect.void,
        remove: () => Effect.void,
      },
      browserSessions: { cookieHeader: () => Effect.fail(new Error("not used")) },
      clock: { now: Effect.succeed(1), sleep: () => Effect.void },
      http: {
        execute: (request) => {
          requests.push(request);
          return Effect.succeed(response({ ok: true }));
        },
      },
    });
    await Effect.runPromise(runtime.fetch("openai", { sourceMode: "auto", includeCredits: false }));
    expect(requests.map((request) => request.url)).toEqual(["http://127.0.0.1:8088/healthz"]);
  });

  it("falls back to an injected secret when the keyring is unavailable, but not without one", async () => {
    const seen: string[] = [];
    const probe: FirstPartyProvider = {
      id: "ibmbob",
      kind: "api",
      descriptor: {
        id: "ibmbob",
        name: "Credential fallback probe",
        status: "partial",
        endpoints: [],
        auth: { type: "bearer", secret: "BOB_SECRET" },
        settings: [{ key: "BOB_SECRET", title: "Secret", type: "secure" }],
      },
      fetchUsage: async (context) => {
        seen.push(context.settings.getSecret("BOB_SECRET") ?? "missing");
        return { identity: { loginMethod: "probe" } };
      },
    };
    const keyringDown = () => Effect.fail(new InfrastructureError("keyring", "unavailable"));
    const make = (injected: string | undefined) =>
      makeFirstPartyProviderRuntime({
        providers: [probe],
        settings: { read: () => Effect.succeed(injected) },
        credentials: { read: keyringDown, write: () => Effect.void, remove: () => Effect.void },
        browserSessions: { cookieHeader: () => Effect.fail(new Error("not used")) },
        clock: { now: Effect.succeed(1), sleep: () => Effect.void },
        http: { execute: () => Effect.fail(new InfrastructureError("http", "not used")) },
      });
    await Effect.runPromise(
      make("injected-secret").fetch("ibmbob", { sourceMode: "auto", includeCredits: false }),
    );
    expect(seen).toContain("injected-secret");
    await expect(
      Effect.runPromise(
        make(undefined).fetch("ibmbob", { sourceMode: "auto", includeCredits: false }),
      ),
    ).rejects.toMatchObject({ kind: "api-failure" });
  });

  it("aborts an in-flight host HTTP effect when the provider fiber is interrupted", async () => {
    let aborted = false;
    const probe: FirstPartyProvider = {
      id: "ibmbob",
      kind: "api",
      descriptor: {
        id: "ibmbob",
        name: "Cancellation probe",
        status: "partial",
        endpoints: ["https://cancel.test"],
        settings: [],
      },
      fetchUsage: async (context) => {
        await context.http.get("https://cancel.test/usage");
        return { identity: { loginMethod: "probe" } };
      },
    };
    const runtime = makeFirstPartyProviderRuntime({
      providers: [probe],
      settings: { read: () => Effect.succeed(undefined) },
      credentials: {
        read: () => Effect.succeed(undefined),
        write: () => Effect.void,
        remove: () => Effect.void,
      },
      browserSessions: { cookieHeader: () => Effect.fail(new Error("not used")) },
      clock: { now: Effect.succeed(1), sleep: () => Effect.void },
      http: {
        execute: () =>
          Effect.tryPromise({
            try: async (signal) => {
              await new Promise<void>((_resolve, reject) => {
                signal.addEventListener(
                  "abort",
                  () => {
                    aborted = true;
                    reject(new Error("aborted"));
                  },
                  { once: true },
                );
              });
              return response({ identity: { loginMethod: "never" } });
            },
            catch: (error) => new InfrastructureError("HTTP request", "aborted", error),
          }),
      },
    });
    const fiber = await Effect.runPromise(
      runtime
        .fetch("ibmbob", { sourceMode: "auto", includeCredits: false })
        .pipe(Effect.forkDetach),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(aborted).toBe(true);
  });

  it("injects a validated IANA timezone into the shared provider context", async () => {
    const observed: string[] = [];
    const probe: FirstPartyProvider = {
      id: "openai.timezone-probe",
      kind: "api",
      descriptor: {
        id: "openai",
        name: "Timezone probe",
        status: "partial",
        endpoints: [],
        settings: [],
      },
      fetchUsage: async (context) => {
        observed.push(context.env.timeZone ?? "missing");
        return { identity: { loginMethod: "fixture" } };
      },
    };
    const run = (timeZone: string) =>
      Effect.runPromise(
        makeFirstPartyProviderRuntime({
          providers: [probe],
          settings: { read: () => Effect.succeed(undefined) },
          credentials: {
            read: () => Effect.succeed(undefined),
            write: () => Effect.void,
            remove: () => Effect.void,
          },
          browserSessions: { cookieHeader: () => Effect.fail(new Error("not used")) },
          http: { execute: () => Effect.fail(new InfrastructureError("test", "not used")) },
          clock: { now: Effect.succeed(1), sleep: () => Effect.void },
          timeZone,
        }).fetch("openai", { sourceMode: "auto", includeCredits: true }),
      );
    await run("America/Sao_Paulo");
    await run("Not/AZone");
    expect(observed).toEqual(["America/Sao_Paulo", "UTC"]);
  });

  it("bounds raw binary requests and responses before a provider can inspect them", async () => {
    const probe: FirstPartyProvider = {
      id: "ibmbob",
      kind: "api",
      descriptor: {
        id: "ibmbob",
        name: "Binary protocol probe",
        status: "partial",
        endpoints: ["https://binary.test"],
        settings: [],
      },
      fetchUsage: async (context) => {
        await context.http.postBinary!("https://binary.test/usage", {
          body: new Uint8Array([0, 1, 2]),
        });
        return { identity: { loginMethod: "probe" } };
      },
    };
    const runtime = makeFirstPartyProviderRuntime({
      providers: [probe],
      settings: { read: () => Effect.succeed(undefined) },
      credentials: {
        read: () => Effect.succeed(undefined),
        write: () => Effect.void,
        remove: () => Effect.void,
      },
      browserSessions: { cookieHeader: () => Effect.fail(new Error("not used")) },
      clock: { now: Effect.succeed(1), sleep: () => Effect.void },
      http: {
        execute: () =>
          Effect.succeed({
            status: 200,
            headers: {},
            body: new Uint8Array(1024 * 1024 + 1),
            url: "https://binary.test/usage",
          }),
      },
    });
    await expect(
      Effect.runPromise(runtime.fetch("ibmbob", { sourceMode: "api", includeCredits: false })),
    ).rejects.toMatchObject({ kind: "api-failure" });

    const oversizedRequest: FirstPartyProvider = {
      ...probe,
      fetchUsage: async (context) => {
        await context.http.postBinary!("https://binary.test/usage", {
          body: new Uint8Array(1024 * 1024 + 1),
        });
        return {};
      },
    };
    const requestRuntime = makeFirstPartyProviderRuntime({
      providers: [oversizedRequest],
      settings: { read: () => Effect.succeed(undefined) },
      credentials: {
        read: () => Effect.succeed(undefined),
        write: () => Effect.void,
        remove: () => Effect.void,
      },
      browserSessions: { cookieHeader: () => Effect.fail(new Error("not used")) },
      clock: { now: Effect.succeed(1), sleep: () => Effect.void },
      http: {
        execute: () =>
          Effect.fail(new InfrastructureError("http", "must not issue oversized request")),
      },
    });
    await expect(
      Effect.runPromise(
        requestRuntime.fetch("ibmbob", { sourceMode: "api", includeCredits: false }),
      ),
    ).rejects.toMatchObject({ kind: "api-failure" });
  });
});
