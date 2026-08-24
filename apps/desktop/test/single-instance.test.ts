import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vite-plus/test";

import { activateWindow, type SingleInstanceWindow } from "../src/main/single-instance.ts";

const fakeWindow = (
  options: { readonly destroyed?: boolean; readonly minimized?: boolean } = {},
) => {
  const events: string[] = [];
  return {
    events,
    isDestroyed: () => options.destroyed ?? false,
    isMinimized: () => options.minimized ?? false,
    restore: () => events.push("restore"),
    show: () => events.push("show"),
    focus: () => events.push("focus"),
  } satisfies SingleInstanceWindow & { readonly events: string[] };
};

describe("single-instance activation", () => {
  it("creates, shows and focuses a missing window", () => {
    const created = fakeWindow();
    expect(activateWindow(undefined, () => created)).toBe(created);
    expect(created.events).toEqual(["show", "focus"]);
  });

  it("replaces a destroyed window", () => {
    const destroyed = fakeWindow({ destroyed: true });
    const created = fakeWindow();
    expect(activateWindow(destroyed, () => created)).toBe(created);
    expect(destroyed.events).toEqual([]);
    expect(created.events).toEqual(["show", "focus"]);
  });

  it("restores a minimized window before activating it", () => {
    const minimized = fakeWindow({ minimized: true });
    expect(activateWindow(minimized, () => fakeWindow())).toBe(minimized);
    expect(minimized.events).toEqual(["restore", "show", "focus"]);
  });
});

describe("desktop single-instance wiring", () => {
  it("acquires the lock before starting storage and leaves the losing instance idle", async () => {
    const source = await readFile(new URL("../src/main/index.ts", import.meta.url), "utf8");
    const lock = source.indexOf("requestSingleInstanceLock");
    const ready = source.indexOf("app.whenReady()", lock);
    expect(lock).toBeGreaterThan(-1);
    expect(ready).toBeGreaterThan(lock);
    expect(source.slice(lock, ready)).toContain("app.quit()");
    expect(source.slice(lock, ready)).not.toContain("makeNodeSqliteWorkerPersistence(");
  });

  it("activates the existing window on a second launch", async () => {
    const source = await readFile(new URL("../src/main/index.ts", import.meta.url), "utf8");
    expect(source).toContain('app.on("second-instance"');
    expect(source).toContain("activateWindow(window, createWindow)");
  });
});
