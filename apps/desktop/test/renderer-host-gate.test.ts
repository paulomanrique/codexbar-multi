import { describe, expect, it } from "vite-plus/test";
import { readFile } from "node:fs/promises";

describe("renderer host gate", () => {
  it("polls getHostStatus every 250ms, cancels timer, and gates App until ready", async () => {
    const source = await readFile(new URL("../src/renderer/index.tsx", import.meta.url), "utf8");
    // Must poll host status
    expect(source).toContain("getHostStatus");
    expect(source).toContain("250");
    // Must cancel timer on unmount
    expect(source).toContain("clearTimeout");
    // Must render visible starting chrome
    expect(source).toContain("Starting CodexBar Multi");
    // Must render fixed redacted failure keyed by stage only
    expect(source).toContain("Startup stopped while preparing");
    // Must mount App only when ready
    expect(source).toContain("HostGate");
    expect(source).toContain('status === "ready"');
    expect(source).toContain("<App");
    // Must not call overview/settings/spend/provider IPC before ready (i.e., HostGate is the only top-level render)
    const rootRender = source.slice(source.lastIndexOf("createRoot"));
    expect(rootRender).toContain("HostGate");
    expect(rootRender).not.toContain("<App />");
    // The gate file must not display raw error
    expect(source).not.toMatch(/error\.message/);
    expect(source).not.toMatch(/cause/);
    // App mounting is inside HostGate ready branch, not unconditional
    const hostGateBlock = source.slice(
      source.indexOf("function HostGate"),
      source.indexOf("const root"),
    );
    expect(hostGateBlock).toContain("getHostStatus");
    expect(hostGateBlock).toContain("starting");
    expect(hostGateBlock).toContain("failed");
    expect(hostGateBlock).toContain("ready");
  });

  it("does not import Electron or ipcRenderer in renderer", async () => {
    const source = await readFile(new URL("../src/renderer/index.tsx", import.meta.url), "utf8");
    expect(source).not.toContain("electron");
    expect(source).not.toContain("ipcRenderer");
  });
});
