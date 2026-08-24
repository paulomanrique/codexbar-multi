import { createHash } from "node:crypto";
import { posix } from "node:path";

import { InfrastructureError, type CredentialStoreService } from "@codexbar/core";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveNodeClaudeOAuthHistoryOwner,
  type NodeClaudeCredentialOptions,
} from "../src/node-claude-credential.ts";

const owner = (kind: "access" | "refresh", secret: string) =>
  createHash("sha256")
    .update(`codexbar:claude-oauth-history-owner:v1\0${kind}\0${secret}`, "utf8")
    .digest("hex");

const store = (read: CredentialStoreService["read"]): CredentialStoreService => ({
  read,
  write: () => Effect.void,
  remove: () => Effect.void,
});

const discoveredFile = (
  accessToken = "file-access",
  refreshToken = "file-refresh",
): NodeClaudeCredentialOptions => {
  const content = JSON.stringify({ claudeAiOauth: { accessToken, refreshToken } });
  const stat = {
    isFile: () => true,
    isSymbolicLink: () => false,
    size: BigInt(Buffer.byteLength(content)),
    dev: 1n,
    ino: 2n,
  };
  return {
    homeDirectory: "/fixture/home",
    workingDirectory: "/fixture/work",
    path: { join: posix.join, isAbsolute: posix.isAbsolute },
    lstat: () => stat,
    open: () => ({ stat: () => stat, readFile: () => content, close: () => undefined }),
  };
};

describe("Node Claude OAuth history owner resolution", () => {
  it("matches runtime precedence: keyring, file, then environment", async () => {
    await expect(
      Effect.runPromise(
        resolveNodeClaudeOAuthHistoryOwner({
          credentialStore: store(() => Effect.succeed(" stored-access ")),
          environment: { CLAUDE_OAUTH_ACCESS_TOKEN: "environment-access" },
          discoverOptions: discoveredFile(),
        }),
      ),
    ).resolves.toBe(owner("access", "stored-access"));

    await expect(
      Effect.runPromise(
        resolveNodeClaudeOAuthHistoryOwner({
          credentialStore: store(() => Effect.succeed(undefined)),
          environment: { CLAUDE_OAUTH_ACCESS_TOKEN: "environment-access" },
          discoverOptions: discoveredFile(),
        }),
      ),
    ).resolves.toBe(owner("refresh", "file-refresh"));
  });

  it("uses the namespaced environment value without falling through when explicitly empty", async () => {
    const noFile = {
      ...discoveredFile(),
      lstat: () => {
        throw new Error("missing");
      },
    };
    await expect(
      Effect.runPromise(
        resolveNodeClaudeOAuthHistoryOwner({
          credentialStore: store(() => Effect.succeed(undefined)),
          environment: {
            CODEXBAR_MULTI_CLAUDE_CLAUDE_OAUTH_ACCESS_TOKEN: "namespaced-access",
            CLAUDE_OAUTH_ACCESS_TOKEN: "native-access",
          },
          discoverOptions: noFile,
        }),
      ),
    ).resolves.toBe(owner("access", "namespaced-access"));
    await expect(
      Effect.runPromise(
        resolveNodeClaudeOAuthHistoryOwner({
          credentialStore: store(() => Effect.succeed(undefined)),
          environment: {
            CODEXBAR_MULTI_CLAUDE_CLAUDE_OAUTH_ACCESS_TOKEN: "",
            CLAUDE_OAUTH_ACCESS_TOKEN: "native-access",
          },
          discoverOptions: noFile,
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it("falls back after a keyring read failure and otherwise fails closed", async () => {
    const failedStore = store(() =>
      Effect.fail(new InfrastructureError("credential.read", "fixture failure")),
    );
    await expect(
      Effect.runPromise(
        resolveNodeClaudeOAuthHistoryOwner({
          credentialStore: failedStore,
          environment: {},
          discoverOptions: discoveredFile(),
        }),
      ),
    ).resolves.toBe(owner("refresh", "file-refresh"));
    await expect(
      Effect.runPromise(
        resolveNodeClaudeOAuthHistoryOwner({
          credentialStore: failedStore,
          environment: {},
          discoverOptions: {
            ...discoveredFile(),
            lstat: () => {
              throw new Error("missing");
            },
          },
        }),
      ),
    ).resolves.toBeUndefined();
  });
});
