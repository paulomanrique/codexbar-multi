import { describe, expect, it } from "vite-plus/test";
import { DesktopChannels } from "../src/ipc/api.ts";
import { makeHostStatusApi } from "../src/preload/host-status-api.ts";

describe("host status preload bridge", () => {
  it("invokes only the explicit hostStatus channel and decodes HostStatusDTO", async () => {
    const calls: string[] = [];
    const api = makeHostStatusApi(async (channel) => {
      calls.push(channel);
      return { schemaVersion: 1, status: "starting" as const };
    });
    const result = await api.getHostStatus();
    expect(calls).toEqual([DesktopChannels.hostStatus]);
    expect(result).toEqual({ schemaVersion: 1, status: "starting" });
  });

  it("strips extra fields from main output per Schema conventions", async () => {
    const api = makeHostStatusApi(async () => ({
      schemaVersion: 1,
      status: "ready" as const,
      message: "should be stripped",
      path: "/secret",
    }));
    const result = await api.getHostStatus();
    expect(result).not.toHaveProperty("message");
    expect(result).not.toHaveProperty("path");
    expect(result).toEqual({ schemaVersion: 1, status: "ready" });
  });

  it("rejects invalid or sensitive output rather than exposing it", async () => {
    const api = makeHostStatusApi(async () => ({
      schemaVersion: 1,
      status: "failed" as const,
      failure: { stage: "invalid" },
    }));
    await expect(api.getHostStatus()).rejects.toThrow();
  });

  it("does not use generic IPC or subscriptions", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../src/preload/host-status-api.ts", import.meta.url), "utf8"),
    );
    expect(source).toContain("DesktopChannels.hostStatus");
    expect(source).not.toContain("ipcRenderer.on");
    expect(source).not.toContain("subscribe");
    expect(source).not.toContain('invoke("');
  });
});
