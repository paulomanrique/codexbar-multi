import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import type { ProcessResult, ProcessRunnerService, ProcessSpec } from "@codexbar/core";
import {
  classifyBedrockAwsExportError,
  nodeBedrockAwsEnvironment,
  nodeBedrockAwsPathCandidates,
  nodeBedrockAwsWellKnownPaths,
  resolveNodeBedrockAwsCliPath,
  runNodeBedrockAwsCredentials,
} from "../src/node-bedrock-aws.ts";

const result = (stdout: string, exitCode = 0, stderr = ""): ProcessResult => ({
  exitCode,
  signal: undefined,
  stdout: new TextEncoder().encode(stdout),
  stderr: new TextEncoder().encode(stderr),
});

const runner = (calls: ProcessSpec[]): ProcessRunnerService => ({
  run: (spec) =>
    Effect.sync(() => {
      calls.push(spec);
      return spec.args?.includes("export-credentials")
        ? result(
            '{"Version":1,"AccessKeyId":"AKIAPROFILE","SecretAccessKey":"profile-secret","SessionToken":"profile-token"}',
          )
        : result("ap-southeast-2\n");
    }),
});

describe("Node Bedrock AWS CLI adapter", () => {
  it("discovers configured, well-known, and bounded PATH AWS CLI candidates", async () => {
    expect(nodeBedrockAwsWellKnownPaths("/fixture/home")).toContain("/usr/bin/aws");
    expect(nodeBedrockAwsPathCandidates("/bin:/usr/bin:relative", "linux")).toEqual([
      "/bin/aws",
      "/usr/bin/aws",
    ]);
    expect(nodeBedrockAwsPathCandidates("C:\\Tools;relative", "win32")).toEqual([
      "C:\\Tools\\aws.exe",
    ]);
    await expect(
      resolveNodeBedrockAwsCliPath({
        environment: { PATH: "/missing:/usr/bin" },
        homeDirectory: "/fixture/home",
        exists: async (path) => path === "/usr/bin/aws",
      }),
    ).resolves.toBe("/usr/bin/aws");
    await expect(
      resolveNodeBedrockAwsCliPath({
        environment: { AWS_CLI_PATH: "/missing/aws", PATH: "/usr/bin" },
        homeDirectory: "/fixture/home",
        exists: async (path) => path === "/usr/bin/aws",
      }),
    ).resolves.toBe("/usr/bin/aws");
  });

  it("skips directories and non-executable POSIX candidates", async () => {
    const root = await mkdtemp(join(tmpdir(), "codexbar-bedrock-cli-"));
    try {
      const directoryCandidate = join(root, "directory-aws");
      const fallback = join(root, "aws");
      await mkdir(directoryCandidate);

      await expect(
        resolveNodeBedrockAwsCliPath({
          environment: { AWS_CLI_PATH: directoryCandidate, PATH: root },
          homeDirectory: root,
          platform: "linux",
        }),
      ).resolves.toBeUndefined();

      await writeFile(fallback, "#!/bin/sh\n", { mode: 0o700 });
      await expect(
        resolveNodeBedrockAwsCliPath({
          environment: { AWS_CLI_PATH: directoryCandidate, PATH: root },
          homeDirectory: root,
          platform: "linux",
        }),
      ).resolves.toBe(fallback);

      if (process.platform !== "win32") {
        await chmod(fallback, 0o600);
        await expect(
          resolveNodeBedrockAwsCliPath({
            environment: { AWS_CLI_PATH: directoryCandidate, PATH: root },
            homeDirectory: root,
            platform: "linux",
          }),
        ).resolves.toBeUndefined();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves Swift profile environment semantics and accepts only the Bedrock source DTO", async () => {
    const environment = nodeBedrockAwsEnvironment(
      {
        AWS_PROFILE: "wrong-profile",
        AWS_ACCESS_KEY_ID: "ambient-access",
        AWS_SECRET_ACCESS_KEY: "ambient-secret",
        AWS_SESSION_TOKEN: "ambient-session",
        AWS_REGION: "ambient-region",
        PATH: "/usr/bin",
      },
      {
        region: "eu-west-1",
        defaultRegion: "eu-west-1",
        ...({ EVIL: "must-not-reach-runner" } as object),
      } as never,
    );
    expect(environment).toMatchObject({
      AWS_ACCESS_KEY_ID: "ambient-access",
      AWS_SECRET_ACCESS_KEY: "ambient-secret",
      AWS_SESSION_TOKEN: "ambient-session",
      AWS_REGION: "eu-west-1",
      AWS_DEFAULT_REGION: "eu-west-1",
    });
    expect(environment.AWS_PROFILE).toBeUndefined();
    expect(environment.EVIL).toBeUndefined();

    const calls: ProcessSpec[] = [];
    await expect(
      runNodeBedrockAwsCredentials({
        profile: "work",
        environment: {
          AWS_CLI_PATH: "/usr/bin/aws",
          AWS_PROFILE: "wrong-profile",
          AWS_ACCESS_KEY_ID: "ambient-access",
          AWS_SECRET_ACCESS_KEY: "ambient-secret",
          AWS_SESSION_TOKEN: "ambient-session",
        },
        sourceEnvironment: {
          region: "eu-west-1",
        },
        processRunner: runner(calls),
        exists: async (path) => path === "/usr/bin/aws",
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ accessKeyId: "AKIAPROFILE", region: "ap-southeast-2" });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      command: "/usr/bin/aws",
      args: ["configure", "export-credentials", "--profile", "work", "--format", "process"],
      inheritEnvironment: false,
      env: {
        AWS_ACCESS_KEY_ID: "ambient-access",
        AWS_SECRET_ACCESS_KEY: "ambient-secret",
        AWS_SESSION_TOKEN: "ambient-session",
        AWS_REGION: "eu-west-1",
      },
    });
    expect(calls[0]?.env?.AWS_PROFILE).toBeUndefined();
  });

  it("classifies SSO expiry and redacts secret-looking CLI failures", () => {
    expect(
      classifyBedrockAwsExportError("The SSO session has expired; run aws sso login", "work"),
    ).toMatchObject({
      code: "sso-expired",
      message: "AWS profile session expired. Run `aws sso login --profile work` and try again.",
    });
    expect(
      classifyBedrockAwsExportError(
        "SecretAccessKey leaked: wJalrXUtnFEMI/K7MDENG/bPxRfiCY",
        "work",
      ),
    ).toMatchObject({ code: "api-error", message: "AWS CLI failed to export credentials" });
  });
});
