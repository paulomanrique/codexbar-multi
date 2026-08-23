import { describe, expect, it } from "vite-plus/test";
import { discoverNodeClaudeCredential } from "../src/node-claude-credential.ts";
import { posix } from "node:path";

describe("credential reader still exposes only accessToken", () => {
  it("JSON.stringify never contains refreshToken", () => {
    const payload = {
      claudeAiOauth: {
        accessToken: "tok123",
        refreshToken: "refresh-should-not-leak",
        expiresAt: 1,
      },
    };
    const result = discoverNodeClaudeCredential({
      environment: {},
      homeDirectory: "/home/test",
      workingDirectory: "/tmp",
      path: { join: posix.join, isAbsolute: posix.isAbsolute },
      lstat: () => ({
        isFile: () => true,
        isSymbolicLink: () => false,
        size: 100n,
        dev: 1n,
        ino: 1n,
      }),
      open: () => ({
        stat: () => ({
          isFile: () => true,
          isSymbolicLink: () => false,
          size: 100n,
          dev: 1n,
          ino: 1n,
        }),
        readFile: () => JSON.stringify(payload),
        close: () => {},
      }),
    });
    expect(Object.keys(result)).toEqual(["accessToken"]);
    expect(JSON.stringify(result)).not.toContain("refresh");
    expect(JSON.stringify(result)).not.toContain("refresh-should-not-leak");
  });
});
