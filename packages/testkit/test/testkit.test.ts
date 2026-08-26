import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vite-plus/test";
import {
  mapProviderSnapshot,
  moonshot,
  qwencloud,
  resolveMoonshotAPIKey,
  resolveMoonshotRegion,
} from "@codexbar/providers";
import {
  compareWithOracle,
  OFFLINE_SWIFT_ORACLE_CASES,
  jsonParityEqual,
  normalizeJson,
  normalizeJsonText,
  normalizeUsageSnapshotJson,
  runSwiftOracle,
  runOfflineSwiftOracleParity,
  usageSnapshotParityEqual,
  validateFixtureManifest,
  type FixtureManifest,
  type OracleExecutor,
} from "../src/index.ts";

const executeFile = promisify(execFile);

const baselineCommit = "453174fe13eebdf403cc0776268eb2b101fd9553";
type ProviderContext = Parameters<typeof qwencloud.fetchUsage>[0];
type ProviderResponse = Awaited<ReturnType<ProviderContext["http"]["get"]>>;
type Request = {
  readonly method: "GET" | "POST";
  readonly url: URL;
  readonly options?: Record<string, unknown>;
};

const providerResponse = (json: unknown): ProviderResponse => ({
  status: 200,
  bodyText: JSON.stringify(json),
});
const providerContext = (
  callback: (request: Request) => ProviderResponse,
  settings: Readonly<Record<string, string>> = { QWEN_CLOUD_COOKIE: "sid=fixture" },
): ProviderContext => {
  const request = async (
    method: "GET" | "POST",
    url: string,
    options?: Record<string, unknown>,
  ) => {
    const entry: Request = {
      method,
      url: new URL(url),
      ...(options === undefined ? {} : { options }),
    };
    return callback(entry);
  };
  const failure = (kind: string) => (message: string) => new Error(`${kind}: ${message}`);
  return {
    settings: {
      get: (key) => settings[key],
      getSecret: (key) => settings[key],
    },
    http: {
      get: (url, options) => request("GET", url, options),
      getJSON: async (url, options) => {
        const result = await request("GET", url, options);
        return { ...result, json: JSON.parse(result.bodyText) as unknown };
      },
      postJSON: async (url, options) => {
        const result = await request("POST", url, options);
        return { ...result, json: JSON.parse(result.bodyText) as unknown };
      },
    },
    browser: { cookieHeader: async () => "" },
    env: { timeZone: "UTC" },
    date: {
      now: () => new Date("2026-08-20T12:00:00.000Z"),
      nowMillis: () => Date.parse("2026-08-20T12:00:00.000Z"),
      iso: (value) => new Date(value).toISOString(),
      unixSeconds: (value) => new Date(value * 1_000).toISOString(),
      unixMillis: (value) => new Date(value).toISOString(),
      nextDailyReset: () => "2026-08-21T00:00:00.000Z",
    },
    format: {
      number: (value, options) =>
        new Intl.NumberFormat("en-US", options as Intl.NumberFormatOptions).format(value),
      usd: (value) => `$${value.toFixed(2)}`,
      monthDay: (value) => value.toISOString().slice(5, 10),
    },
    pct: (used, limit) => (used / limit) * 100,
    amountFromPercent: (usedPercent, total) => (usedPercent / 100) * total,
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

async function temporaryOracleCheckout(): Promise<{
  readonly root: string;
  readonly executable: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "codexbar-oracle-test-"));
  const executable = join(root, ".build", "debug", "CodexBarOracle");
  await mkdir(join(root, "upstream"), { recursive: true });
  await mkdir(join(root, ".build", "debug"), { recursive: true });
  await writeFile(
    join(root, "upstream", "baseline.json"),
    JSON.stringify({ codexBar: { commit: baselineCommit } }),
  );
  await writeFile(executable, "fixture executable");
  await chmod(executable, 0o700);
  return { root, executable };
}

async function qwenCloudFlatFixture(): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(
      new URL(
        "../../../Tests/CodexBarTests/Fixtures/QwenCloud/flat_subscription_summary.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as Record<string, unknown>;
}

async function qwenCloudFlatSnapshot(): Promise<Record<string, unknown>> {
  const fixture = await qwenCloudFlatFixture();
  return qwencloud.fetchUsage(
    providerContext((request) => {
      if (request.method === "GET") return providerResponse("no token needed by fixture");
      return providerResponse(fixture);
    }),
  );
}

async function moonshotBalanceSnapshot() {
  const fixture = JSON.parse(
    await readFile(
      new URL(
        "../../../Tests/CodexBarTests/Fixtures/Providers/Moonshot/balance-deficit.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as unknown;
  const raw = await moonshot.fetchUsage(
    providerContext(() => providerResponse(fixture), { MOONSHOT_API_KEY: "fixture-token" }),
  );
  return normalizeUsageSnapshotJson(
    mapProviderSnapshot(raw, "moonshot", new Date("2023-11-14T22:13:20Z")),
  );
}

async function moonshotSettingsResults() {
  const fixture = JSON.parse(
    await readFile(
      new URL(
        "../../../Tests/CodexBarTests/Fixtures/Providers/Moonshot/settings-cases.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as {
    readonly cases: readonly {
      readonly id: string;
      readonly environment: Readonly<Record<string, string>>;
      readonly requestedRegion: string;
    }[];
  };
  return {
    cases: fixture.cases.map((entry) => {
      if (entry.requestedRegion !== "international" && entry.requestedRegion !== "china") {
        throw new Error("Moonshot settings fixture contains an invalid requested region");
      }
      const settings = {
        get: (key: string) => entry.environment[key],
        getSecret: (key: string) => entry.environment[key],
      };
      const resolvedMarker = resolveMoonshotAPIKey(settings, entry.requestedRegion);
      return {
        id: entry.id,
        detectedRegion: resolveMoonshotRegion(settings),
        ...(resolvedMarker === undefined ? {} : { resolvedMarker }),
      };
    }),
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

describe("parity testkit", () => {
  it("sorts keys and can redact secret-shaped fields", () => {
    expect(normalizeJsonText('{"b":2,"apiKey":"x","a":1}', { redactSecrets: true })).toBe(
      '{"a":1,"apiKey":"[REDACTED]","b":2}',
    );
    expect(jsonParityEqual({ b: 2, a: 1 }, { a: 1, b: 2 })).toBe(true);
  });

  it("rejects fixture manifests that enable network or credentials", () => {
    expect(() =>
      validateFixtureManifest({
        version: 1,
        baseline: { repository: "x", commit: "y" },
        entries: [],
        policy: {
          allowNetwork: false,
          allowCredentials: false,
          requiredShape: "provider-response",
        },
      }),
    ).not.toThrow();
  });

  it("validates the checked-in upstream fixture inventory", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../../../upstream/fixtures.manifest.json", import.meta.url), "utf8"),
    ) as FixtureManifest;
    expect(() => validateFixtureManifest(manifest)).not.toThrow();
    expect(manifest.oracleCases?.map((oracleCase) => oracleCase.id).sort()).toEqual(
      [...OFFLINE_SWIFT_ORACLE_CASES].sort(),
    );
  });

  it("normalizes and redacts Swift oracle output before comparison", async () => {
    const oracle = await runSwiftOracle(
      { executable: "swift-oracle", args: ["usage", "--json"] },
      async () => ({ stdout: '{"used":12,"accessToken":"secret"}', stderr: "" }),
    );
    expect(compareWithOracle(oracle, { accessToken: "different", used: 12 })).toMatchObject({
      equal: true,
      oracle: { accessToken: "[REDACTED]", used: 12 },
    });
  });

  it("rejects trailing non-JSON oracle output", async () => {
    await expect(
      runSwiftOracle({ executable: "swift-oracle", args: ["usage"] }, async () => ({
        stdout: '{"ok":true} trailing',
        stderr: "",
      })),
    ).rejects.toThrow("valid bounded JSON");
  });

  it("runs the fixed offline oracle protocol with a scrubbed environment and machine-readable comparison", async () => {
    const checkout = await temporaryOracleCheckout();
    try {
      let received: import("../src/oracle.ts").SwiftOracleRequest | undefined;
      const result = await runOfflineSwiftOracleParity(
        {
          repositoryRoot: checkout.root,
          executable: checkout.executable,
          oracleCase: "snapshot-serialization",
        },
        { primary: null, updatedAt: "2026-08-02T12:00:00Z" },
        async (request) => {
          received = request;
          return { stdout: '{"updatedAt":"2026-08-02T12:00:00Z","primary":null}', stderr: "" };
        },
      );
      expect(result).toMatchObject({
        baselineCommit,
        oracleCase: "snapshot-serialization",
        comparison: { equal: true },
      });
      expect(received).toMatchObject({ args: ["snapshot-serialization"] });
      expect(received?.environment).toMatchObject({
        CODEXBAR_ORACLE_ROOT: checkout.root,
        CODEXBAR_ORACLE_NETWORK: "0",
        CODEXBAR_ORACLE_CREDENTIALS: "0",
        NO_PROXY: "*",
      });
      expect(received?.environment).not.toHaveProperty("AWS_ACCESS_KEY_ID");
    } finally {
      await rm(checkout.root, { recursive: true, force: true });
    }
  });

  it("rejects an oracle baseline mismatch and symlinked executable before it can run", async () => {
    const checkout = await temporaryOracleCheckout();
    try {
      await writeFile(
        join(checkout.root, "upstream", "baseline.json"),
        JSON.stringify({ codexBar: { commit: "wrong" } }),
      );
      await expect(
        runOfflineSwiftOracleParity(
          {
            repositoryRoot: checkout.root,
            executable: checkout.executable,
            oracleCase: "snapshot-serialization",
          },
          {},
        ),
      ).rejects.toThrow("baseline");

      await writeFile(
        join(checkout.root, "upstream", "baseline.json"),
        JSON.stringify({ codexBar: { commit: baselineCommit } }),
      );
      const external = join(tmpdir(), `codexbar-oracle-external-${Date.now()}`);
      await writeFile(external, "external executable");
      await symlink(external, join(checkout.root, ".build", "debug", "outside"));
      await expect(
        runOfflineSwiftOracleParity(
          {
            repositoryRoot: checkout.root,
            executable: join(checkout.root, ".build", "debug", "outside"),
            oracleCase: "snapshot-serialization",
          },
          {},
        ),
      ).rejects.toThrow("escapes");
      await rm(external, { force: true });

      if (process.platform !== "win32") {
        await chmod(checkout.executable, 0o600);
        await expect(
          runOfflineSwiftOracleParity(
            {
              repositoryRoot: checkout.root,
              executable: checkout.executable,
              oracleCase: "snapshot-serialization",
            },
            {},
          ),
        ).rejects.toThrow("not executable");
      }
    } finally {
      await rm(checkout.root, { recursive: true, force: true });
    }
  });

  it("proves the Qwen Cloud flat-subscription fixture reaches the shared TypeScript provider without network access", async () => {
    const typescript = await qwenCloudFlatSnapshot();
    // This is the TypeScript half of the fixed fixture-only oracle case. The legacy fallback
    // spelling intentionally matches AlibabaTokenPlanUsageFetcher in the Swift oracle.
    expect(typescript).toMatchObject({
      primary: {
        usedPercent: 25,
        windowMinutes: 43_200,
        resetDescription: "500 / 2,000 credits used",
      },
      identity: { loginMethod: "TOKEN PLAN" },
    });
  });

  it("proves the Moonshot deficit fixture reaches the shared TypeScript provider without network access", async () => {
    await expect(moonshotBalanceSnapshot()).resolves.toMatchObject({
      identity: {
        providerID: "moonshot",
        loginMethod: "Balance: $49.58 · $0.42 in deficit",
      },
    });
  });

  it("proves the Moonshot settings fixture reaches the shared resolver without credentials", async () => {
    await expect(moonshotSettingsResults()).resolves.toEqual({
      cases: [
        {
          id: "primary-precedence",
          detectedRegion: "international",
          resolvedMarker: "primary-marker",
        },
        {
          id: "quoted-fallback",
          detectedRegion: "international",
          resolvedMarker: "quoted-marker",
        },
        { id: "region-bound-config", detectedRegion: "china", resolvedMarker: "config-marker" },
        { id: "mismatched-config", detectedRegion: "international" },
        { id: "mismatched-environment-region", detectedRegion: "china" },
        {
          id: "quote-order-defaults-international",
          detectedRegion: "international",
          resolvedMarker: "fallback-marker",
        },
      ],
    });
  });

  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const builtOracle = join(repositoryRoot, ".build", "debug", "CodexBarOracle");
  const builtOracleRunnable =
    existsSync(builtOracle) &&
    spawnSync(builtOracle, ["snapshot-serialization"], {
      cwd: repositoryRoot,
      env: {
        PATH: "",
        HOME: tmpdir(),
        TMPDIR: tmpdir(),
        LANG: "C",
        LC_ALL: "C",
        NO_PROXY: "*",
        no_proxy: "*",
        http_proxy: "",
        https_proxy: "",
        HTTP_PROXY: "",
        HTTPS_PROXY: "",
        CODEXBAR_ORACLE_ROOT: repositoryRoot,
        CODEXBAR_ORACLE_NETWORK: "0",
        CODEXBAR_ORACLE_CREDENTIALS: "0",
      },
      stdio: "ignore",
    }).status === 0;
  const oracleContainerImage = process.env.CODEXBAR_SWIFT_ORACLE_CONTAINER_IMAGE;
  if (
    oracleContainerImage !== undefined &&
    !/^swift@sha256:[0-9a-f]{64}$/u.test(oracleContainerImage)
  ) {
    throw new Error("CODEXBAR_SWIFT_ORACLE_CONTAINER_IMAGE must pin an exact Swift image digest");
  }
  const containerOracleExecutor: OracleExecutor | undefined =
    !builtOracleRunnable && oracleContainerImage !== undefined && existsSync(builtOracle)
      ? async (request) => {
          if (request.cwd === undefined) throw new Error("Container oracle requires a fixed cwd");
          const executable = `/oracle/${relative(request.cwd, request.executable)}`;
          const environment = {
            ...request.environment,
            CODEXBAR_ORACLE_ROOT: "/oracle",
            HOME: "/tmp",
            TMPDIR: "/tmp",
          };
          const args = [
            "run",
            "--rm",
            "--network",
            "none",
            "--read-only",
            "--cap-drop=ALL",
            "--security-opt=no-new-privileges",
            "--pids-limit=64",
            "--memory=512m",
            "--tmpfs",
            "/tmp:rw,noexec,nosuid,size=16m",
            "-v",
            `${request.cwd}:/oracle:ro`,
            "-w",
            "/oracle",
          ];
          for (const [key, value] of Object.entries(environment)) {
            args.push("-e", `${key}=${value}`);
          }
          args.push(oracleContainerImage, executable, ...request.args);
          const result = await executeFile("docker", args, {
            timeout: request.timeoutMs,
            maxBuffer: 1024 * 1024,
            encoding: "utf8",
          });
          return { stdout: result.stdout, stderr: result.stderr };
        }
      : undefined;
  const compareWithBuiltOracle = (
    oracleCase: Parameters<typeof runOfflineSwiftOracleParity>[0]["oracleCase"],
    typescript: unknown,
  ) =>
    containerOracleExecutor === undefined
      ? runOfflineSwiftOracleParity(
          { repositoryRoot, executable: builtOracle, oracleCase },
          typescript,
        )
      : runOfflineSwiftOracleParity(
          { repositoryRoot, executable: builtOracle, oracleCase },
          typescript,
          containerOracleExecutor,
        );
  it.skipIf(!builtOracleRunnable && containerOracleExecutor === undefined)(
    "executes the prebuilt Swift snapshot, Qwen, and Moonshot fixture oracles without credentials or network",
    async () => {
      const snapshotFixture = JSON.parse(
        await readFile(
          new URL(
            "../../../Tests/CodexBarTests/Fixtures/usage-snapshot-current.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ) as unknown;
      const snapshot = await compareWithBuiltOracle(
        "snapshot-serialization",
        normalizeUsageSnapshotJson(snapshotFixture),
      );
      expect(snapshot.comparison.equal).toBe(true);

      const qwenProviderOutput = await qwenCloudFlatSnapshot();
      const qwenSnapshot = normalizeUsageSnapshotJson({
        ...qwenProviderOutput,
        primary: qwenProviderOutput.primary,
        secondary: null,
        tertiary: null,
        updatedAt: "2023-11-14T22:13:20Z",
        identity: { providerID: "qwencloud", ...objectValue(qwenProviderOutput.identity) },
      });
      const qwen = await compareWithBuiltOracle("qwencloud-flat-subscription", qwenSnapshot);
      expect(qwen.comparison.equal).toBe(true);
      expect(qwen.comparison.oracle).toMatchObject({
        identity: { loginMethod: "TOKEN PLAN" },
      });
      expect(qwen.comparison.typescript).toMatchObject({
        identity: { loginMethod: "TOKEN PLAN" },
      });

      const moonshotSnapshot = await moonshotBalanceSnapshot();
      const moonshotResult = await compareWithBuiltOracle("moonshot-balance", moonshotSnapshot);
      expect(moonshotResult.comparison.equal).toBe(true);
      expect(moonshotResult.comparison.oracle).toMatchObject({
        identity: { providerID: "moonshot", loginMethod: "Balance: $49.58 · $0.42 in deficit" },
      });

      const moonshotSettings = await compareWithBuiltOracle(
        "moonshot-settings",
        await moonshotSettingsResults(),
      );
      expect(moonshotSettings.comparison.equal).toBe(true);
    },
  );

  it("matches the checked-in Swift UsageSnapshot fixture byte-for-byte after canonicalization", async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL(
          "../../../Tests/CodexBarTests/Fixtures/usage-snapshot-current.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as unknown;

    const fixtureObject = fixture as {
      primary: Record<string, unknown>;
    } & Record<string, unknown>;
    const { resetDescription: _omittedResetDescription, ...canonicalPrimary } =
      fixtureObject.primary;
    const expectedCanonical = normalizeJson({
      ...fixtureObject,
      primary: canonicalPrimary,
    });
    expect(normalizeUsageSnapshotJson(fixture)).toEqual(expectedCanonical);
    expect(
      usageSnapshotParityEqual(fixture, {
        ...fixtureObject,
        primary: {
          ...fixtureObject.primary,
          resetsAt: "2026-08-02T17:00:00.000Z",
        },
      }),
    ).toBe(true);
  });
});
