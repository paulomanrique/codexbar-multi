import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { makeNodeFirstPartyLocalCapabilities, makeNodeProcessRunner } from "../src/node.ts";

describe("Node first-party local capabilities", () => {
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
});
