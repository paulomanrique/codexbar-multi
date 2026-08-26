import { chmod, mkdtemp, mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { InfrastructureError, type ProcessRunnerService, type ProcessSpec } from "@codexbar/core";
import {
  cleanupStaleNodeCodexLoginHomes,
  nodeCodexLoginExecutableCandidates,
  nodeCodexLoginBaseEnvironment,
  resolveNodeCodexLoginExecutable,
  runNodeCodexLogin,
  verifyNodeCodexLoginExecutable,
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

  it("resolves an explicit bounded executable path before login", async () => {
    const root = await mkdtemp(join(tmpdir(), "codexbar-login-test-"));
    const executable = join(root, "codex");
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o700);

    await expect(resolveNodeCodexLoginExecutable({ CODEX_CLI_PATH: executable })).resolves.toBe(
      executable,
    );
    await expect(
      resolveNodeCodexLoginExecutable({ CODEX_CLI_PATH: "relative/codex" }),
    ).resolves.toBeUndefined();
  });

  it("discovers native Windows npm and standalone binaries without shell shims", () => {
    const candidates = nodeCodexLoginExecutableCandidates(
      {
        PATH: "C:\\Users\\Person\\AppData\\Roaming\\npm;C:\\Tools",
        APPDATA: "C:\\Users\\Person\\AppData\\Roaming",
        USERPROFILE: "C:\\Users\\Person",
        LOCALAPPDATA: "C:\\Users\\Person\\AppData\\Local",
      },
      "win32",
      "x64",
    );

    expect(candidates).toContain("C:\\Tools\\codex.exe");
    expect(candidates).toContain(
      "C:\\Users\\Person\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe",
    );
    expect(candidates).toContain(
      "C:\\Users\\Person\\.codex\\packages\\standalone\\current\\bin\\codex.exe",
    );
    expect(candidates).toContain(
      "C:\\Users\\Person\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe",
    );
    expect(
      candidates.indexOf(
        "C:\\Users\\Person\\.codex\\packages\\standalone\\current\\bin\\codex.exe",
      ),
    ).toBeLessThan(candidates.indexOf("C:\\Tools\\codex.exe"));
    expect(candidates.every((candidate) => !/\.(?:cmd|bat|ps1)$/iu.test(candidate))).toBe(true);
  });

  it("probes a candidate with a scrubbed bounded version command", async () => {
    let observed: ProcessSpec | undefined;
    const runner: ProcessRunnerService = {
      run: (spec) => {
        observed = spec;
        return Effect.succeed({
          exitCode: 0,
          signal: undefined,
          stdout: new Uint8Array(Buffer.from("codex-cli 1.2.3\n")),
          stderr: new Uint8Array(),
        });
      },
    };

    await expect(
      Effect.runPromise(
        verifyNodeCodexLoginExecutable("/usr/bin/codex", runner, {
          PATH: "/usr/bin",
          OPENAI_API_KEY: "must-not-inherit",
          NODE_OPTIONS: "--require=malicious.js",
        }),
      ),
    ).resolves.toBe(true);
    expect(observed).toEqual({
      command: "/usr/bin/codex",
      args: ["--version"],
      env: { PATH: "/usr/bin" },
      inheritEnvironment: false,
      timeoutMs: 5_000,
    });
  });

  it("skips a native candidate that fails the host probe", async () => {
    const root = await mkdtemp(join(tmpdir(), "codexbar-login-test-"));
    const firstRoot = join(root, "first");
    const secondRoot = join(root, "second");
    await mkdir(firstRoot);
    await mkdir(secondRoot);
    const first = join(firstRoot, "codex");
    const second = join(secondRoot, "codex");
    await writeFile(first, "#!/bin/sh\nexit 0\n");
    await writeFile(second, "#!/bin/sh\nexit 0\n");
    await chmod(first, 0o700);
    await chmod(second, 0o700);

    await expect(
      resolveNodeCodexLoginExecutable(
        { PATH: `${firstRoot}${delimiter}${secondRoot}` },
        { verify: async (candidate) => candidate === second },
      ),
    ).resolves.toBe(second);
  });

  it("stops candidate iteration when login is cancelled during a probe", async () => {
    const root = await mkdtemp(join(tmpdir(), "codexbar-login-test-"));
    const firstRoot = join(root, "first");
    const secondRoot = join(root, "second");
    await mkdir(firstRoot);
    await mkdir(secondRoot);
    for (const directory of [firstRoot, secondRoot]) {
      const executable = join(directory, "codex");
      await writeFile(executable, "#!/bin/sh\nexit 0\n");
      await chmod(executable, 0o700);
    }
    let cancelled = false;
    let probes = 0;

    await expect(
      resolveNodeCodexLoginExecutable(
        { PATH: `${firstRoot}${delimiter}${secondRoot}` },
        {
          cancelled: () => cancelled,
          verify: async () => {
            probes += 1;
            cancelled = true;
            return false;
          },
        },
      ),
    ).resolves.toBeUndefined();
    expect(probes).toBe(1);
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
        command: process.execPath,
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
            tokens: {
              access_token: "access-secret",
              refresh_token: "refresh-secret",
              id_token: idToken,
            },
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
    expect(observedSpec?.args).toEqual(["login"]);
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
          command: process.execPath,
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

  it("rejects an oversized auth file and still removes the transient home", async () => {
    const root = await mkdtemp(join(tmpdir(), "codexbar-login-test-"));

    await expect(
      Effect.runPromise(
        runNodeCodexLogin({
          rootDirectory: root,
          command: process.execPath,
          createId: () => "operation-oversized",
          restrictDirectory: async () => undefined,
          processRunner: successfulRunner("x".repeat(1024 * 1024 + 1)),
        }),
      ),
    ).rejects.toMatchObject({ operation: "run Codex login" });

    expect(await readdir(root)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    "rejects a symlinked auth file without reading its target",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "codexbar-login-test-"));
      const target = join(root, "outside-auth.json");
      await writeFile(target, JSON.stringify({ tokens: { access_token: "outside-secret" } }));
      const processRunner: ProcessRunnerService = {
        run: (spec) =>
          Effect.tryPromise({
            try: async () => {
              const home = spec.env?.CODEX_HOME;
              if (home === undefined) throw new Error("missing CODEX_HOME");
              await symlink(target, join(home, "auth.json"));
              return {
                exitCode: 0,
                signal: undefined,
                stdout: new Uint8Array(),
                stderr: new Uint8Array(),
              };
            },
            catch: (error) => new InfrastructureError("run process", "failed", error),
          }),
      };

      await expect(
        Effect.runPromise(
          runNodeCodexLogin({
            rootDirectory: root,
            command: process.execPath,
            createId: () => "operation-symlink",
            restrictDirectory: async () => undefined,
            processRunner,
          }),
        ),
      ).rejects.toMatchObject({ operation: "run Codex login" });

      expect(await readdir(root)).toEqual(["outside-auth.json"]);
    },
  );

  it("cleans up after a non-zero process exit", async () => {
    const root = await mkdtemp(join(tmpdir(), "codexbar-login-test-"));
    const processRunner: ProcessRunnerService = {
      run: () =>
        Effect.succeed({
          exitCode: 1,
          signal: undefined,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(Buffer.from("provider output must stay private")),
        }),
    };

    await expect(
      Effect.runPromise(
        runNodeCodexLogin({
          rootDirectory: root,
          command: process.execPath,
          createId: () => "operation-failed",
          restrictDirectory: async () => undefined,
          processRunner,
        }),
      ),
    ).rejects.toMatchObject({
      operation: "run Codex login",
      message: expect.not.stringContaining("provider output"),
    });
    expect(await readdir(root)).toEqual([]);
  });

  it("rejects caller-controlled operation paths before creating a home", async () => {
    const root = await mkdtemp(join(tmpdir(), "codexbar-login-test-"));

    await expect(
      Effect.runPromise(
        runNodeCodexLogin({
          rootDirectory: root,
          command: process.execPath,
          createId: () => "../escape",
          restrictDirectory: async () => undefined,
          processRunner: successfulRunner("{}"),
        }),
      ),
    ).rejects.toMatchObject({ operation: "create Codex login home" });
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
        command: process.execPath,
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
    await mkdir(join(root, "not an operation"));

    await Effect.runPromise(cleanupStaleNodeCodexLoginHomes(root));

    expect((await readdir(root)).sort()).toEqual(["not an operation", "unpublished-auth"]);
  });

  it.skipIf(process.platform === "win32")(
    "refuses to clean through a symlinked login root",
    async () => {
      const parent = await mkdtemp(join(tmpdir(), "codexbar-login-test-"));
      const target = join(parent, "target");
      const root = join(parent, "codex-login");
      await mkdir(target);
      await mkdir(join(target, "operation-1"));
      await symlink(target, root);

      await expect(Effect.runPromise(cleanupStaleNodeCodexLoginHomes(root))).rejects.toMatchObject({
        operation: "clean up stale Codex login homes",
      });
      expect(await readdir(target)).toEqual(["operation-1"]);
    },
  );
});
