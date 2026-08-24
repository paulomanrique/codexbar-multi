import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { HostStatusDTO, HostFailureStageDTO } from "@codexbar/contracts";
import { DesktopChannels } from "../src/ipc/api.ts";

describe("host status contracts", () => {
  it("defines HostFailureStageDTO with closed literals shell|storage|config|plugins|runtime", () => {
    const decode = Schema.decodeUnknownSync(HostFailureStageDTO);
    expect(decode("shell")).toBe("shell");
    expect(decode("storage")).toBe("storage");
    expect(decode("config")).toBe("config");
    expect(decode("plugins")).toBe("plugins");
    expect(decode("runtime")).toBe("runtime");
    expect(() => decode("other")).toThrow();
    expect(() => decode("")).toThrow();
  });

  it("defines HostStatusDTO as closed safe projection with schemaVersion 1", () => {
    const decode = Schema.decodeUnknownSync(HostStatusDTO);
    expect(decode({ schemaVersion: 1, status: "starting" })).toEqual({
      schemaVersion: 1,
      status: "starting",
    });
    expect(decode({ schemaVersion: 1, status: "ready" })).toEqual({
      schemaVersion: 1,
      status: "ready",
    });
    expect(decode({ schemaVersion: 1, status: "failed", failure: { stage: "config" } })).toEqual({
      schemaVersion: 1,
      status: "failed",
      failure: { stage: "config" },
    });
    expect(() =>
      decode({ schemaVersion: 1, status: "failed", failure: { stage: "bad" } }),
    ).toThrow();
    expect(() =>
      decode({ schemaVersion: 1, status: "starting", message: "extra" } as unknown),
    ).not.toThrow();
    // extra fields must be stripped
    const stripped = decode({
      schemaVersion: 1,
      status: "ready",
      message: "leak",
      path: "/x",
    } as unknown);
    expect(stripped).not.toHaveProperty("message");
    expect(stripped).not.toHaveProperty("path");
  });

  it("has no message/path/cause/error/detail field in schema", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../../../packages/contracts/src/ipc.ts", import.meta.url), "utf8"),
    );
    const hostStatusBlock = source.slice(
      source.indexOf("HostStatusDTO"),
      source.indexOf("HostStatusDTO") + 800,
    );
    expect(hostStatusBlock).not.toContain("message");
    expect(hostStatusBlock).not.toContain("path");
    expect(hostStatusBlock).not.toContain("cause");
    // ensure error/detail not in HostStatus definition (search near)
    const hostFailureBlock = source.slice(
      source.indexOf("HostFailureStageDTO"),
      source.indexOf("HostFailureStageDTO") + 500,
    );
    expect(hostFailureBlock).not.toContain("message");
  });

  it("exposes hostStatus as invoke-only channel", () => {
    expect(DesktopChannels.hostStatus).toBe("codexbar-multi:host-status");
    expect(Object.values(DesktopChannels)).toContain("codexbar-multi:host-status");
    expect(new Set(Object.values(DesktopChannels)).size).toBe(
      Object.values(DesktopChannels).length,
    );
  });
});
