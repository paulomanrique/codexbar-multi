import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { HostStatusDTO, HostFailureStageDTO } from "@codexbar/contracts";
import {
  createHostLifecycle,
  shouldQuitOnWindowAllClosedForStatus,
} from "../src/main/host-lifecycle.ts";

describe("host lifecycle", () => {
  it("starts in starting shell and allows stage progression", () => {
    const lifecycle = createHostLifecycle("shell");
    expect(lifecycle.getState()).toEqual({ status: "starting", bootstrapStage: "shell" });
    expect(lifecycle.getBootstrapStage()).toBe("shell");
    lifecycle.advanceBootstrapStage("storage");
    expect(lifecycle.getState()).toEqual({ status: "starting", bootstrapStage: "storage" });
    lifecycle.advanceBootstrapStage("config");
    expect(lifecycle.getBootstrapStage()).toBe("config");
  });

  it("transitions starting -> ready and starting -> failed only", () => {
    const ready = createHostLifecycle("shell");
    ready.markReady();
    expect(ready.getState()).toEqual({ status: "ready" });
    expect(() => ready.markReady()).toThrow();
    expect(() => ready.markFailed("storage")).toThrow();
    expect(() => ready.advanceBootstrapStage("runtime")).toThrow();

    const failed = createHostLifecycle("shell");
    failed.markFailed("storage");
    expect(failed.getState()).toEqual({ status: "failed", failure: { stage: "storage" } });
    expect(() => failed.markReady()).toThrow();
    expect(() => failed.markFailed("runtime")).toThrow();
    expect(() => failed.advanceBootstrapStage("runtime")).toThrow();
  });

  it("projects a closed safe HostStatusDTO with schemaVersion 1", () => {
    const lifecycle = createHostLifecycle("shell");
    const starting = lifecycle.toHostStatusDTO();
    expect(starting).toEqual({ schemaVersion: 1, status: "starting" });
    expect(JSON.stringify(starting)).not.toContain("message");
    expect(JSON.stringify(starting)).not.toContain("path");
    expect(JSON.stringify(starting)).not.toContain("cause");
    expect(JSON.stringify(starting)).not.toContain("error");
    expect(JSON.stringify(starting)).not.toContain("detail");
    expect(JSON.stringify(starting)).not.toContain("databasePath");
    expect(JSON.stringify(starting)).not.toContain("bootstrapStage");

    lifecycle.markReady();
    expect(lifecycle.toHostStatusDTO()).toEqual({ schemaVersion: 1, status: "ready" });

    const failed = createHostLifecycle("shell");
    failed.markFailed("runtime");
    expect(failed.toHostStatusDTO()).toEqual({
      schemaVersion: 1,
      status: "failed",
      failure: { stage: "runtime" },
    });
  });

  it("schema decodes HostStatusDTO and strips or rejects extra sensitive fields", () => {
    const decode = Schema.decodeUnknownSync(HostStatusDTO);
    const withoutExtra = decode({
      schemaVersion: 1,
      status: "failed",
      failure: { stage: "storage" },
      message: "secret",
      path: "/tmp/db",
      cause: "raw",
      error: "raw",
      detail: "raw",
      databasePath: "/tmp",
    });
    // repo convention is to strip excess properties, not leak them
    expect(withoutExtra).not.toHaveProperty("message");
    expect(withoutExtra).not.toHaveProperty("path");
    expect(withoutExtra).not.toHaveProperty("cause");
    expect(withoutExtra).not.toHaveProperty("error");
    expect(withoutExtra).not.toHaveProperty("detail");
    expect(withoutExtra).not.toHaveProperty("databasePath");
    if ("failure" in withoutExtra && withoutExtra.failure !== undefined) {
      expect(withoutExtra.failure as Record<string, unknown>).not.toHaveProperty("message");
    }
  });

  it("rejects invalid stage and invalid status via Schema", () => {
    const decodeStatus = Schema.decodeUnknownSync(HostStatusDTO);
    const decodeStage = Schema.decodeUnknownSync(HostFailureStageDTO);
    expect(() => decodeStage("invalid")).toThrow();
    expect(() => decodeStatus({ schemaVersion: 1, status: "unknown" })).toThrow();
    expect(() => decodeStatus({ schemaVersion: 2, status: "starting" })).toThrow();
    expect(() => decodeStatus({ schemaVersion: 1, status: "failed" })).toThrow();
    expect(() =>
      decodeStatus({ schemaVersion: 1, status: "failed", failure: { stage: "bad" } }),
    ).toThrow();
  });

  it("never accepts raw Error or text in transition APIs", async () => {
    const lifecycle = createHostLifecycle("shell");
    // APIs only accept stage token, not Error
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../src/main/host-lifecycle.ts", import.meta.url), "utf8"),
    );
    // Implementation must not store raw Error or transport cause text: markFailed takes only stage
    expect(source).toContain("markFailed");
    expect(source).toContain("HostFailureStage");
    // Ensure source does not declare a parameter named error/cause/message
    expect(source).not.toMatch(/markFailed\s*\(\s*.*\b(error|cause|message)\b/i);
    // markFailed with Error should throw or be rejected by Schema
    expect(() =>
      (lifecycle as unknown as { markFailed: (v: unknown) => void }).markFailed(
        new Error("boom") as unknown as never,
      ),
    ).toThrow();
    expect(() =>
      (lifecycle as unknown as { markFailed: (v: unknown) => void }).markFailed(
        "raw message" as never,
      ),
    ).toThrow();
  });

  it("exposes pure last-window-close policy", () => {
    const starting = createHostLifecycle("shell");
    expect(starting.shouldQuitOnWindowAllClosed()).toBe(false);
    expect(shouldQuitOnWindowAllClosedForStatus("starting")).toBe(false);
    expect(shouldQuitOnWindowAllClosedForStatus("ready")).toBe(false);
    expect(shouldQuitOnWindowAllClosedForStatus("failed")).toBe(true);
    starting.markFailed("config");
    expect(starting.shouldQuitOnWindowAllClosed()).toBe(true);
    const ready = createHostLifecycle("shell");
    ready.markReady();
    expect(ready.shouldQuitOnWindowAllClosed()).toBe(false);
  });
});
