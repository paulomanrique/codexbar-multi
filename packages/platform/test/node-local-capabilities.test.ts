import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import {
  kiroStateDatabasePath,
  makeNodeFirstPartyLocalCapabilities,
  makeNodeProcessRunner,
} from "../src/node.ts";

describe("Node first-party local capabilities", () => {
  it("resolves Kiro CLI state per platform without accepting a provider path", () => {
    const environment = {};
    expect(kiroStateDatabasePath(environment, "/fixture/home", "darwin")).toBe(
      "/fixture/home/Library/Application Support/kiro-cli/data.sqlite3",
    );
    expect(kiroStateDatabasePath(environment, "/fixture/home", "linux")).toBe(
      "/fixture/home/.local/share/kiro-cli/data.sqlite3",
    );
    expect(kiroStateDatabasePath({ XDG_DATA_HOME: "/fixture/xdg" }, "/fixture/home", "linux")).toBe(
      "/fixture/xdg/kiro-cli/data.sqlite3",
    );
    expect(
      kiroStateDatabasePath({ KIRO_DATA_DIR: " /fixture/kiro " }, "/fixture/home", "darwin"),
    ).toBe("/fixture/kiro/data.sqlite3");
    expect(kiroStateDatabasePath({}, "C:\\Users\\fixture", "win32")).toBe(
      "C:\\Users\\fixture\\AppData\\Local\\Kiro-Cli\\data.sqlite3",
    );
    expect(
      kiroStateDatabasePath({ LOCALAPPDATA: "D:\\Kiro State" }, "C:\\Users\\fixture", "win32"),
    ).toBe("D:\\Kiro State\\Kiro-Cli\\data.sqlite3");
    expect(
      kiroStateDatabasePath({ KIRO_DATA_DIR: "E:\\override" }, "C:\\Users\\fixture", "win32"),
    ).toBe("E:\\override\\data.sqlite3");
  });

  it("reads Kiro's private state read-only and sends its token only to the fixed endpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "codexbar-kiro-state-"));
    const databasePath = join(root, "data.sqlite3");
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(
        "CREATE TABLE auth_kv (key TEXT, value TEXT); CREATE TABLE state (key TEXT, value TEXT);",
      );
      database
        .prepare("INSERT INTO auth_kv VALUES (?, ?)")
        .run("kirocli:odic:token", JSON.stringify({ access_token: "fixture-secret" }));
      database
        .prepare("INSERT INTO state VALUES (?, ?)")
        .run("api.codewhisperer.profile", JSON.stringify({ arn: "arn:fixture" }));
      database.close();
      const calls: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
      const local = makeNodeFirstPartyLocalCapabilities({
        environment: { KIRO_DATA_DIR: root },
        homeDirectory: "/not-used",
        fetchImpl: async (url, init) => {
          calls.push({ url: String(url), init });
          return new Response('{"usageBreakdownList":[]}', { status: 200 });
        },
      });
      const result = await Effect.runPromise(local.fetchKiroUsageLimits!("kiro"));
      expect(result).toEqual({ status: 200, bodyText: '{"usageBreakdownList":[]}' });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        url: "https://codewhisperer.us-east-1.amazonaws.com/",
        init: {
          method: "POST",
          headers: {
            "X-Amz-Target": "AmazonCodeWhispererService.GetUsageLimits",
            Authorization: "Bearer fixture-secret",
          },
          body: JSON.stringify({ profileArn: "arn:fixture" }),
        },
      });
      expect(JSON.stringify(result)).not.toContain("fixture-secret");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows only the named provider command and keeps arguments separate from a shell", async () => {
    const calls: unknown[] = [];
    const local = makeNodeFirstPartyLocalCapabilities({
      processRunner: {
        run: (spec) => {
          calls.push(spec);
          return Effect.succeed({
            exitCode: 0,
            signal: undefined,
            stdout: new TextEncoder().encode("ok"),
            stderr: new Uint8Array(),
          });
        },
      },
    });
    await Effect.runPromise(local.run("amp", "amp", { args: ["usage"], timeoutMs: 15_000 }));
    expect(calls).toMatchObject([{ command: "amp", args: ["usage"] }]);
    await expect(
      Effect.runPromise(local.run("amp", "kiro-cli", { args: [], timeoutMs: 1_000 })),
    ).rejects.toMatchObject({ operation: "local command" });
  });

  it("rejects a configured executable that is not an allowlisted path or binary name", async () => {
    const local = makeNodeFirstPartyLocalCapabilities({
      environment: { AMP_CLI_PATH: "amp; unexpected" },
      processRunner: {
        run: () => Effect.die("must not execute"),
      },
    });
    await expect(
      Effect.runPromise(local.run("amp", "amp", { args: ["usage"], timeoutMs: 15_000 })),
    ).rejects.toMatchObject({ operation: "local command" });
  });

  it("returns bounded Grok local activity only through the named diagnostic capability", async () => {
    const root = await mkdtemp(join(tmpdir(), "codexbar-grok-local-capability-"));
    const sessions = join(root, "sessions");
    try {
      await mkdir(join(sessions, "cwd", "session"), { recursive: true });
      await writeFile(
        join(sessions, "cwd", "session", "signals.json"),
        JSON.stringify({
          totalTokensBeforeCompaction: 12,
          contextTokensUsed: 8,
          primaryModelId: "grok-code",
        }),
      );
      const local = makeNodeFirstPartyLocalCapabilities({
        grokLocalSessionScan: { root: sessions },
      });
      await expect(Effect.runPromise(local.fetchGrokLocalSessionSummary!("grok"))).resolves.toEqual(
        {
          sessionCount: 1,
          totalTokens: 20,
          primaryModel: "grok-code",
          models: ["grok-code"],
          lastSessionAtMs: expect.any(Number),
        },
      );
      await expect(
        Effect.runPromise(local.fetchGrokLocalSessionSummary!("openai")),
      ).rejects.toMatchObject({ operation: "read Grok local sessions" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("discovers only known JetBrains quota files and rejects a path outside configured roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "codexbar-jetbrains-"));
    const base = join(root, "WebStorm2026.1");
    const quota = join(base, "options", "AIAssistantQuotaManager2.xml");
    try {
      await mkdir(join(base, "options"), { recursive: true });
      await writeFile(quota, '<component name="AIAssistantQuotaManager2"/>');
      const local = makeNodeFirstPartyLocalCapabilities({ jetBrainsRoots: [root] });
      await expect(
        Effect.runPromise(local.readData("jetbrains", "jetbrains-ai-quota")),
      ).resolves.toMatchObject({
        label: "WebStorm 2026.1",
        text: expect.stringContaining("component"),
      });
      await expect(
        Effect.runPromise(
          local.readData("jetbrains", "jetbrains-ai-quota", {
            basePath: join(tmpdir(), "outside"),
          }),
        ),
      ).rejects.toMatchObject({ operation: "read JetBrains quota" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a JetBrains quota reached through a symbolic link", async () => {
    const root = await mkdtemp(join(tmpdir(), "codexbar-jetbrains-root-"));
    const outside = await mkdtemp(join(tmpdir(), "codexbar-jetbrains-outside-"));
    const base = join(root, "WebStorm2026.1");
    try {
      await mkdir(base, { recursive: true });
      await mkdir(join(outside, "options"), { recursive: true });
      await writeFile(
        join(outside, "options", "AIAssistantQuotaManager2.xml"),
        '<component name="AIAssistantQuotaManager2"/>',
      );
      await symlink(join(outside, "options"), join(base, "options"), "dir");
      const local = makeNodeFirstPartyLocalCapabilities({ jetBrainsRoots: [root] });

      await expect(
        Effect.runPromise(local.readData("jetbrains", "jetbrains-ai-quota", { basePath: base })),
      ).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses an IDE directory whose parent escapes the configured root through a symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "codexbar-jetbrains-root-"));
    const outside = await mkdtemp(join(tmpdir(), "codexbar-jetbrains-outside-"));
    const outsideBase = join(outside, "WebStorm2026.1");
    const escapedBase = join(root, "linked", "WebStorm2026.1");
    try {
      await mkdir(join(outsideBase, "options"), { recursive: true });
      await writeFile(
        join(outsideBase, "options", "AIAssistantQuotaManager2.xml"),
        '<component name="AIAssistantQuotaManager2"/>',
      );
      await symlink(outside, join(root, "linked"), "dir");
      const local = makeNodeFirstPartyLocalCapabilities({ jetBrainsRoots: [root] });

      await expect(
        Effect.runPromise(
          local.readData("jetbrains", "jetbrains-ai-quota", { basePath: escapedBase }),
        ),
      ).rejects.toMatchObject({ operation: "read JetBrains quota" });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("cancels a spawned process before it can produce a delayed side effect", async () => {
    const root = await mkdtemp(join(tmpdir(), "codexbar-process-cancel-"));
    const marker = join(root, "marker");
    const runner = makeNodeProcessRunner();
    try {
      await expect(
        Effect.runPromise(
          runner.run({
            command: process.execPath,
            args: [
              "-e",
              `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x'), 150)`,
            ],
            timeoutMs: 1_000,
          }),
          { signal: AbortSignal.timeout(20) },
        ),
      ).rejects.toBeDefined();
      await new Promise((resolve) => setTimeout(resolve, 220));
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses an explicitly sanitized base environment when requested by a host", async () => {
    const runner = makeNodeProcessRunner({
      environment: { CODEXBAR_SAFE_BASE: "visible", PROVIDER_SECRET: undefined },
    });
    const result = await Effect.runPromise(
      runner.run({
        command: process.execPath,
        args: [
          "-e",
          "process.stdout.write(JSON.stringify({safe:process.env.CODEXBAR_SAFE_BASE,event:process.env.CODEXBAR_EVENT,secret:process.env.PROVIDER_SECRET}))",
        ],
        env: { CODEXBAR_EVENT: "quota_reached" },
      }),
    );
    expect(JSON.parse(new TextDecoder().decode(result.stdout))).toEqual({
      safe: "visible",
      event: "quota_reached",
    });
  });
});
