import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { join, posix, win32 } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  deriveClaudeOAuthHistoryOwnerIdentifier,
  discoverNodeClaudeCredential,
  type NodeClaudeCredentialOptions,
  type NodeClaudeFileHandle,
  type NodeClaudeFileStat,
} from "../src/node-claude-credential.ts";

const secret = "sk-claude-secret-value-123";
const refreshSecret = "refresh-should-not-leak";
const expectedOwner = (kind: "access" | "refresh", value: string) =>
  createHash("sha256")
    .update(`codexbar:claude-oauth-history-owner:v1\0${kind}\0${value}`, "utf8")
    .digest("hex");
const refreshOwner = expectedOwner("refresh", refreshSecret);
const home = "/home/alice";
const windowsHome = "C:\\Users\\Alice";
const workingDirectory = "/tmp/probe";
const windowsWorkingDirectory = "D:\\work\\probe";

const validPayload = {
  claudeAiOauth: {
    accessToken: `  ${secret}  `,
    refreshToken: refreshSecret,
    expiresAt: 9999999999999,
  },
  mcpOAuth: { accessToken: "mcp-token" },
  account: { id: "acc" },
  cookie: "should-not-leak",
};

const regularStat = (ino = 1n, size = 32n): NodeClaudeFileStat => ({
  isFile: () => true,
  isSymbolicLink: () => false,
  size,
  dev: 1n,
  ino,
});

const handleFor = (
  content: string,
  stat: NodeClaudeFileStat,
  closes: { count: number },
): NodeClaudeFileHandle => ({
  stat: () => stat,
  readFile: () => content,
  close: () => {
    closes.count += 1;
  },
});

const discover = ({
  content = JSON.stringify(validPayload),
  stat,
  openedStat,
  lstat,
  open,
  ...options
}: NodeClaudeCredentialOptions & {
  readonly content?: string;
  readonly stat?: NodeClaudeFileStat;
  readonly openedStat?: NodeClaudeFileStat;
}) => {
  const before = stat ?? regularStat(1n, BigInt(Buffer.byteLength(content)));
  const after = openedStat ?? before;
  const paths: string[] = [];
  const flags: number[] = [];
  const closes = { count: 0 };
  let opened = 0;
  const credential = discoverNodeClaudeCredential({
    homeDirectory: home,
    workingDirectory,
    path: { join: posix.join, isAbsolute: posix.isAbsolute },
    ...options,
    lstat:
      lstat ??
      ((path) => {
        paths.push(path);
        return before;
      }),
    open:
      open ??
      ((path, flag) => {
        paths.push(path);
        flags.push(flag);
        opened += 1;
        return handleFor(content, after, closes);
      }),
  });
  return { credential, paths, flags, opened, closes };
};

describe("Node Claude credential discovery (Swift credentialsURL parity)", () => {
  it("reads the default homedir path when CLAUDE_CONFIG_DIR is absent", () => {
    const { credential, paths } = discover({ environment: {} });
    expect(paths[0]).toBe(posix.join(home, ".claude", ".credentials.json"));
    expect(credential).toEqual({ accessToken: secret, historyOwnerIdentifier: refreshOwner });
  });

  it("uses a nonempty HOME environment value before the host homedir", () => {
    const paths: string[] = [];
    const credential = discoverNodeClaudeCredential({
      environment: { HOME: "relative-home" },
      workingDirectory,
      path: { join: posix.join, isAbsolute: posix.isAbsolute },
      lstat: (path) => {
        paths.push(path);
        return regularStat();
      },
      open: () => handleFor(JSON.stringify(validPayload), regularStat(), { count: 0 }),
    });
    expect(paths[0]).toBe(
      posix.join(workingDirectory, "relative-home", ".claude", ".credentials.json"),
    );
    expect(credential).toEqual({ accessToken: secret, historyOwnerIdentifier: refreshOwner });
  });

  it("uses CLAUDE_CONFIG_DIR as a literal nonempty root without trimming", () => {
    const { paths } = discover({
      environment: { CLAUDE_CONFIG_DIR: "  /custom/claude  " },
    });
    expect(paths[0]).toBe(posix.join(workingDirectory, "  /custom/claude  ", ".credentials.json"));
    const absolute = discover({
      environment: { CLAUDE_CONFIG_DIR: "/custom/claude" },
    });
    expect(absolute.paths[0]).toBe(posix.join("/custom/claude", ".credentials.json"));
  });

  it("treats empty CLAUDE_CONFIG_DIR as default and keeps whitespace-only values literal", () => {
    const empty = discover({ environment: { CLAUDE_CONFIG_DIR: "" } });
    expect(empty.paths[0]).toBe(posix.join(home, ".claude", ".credentials.json"));
    const whitespace = discover({ environment: { CLAUDE_CONFIG_DIR: "   " } });
    expect(whitespace.paths[0]).toBe(posix.join(workingDirectory, "   ", ".credentials.json"));
  });

  it("lets CLAUDE_SECURESTORAGE_CONFIG_DIR win when present, including empty defaulting", () => {
    const explicit = discover({
      environment: {
        CLAUDE_CONFIG_DIR: "/custom",
        CLAUDE_SECURESTORAGE_CONFIG_DIR: "/secure",
      },
    });
    expect(explicit.paths[0]).toBe(posix.join("/secure", ".credentials.json"));
    const emptySecure = discover({
      environment: {
        CLAUDE_CONFIG_DIR: "/custom",
        CLAUDE_SECURESTORAGE_CONFIG_DIR: "",
      },
    });
    expect(emptySecure.paths[0]).toBe(posix.join(home, ".claude", ".credentials.json"));
  });

  it("resolves relative configured roots against the injected working directory", () => {
    const { paths } = discover({
      environment: { CLAUDE_CONFIG_DIR: "first, second" },
    });
    expect(paths[0]).toBe(posix.join(workingDirectory, "first, second", ".credentials.json"));
    const tilde = discover({
      environment: { CLAUDE_CONFIG_DIR: "~/.claude-profile" },
    });
    expect(tilde.paths[0]).toBe(
      posix.join(workingDirectory, "~/.claude-profile", ".credentials.json"),
    );
  });

  it("keeps absolute POSIX and Windows roots absolute through the injected path API", () => {
    const posixRoot = discover({
      environment: { CLAUDE_CONFIG_DIR: "/abs/claude" },
    });
    expect(posixRoot.paths[0]).toBe("/abs/claude/.credentials.json");

    const windowsPaths: string[] = [];
    const windowsCredential = discoverNodeClaudeCredential({
      environment: { CLAUDE_CONFIG_DIR: "C:\\Custom\\ClaudeConfig" },
      homeDirectory: windowsHome,
      workingDirectory: windowsWorkingDirectory,
      path: { join: win32.join, isAbsolute: win32.isAbsolute },
      lstat: (path) => {
        windowsPaths.push(path);
        return regularStat();
      },
      open: () => handleFor(JSON.stringify(validPayload), regularStat(), { count: 0 }),
    });
    expect(windowsPaths[0]).toBe(win32.join("C:\\Custom\\ClaudeConfig", ".credentials.json"));
    expect(windowsCredential).toEqual({
      accessToken: secret,
      historyOwnerIdentifier: refreshOwner,
    });

    const relativeWindows: string[] = [];
    discoverNodeClaudeCredential({
      environment: { CLAUDE_SECURESTORAGE_CONFIG_DIR: "secure-root" },
      homeDirectory: windowsHome,
      workingDirectory: windowsWorkingDirectory,
      path: { join: win32.join, isAbsolute: win32.isAbsolute },
      lstat: (path) => {
        relativeWindows.push(path);
        return regularStat();
      },
      open: () => handleFor("{}", regularStat(), { count: 0 }),
    });
    expect(relativeWindows[0]).toBe(
      win32.join(windowsWorkingDirectory, "secure-root", ".credentials.json"),
    );

    const defaultWindows: string[] = [];
    discoverNodeClaudeCredential({
      environment: {},
      homeDirectory: windowsHome,
      workingDirectory: windowsWorkingDirectory,
      path: { join: win32.join, isAbsolute: win32.isAbsolute },
      lstat: (path) => {
        defaultWindows.push(path);
        return regularStat();
      },
      open: () => handleFor("{}", regularStat(), { count: 0 }),
    });
    expect(defaultWindows[0]).toBe(win32.join(windowsHome, ".claude", ".credentials.json"));
  });

  it("uses the host-native path API by default", () => {
    const paths: string[] = [];
    const credential = discoverNodeClaudeCredential({
      environment: { CLAUDE_CONFIG_DIR: "/fixture/claude" },
      lstat: (path) => {
        paths.push(path);
        return regularStat();
      },
      open: () => handleFor(JSON.stringify(validPayload), regularStat(), { count: 0 }),
    });
    expect(paths[0]).toBe(join("/fixture/claude", ".credentials.json"));
    expect(credential).toEqual({ accessToken: secret, historyOwnerIdentifier: refreshOwner });
  });

  it("returns only trimmed claudeAiOauth.accessToken", () => {
    const { credential } = discover({
      environment: { CLAUDE_CONFIG_DIR: "/custom" },
    });
    expect(credential).toEqual({ accessToken: secret, historyOwnerIdentifier: refreshOwner });
    expect(Object.keys(credential)).toEqual(["accessToken", "historyOwnerIdentifier"]);
    const serialized = JSON.stringify(credential);
    expect(serialized).not.toContain("refresh");
    expect(serialized).not.toContain("cookie");
    expect(serialized).not.toContain("/custom");
  });

  it("derives the Swift-compatible opaque owner and prefers refresh credentials", () => {
    expect(
      deriveClaudeOAuthHistoryOwnerIdentifier({
        accessToken: " test-access ",
        refreshToken: " test-refresh ",
      }),
    ).toBe(expectedOwner("refresh", "test-refresh"));
    expect(
      deriveClaudeOAuthHistoryOwnerIdentifier({ accessToken: " test-access ", refreshToken: " " }),
    ).toBe(expectedOwner("access", "test-access"));
    expect(deriveClaudeOAuthHistoryOwnerIdentifier({ accessToken: " ", refreshToken: null })).toBe(
      undefined,
    );
  });

  it("rejects MCP-only, malformed, and missing access tokens", () => {
    expect(
      discover({
        environment: { CLAUDE_CONFIG_DIR: "/custom" },
        content: JSON.stringify({ mcpOAuth: { accessToken: "mcp-only" } }),
      }).credential,
    ).toEqual({});
    expect(
      discover({
        environment: { CLAUDE_CONFIG_DIR: "/custom" },
        content: JSON.stringify({ someOther: { accessToken: secret } }),
      }).credential,
    ).toEqual({});
    expect(
      discover({
        environment: { CLAUDE_CONFIG_DIR: "/custom" },
        content: JSON.stringify({ claudeAiOauth: { accessToken: "   " } }),
      }).credential,
    ).toEqual({});
    expect(
      discover({
        environment: { CLAUDE_CONFIG_DIR: "/custom" },
        content: "{ not valid json",
      }).credential,
    ).toEqual({});
    expect(
      discover({
        environment: { CLAUDE_CONFIG_DIR: "/custom" },
        content: JSON.stringify(null),
      }).credential,
    ).toEqual({});
    expect(
      discover({
        environment: { CLAUDE_CONFIG_DIR: "/custom" },
        content: JSON.stringify({ claudeAiOauth: "not-an-object" }),
      }).credential,
    ).toEqual({});
    expect(
      discover({
        environment: { CLAUDE_CONFIG_DIR: "/custom" },
        content: JSON.stringify({ claudeAiOauth: null }),
      }).credential,
    ).toEqual({});
  });

  it("rejects symlink, directory, oversized, and inode-change reads via production lstat/open seams", () => {
    const symlink = discover({
      environment: { CLAUDE_CONFIG_DIR: "/custom" },
      lstat: () => ({
        isFile: () => false,
        isSymbolicLink: () => true,
        size: 12n,
        dev: 1n,
        ino: 1n,
      }),
    });
    expect(symlink.credential).toEqual({});
    expect(symlink.opened).toBe(0);

    const directory = discover({
      environment: { CLAUDE_CONFIG_DIR: "/custom" },
      lstat: () => ({
        isFile: () => false,
        isSymbolicLink: () => false,
        size: 0n,
        dev: 1n,
        ino: 2n,
      }),
    });
    expect(directory.credential).toEqual({});
    expect(directory.opened).toBe(0);

    const oversized = discover({
      environment: { CLAUDE_CONFIG_DIR: "/custom" },
      lstat: () => regularStat(3n, 1024n * 1024n + 1n),
    });
    expect(oversized.credential).toEqual({});
    expect(oversized.opened).toBe(0);

    const closes = { count: 0 };
    let read = 0;
    const raced = discover({
      environment: { CLAUDE_CONFIG_DIR: "/custom" },
      lstat: () => regularStat(4n, 24n),
      open: () => ({
        stat: () => regularStat(99n, 24n),
        readFile: () => {
          read += 1;
          return JSON.stringify(validPayload);
        },
        close: () => {
          closes.count += 1;
        },
      }),
    });
    expect(raced.credential).toEqual({});
    expect(read).toBe(0);
    expect(closes.count).toBe(1);
    expect(JSON.stringify(raced.credential)).not.toContain("/custom");
    expect(JSON.stringify(raced.credential)).not.toContain(secret);
  });

  it("uses O_NOFOLLOW on POSIX and stays fail-closed on Windows without it", () => {
    const posixOpen = discover({
      environment: { CLAUDE_CONFIG_DIR: "/custom" },
      platform: "linux",
    });
    if (constants.O_NOFOLLOW === undefined) {
      expect(posixOpen.flags[0]).toBe(constants.O_RDONLY);
    } else {
      expect(posixOpen.flags[0]).toBe(constants.O_RDONLY | constants.O_NOFOLLOW);
    }

    const windowsFlags: number[] = [];
    const windowsCloses = { count: 0 };
    const windowsRace = discoverNodeClaudeCredential({
      environment: { CLAUDE_CONFIG_DIR: "C:\\Custom\\ClaudeConfig" },
      homeDirectory: windowsHome,
      workingDirectory: windowsWorkingDirectory,
      path: { join: win32.join, isAbsolute: win32.isAbsolute },
      platform: "win32",
      lstat: () => regularStat(8n, 24n),
      open: (_path, flags) => {
        windowsFlags.push(flags);
        return {
          stat: () => regularStat(9n, 24n),
          readFile: () => JSON.stringify(validPayload),
          close: () => {
            windowsCloses.count += 1;
          },
        };
      },
    });
    expect(windowsFlags[0]).toBe(constants.O_RDONLY);
    expect(windowsRace).toEqual({});
    expect(windowsCloses.count).toBe(1);
  });

  it("fails closed without leaking path or secret when the file is unreadable", () => {
    const secretPath = "/custom/.credentials.json";
    const result = discoverNodeClaudeCredential({
      environment: { CLAUDE_CONFIG_DIR: "/custom" },
      path: { join: posix.join, isAbsolute: posix.isAbsolute },
      homeDirectory: home,
      workingDirectory,
      lstat: (path) => {
        throw new Error(`ENOENT: no such file, open '${path}' with ${secret}`);
      },
    });
    expect(result).toEqual({});
    expect(JSON.stringify(result)).not.toContain(secretPath);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("/custom");
  });
});
