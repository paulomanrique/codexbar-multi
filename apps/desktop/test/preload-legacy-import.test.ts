import { describe, expect, it } from "vite-plus/test";

import { DesktopChannels } from "../src/ipc/api.ts";
import { makeLegacyImportApi } from "../src/preload/legacy-import-api.ts";

describe("legacy import preload bridge", () => {
  it("uses only explicit high-level channels and validates opaque request capabilities", async () => {
    const calls: Array<{ readonly channel: string; readonly input: unknown }> = [];
    const api = makeLegacyImportApi(async (channel, input) => {
      calls.push({ channel, input });
      if (channel === DesktopChannels.inspectLegacyImport) return { status: "cancelled" };
      if (channel === DesktopChannels.executeLegacyImport) {
        return {
          status: "completed",
          importId: "legacy-safe",
          imported: { config: 0, history: 2, cost: 3, plugins: 0 },
          skippedCount: 0,
          path: "/not-renderer-visible",
        };
      }
      return {
        status: "completed",
        importId: "legacy-safe",
        removed: { config: 0, history: 2, cost: 3, plugins: 0 },
        skippedCount: 0,
      };
    });
    await expect(api.inspectLegacyImport()).resolves.toEqual({ status: "cancelled" });
    await expect(api.executeLegacyImport({ ticket: "ticket-safe" })).resolves.toEqual({
      status: "completed",
      importId: "legacy-safe",
      imported: { config: 0, history: 2, cost: 3, plugins: 0 },
      skippedCount: 0,
    });
    await expect(api.rollbackLegacyImport({ importId: "legacy-safe" })).resolves.toMatchObject({
      status: "completed",
      importId: "legacy-safe",
    });
    expect(calls).toEqual([
      { channel: DesktopChannels.inspectLegacyImport, input: undefined },
      { channel: DesktopChannels.executeLegacyImport, input: { ticket: "ticket-safe" } },
      { channel: DesktopChannels.rollbackLegacyImport, input: { importId: "legacy-safe" } },
    ]);
    await expect(api.executeLegacyImport({ ticket: "../../path" })).rejects.toThrow();
  });

  it("rejects malformed host output before it reaches renderer code", async () => {
    const api = makeLegacyImportApi(async () => ({ status: "ready", path: "/secret" }));
    await expect(api.inspectLegacyImport()).rejects.toThrow();
  });
});
