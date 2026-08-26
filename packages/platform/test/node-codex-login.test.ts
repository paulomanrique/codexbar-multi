import { mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { InfrastructureError, type ProcessRunnerService, type ProcessSpec } from "@codexbar/core";
import {
  cleanupStaleNodeCodexLoginHomes,
  nodeCodexLoginBaseEnvironment,
  runNodeCodexLogin,
} from "../src/node-codex-login.ts";

const jwt = (payload: unknown): string =>
  `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;

const successfulRunner = (
  authJson: string,
  inspect: (homeDirectory: string, spec: ProcessSpec) => void = () => undefined,
): ProcessRunnerService => ({
  run: (spec) =>
    Effect.tryPromise({
      try: async () => {
        const homeDirectory = spec.env?.CODEX_HOME;
        if (homeDirectory === undefined) throw new Error("missing CODEX_HOME");
        inspect(homeDirectory, spec);
        await writeFile(join(homeDirectory, "auth.json"), authJson, { mode: 0o600 });
        return {
          exitCode: 0,
          signal: undefined,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        };
      },
      catch: (error) => new InfrastructureError("run process", "failed", error),
    }),
});

describe("Node Codex account login", () => {
  it("keeps only the host allowlist in the login process environment", () => {
    expect(
      nodeCodexLoginBaseEnvironment({
        PATH: "/bin",
        HOME: "/home/person",
        NODE_OPTIONS: "--require=/malicious.js",
        OPENAI_API_KEY: "secret",
        CODEX_ACCESS_TOKEN: "secret",
      }),
    ).toEqual({ PATH: "/bin", HOME: "/home/person" });
  });

  it("reads a successful isolated login and removes the transient home", async () => {
    const root = await mkdtemp(join(tmpdir(), "codexbar-login-test-"));
    const idToken = jwt({
      email: "Person@Example.COM",
      "https://api.openai.com/auth": {
        chatgpt_account_id: "account-1",
        chatgpt_plan_type: "pro",
      },
    });
    let observedHome = "";
    let observedSpec: ProcessSpec | undefined;

    const result = await Effect.runPromise(
      runNodeCodexLogin({
        rootDirectory: root,
        createId: () => "operation-1",
        environment: {
          PATH: "/bin",
          HOME: "/home/person",
          OPENAI_API_KEY: "must-not-inherit",
          NODE_OPTIONS: "--require=/malicious.js",
        },
        restrictDirectory: async () => undefined,
        processRunner: successfulRunner(
          JSON.stringify({
            tokens: { access_token: "access-secret", id_token: idToken },
          }),
          (home, spec) => {
            observedHome = home;
            observedSpec = spec;
          },
        ),
      }),
    );

    expect(observedHome).toBe(join(root, "operation-1"));
    expect(observedSpec?.inheritEnvironment).toBe(false);
    expect(observedSpec?.env).toEqual({
      PATH: "/bin",
      HOME: "/home/person",
      CODEX_HOME: join(root, "operation-1"),
    });
    expect(result).toMatchObject({
      email: "person@example.com",
      plan: "pro",
      credential: { accessToken: "access-secret", accountId: "account-1" },
    });
    expect(result.credentialJson).toContain("access-secret");
    expect(await readdir(root)).toEqual([]);
  });

  it("fails closed for incomplete auth and still removes the transient home", async () => {
    const root = await mkdtemp(join(tmpdir(), "codexbar-login-test-"));

    await expect(
      Effect.runPromise(
        runNodeCodexLogin({
          rootDirectory: root,
          createId: () => "operation-2",
          restrictDirectory: async () => undefined,
          processRunner: successfulRunner(
            JSON.stringify({ tokens: { access_token: "access-without-identity" } }),
          ),
        }),
      ),
    ).rejects.toMatchObject({ operation: "run Codex login" });

    expect(await readdir(root)).toEqual([]);
  });

  it("cancels the login effect and removes its transient home", async () => {
    const root = await mkdtemp(join(tmpdir(), "codexbar-login-test-"));
    const controller = new AbortController();
    let started = false;
    const processRunner: ProcessRunnerService = {
      run: () =>
        Effect.sync(() => {
          started = true;
        }).pipe(Effect.flatMap(() => Effect.never)),
    };
    const login = Effect.runPromise(
      runNodeCodexLogin({
        rootDirectory: root,
        createId: () => "operation-cancelled",
        restrictDirectory: async () => undefined,
        processRunner,
      }),
      { signal: controller.signal },
    );
    while (!started) await new Promise((resolve) => setTimeout(resolve, 1));

    controller.abort();

    await expect(login).rejects.toBeDefined();
    expect(await readdir(root)).toEqual([]);
  });

  it("removes stale crash leftovers only inside the dedicated root", async () => {
    const root = await mkdtemp(join(tmpdir(), "codexbar-login-test-"));
    await mkdir(join(root, "stale-a"));
    await mkdir(join(root, "stale-b"));
    await writeFile(join(root, "unpublished-auth"), "secret");

    await Effect.runPromise(cleanupStaleNodeCodexLoginHomes(root));

    expect(await readdir(root)).toEqual([]);
  });
});
