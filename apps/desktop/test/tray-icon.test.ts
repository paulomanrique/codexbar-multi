import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { loadTrayIcon, resolveTrayIconPath, trayIconFileName } from "../src/main/tray-icon.ts";

describe("desktop tray icon", () => {
  it("uses the multi-resolution ICO on Windows and PNG elsewhere", () => {
    expect(trayIconFileName("win32")).toBe("tray.ico");
    expect(trayIconFileName("linux")).toBe("tray.png");
    expect(trayIconFileName("darwin")).toBe("tray.png");
  });

  it("resolves packaged icons beside app.asar", () => {
    expect(
      resolveTrayIconPath({
        platform: "win32",
        isPackaged: true,
        resourcesPath: "/app/resources",
        mainDirectory: "/unused",
      }),
    ).toBe(join("/app/resources", "tray.ico"));
    expect(
      resolveTrayIconPath({
        platform: "linux",
        isPackaged: true,
        resourcesPath: "/app/resources",
        mainDirectory: "/unused",
      }),
    ).toBe(join("/app/resources", "tray.png"));
  });

  it("resolves development icons from the desktop build directory", () => {
    expect(
      resolveTrayIconPath({
        platform: "win32",
        isPackaged: false,
        resourcesPath: "/unused",
        mainDirectory: "/repo/apps/desktop/dist/main",
      }),
    ).toBe(join("/repo/apps/desktop/dist/main", "..", "..", "build", "icon.ico"));
  });

  it("rejects an empty NativeImage instead of leaving an invisible tray process", () => {
    expect(() =>
      loadTrayIcon({
        platform: "win32",
        isPackaged: true,
        resourcesPath: "/app/resources",
        mainDirectory: "/unused",
        createFromPath: () => ({ isEmpty: () => true }),
      }),
    ).toThrow("Tray icon is empty or missing");

    const image = { isEmpty: () => false };
    expect(
      loadTrayIcon({
        platform: "win32",
        isPackaged: true,
        resourcesPath: "/app/resources",
        mainDirectory: "/unused",
        createFromPath: () => image,
      }),
    ).toBe(image);
  });

  it("ships real runtime assets and removes the unsupported SVG path", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { readonly build?: { readonly extraResources?: unknown } };
    expect(manifest.build?.extraResources).toEqual([
      { from: "build/icon.png", to: "tray.png" },
      { from: "build/icon.ico", to: "tray.ico" },
    ]);

    const png = await stat(new URL("../build/icon.png", import.meta.url));
    const ico = await stat(new URL("../build/icon.ico", import.meta.url));
    expect(png.isFile() && png.size > 0).toBe(true);
    expect(ico.isFile() && ico.size > 0).toBe(true);

    const main = await readFile(new URL("../src/main/index.ts", import.meta.url), "utf8");
    expect(main).toContain("loadTrayIcon");
    expect(main).not.toContain("createFromDataURL");
    expect(main).not.toContain("image/svg+xml");
    expect(main).toContain('tray.on("click"');
  });
});
