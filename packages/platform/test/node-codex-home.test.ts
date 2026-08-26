import { describe, expect, it } from "vite-plus/test";
import { normalizeNodeCodexProfileHome, resolveNodeCodexHome } from "../src/node-codex-home.ts";

describe("node Codex home path resolution", () => {
  it("defaults to the platform Codex home when CODEX_HOME is empty", () => {
    expect(resolveNodeCodexHome({}, "/home/user", "linux")).toBe("/home/user/.codex");
    expect(resolveNodeCodexHome({ CODEX_HOME: "  " }, "C:\\Users\\user", "win32")).toBe(
      "C:\\Users\\user\\.codex",
    );
  });

  it("expands explicit home-relative CODEX_HOME paths", () => {
    expect(resolveNodeCodexHome({ CODEX_HOME: "~" }, "/home/user", "linux")).toBe("/home/user");
    expect(resolveNodeCodexHome({ CODEX_HOME: "~/profiles/work" }, "/home/user", "linux")).toBe(
      "/home/user/profiles/work",
    );
    expect(
      resolveNodeCodexHome({ CODEX_HOME: "~\\profiles\\work" }, "C:\\Users\\user", "win32"),
    ).toBe("C:\\Users\\user\\profiles\\work");
  });

  it("resolves relative CODEX_HOME paths against the supplied working directory", () => {
    expect(
      resolveNodeCodexHome({ CODEX_HOME: "profiles/work" }, "/home/user", "linux", "/repo"),
    ).toBe("/repo/profiles/work");
    expect(
      resolveNodeCodexHome(
        { CODEX_HOME: "profiles\\work" },
        "C:\\Users\\user",
        "win32",
        "C:\\repo",
      ),
    ).toBe("C:\\repo\\profiles\\work");
  });

  it("normalizes only absolute managed Codex profile homes", () => {
    expect(normalizeNodeCodexProfileHome("~/profiles/work", "/home/user", "linux")).toBe(
      "/home/user/profiles/work",
    );
    expect(
      normalizeNodeCodexProfileHome("C:\\Users\\user\\profiles\\work", "C:\\Users\\user", "win32"),
    ).toBe("C:\\Users\\user\\profiles\\work");
    expect(normalizeNodeCodexProfileHome("profiles/work", "/home/user", "linux")).toBeUndefined();
    expect(normalizeNodeCodexProfileHome("~other/work", "/home/user", "linux")).toBeUndefined();
  });
});
