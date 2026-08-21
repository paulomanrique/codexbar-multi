import { describe, expect, it } from "vite-plus/test";
import type { LegacyImportInspection } from "@codexbar/core";
import type { NodeLegacyImportOptions } from "@codexbar/platform/node";

import {
  DesktopLegacyImportController,
  type DesktopLegacyImportAdapter,
} from "../src/main/legacy-import.ts";

const inspection: LegacyImportInspection = {
  candidates: [
    {
      kind: "config",
      source: "legacy-config",
      state: "ready",
      itemCount: 1,
      byteCount: 128,
      reason: "/private/legacy/config.json contains a token",
    },
    {
      kind: "history",
      source: "legacy-history",
      state: "missing",
      itemCount: 0,
      byteCount: 0,
    },
  ],
  excludedFeatures: ["icloud", "widgetkit", "sparkle", "approvals"],
  sqliteCompatibility: "not-attempted",
};

const paths = {
  destinationRoot: "/private/new-data",
  databasePath: "/private/new-data/usage.sqlite",
  targetConfigPath: "/private/new-data/config.json",
  targetPluginsPath: "/private/new-data/plugins",
};

const makeController = (options: {
  readonly adapter?: Partial<DesktopLegacyImportAdapter>;
  readonly confirm?: (action: "execute" | "rollback", itemCount: number) => Promise<boolean>;
  readonly selectLegacyRoot?: () => Promise<string | undefined>;
  readonly now?: () => number;
}) => {
  const calls: NodeLegacyImportOptions[] = [];
  const adapter: DesktopLegacyImportAdapter = {
    inspect: async (request) => {
      calls.push(request);
      return inspection;
    },
    execute: async (request) => {
      calls.push(request);
      return {
        importId: request.importId!,
        status: "completed",
        inspection,
        imported: { config: 1, history: 0, cost: 0, plugins: 0 },
        skipped: ["path-bearing host detail"],
      };
    },
    rollback: async (request) => {
      calls.push(request);
      return {
        importId: request.importId,
        removed: { config: 1, history: 0, cost: 0, plugins: 0 },
        skipped: ["journal detail"],
      };
    },
    ...options.adapter,
  };
  return {
    calls,
    controller: new DesktopLegacyImportController({
      adapter,
      host: {
        selectLegacyRoot: options.selectLegacyRoot ?? (async () => "/private/legacy"),
        confirm: options.confirm ?? (async () => true),
      },
      paths,
      ...(options.now === undefined ? {} : { now: options.now }),
      nextOpaqueId: () => "fixture-id",
    }),
  };
};

describe("desktop legacy import capability broker", () => {
  it("returns a data-free inspection ticket and never projects selected paths or parse reasons", async () => {
    const { controller, calls } = makeController({});
    const result = await controller.inspect();
    expect(result).toEqual({
      status: "ready",
      ticket: "ticket-fixture-id",
      candidates: [
        { kind: "config", state: "ready", itemCount: 1, byteCount: 128 },
        { kind: "history", state: "missing", itemCount: 0, byteCount: 0 },
      ],
      excludedFeatures: ["icloud", "widgetkit", "sparkle", "approvals"],
      sqliteCompatibility: "not-attempted",
    });
    expect(calls[0]).toMatchObject({
      legacyRoot: "/private/legacy",
      destinationRoot: paths.destinationRoot,
      databasePath: paths.databasePath,
      importId: "legacy-fixture-id",
    });
    expect(JSON.stringify(result)).not.toContain("/private/");
    expect(JSON.stringify(result)).not.toContain("token");
  });

  it("requires native confirmation, consumes the ticket, and reduces skipped details to a count", async () => {
    const confirmations: Array<{ action: string; itemCount: number }> = [];
    const { controller } = makeController({
      confirm: async (action, itemCount) => {
        confirmations.push({ action, itemCount });
        return true;
      },
    });
    const inspected = await controller.inspect();
    if (inspected.status !== "ready") throw new Error("fixture inspection cancelled");
    await expect(controller.execute({ ticket: inspected.ticket })).resolves.toEqual({
      status: "completed",
      importId: "legacy-fixture-id",
      imported: { config: 1, history: 0, cost: 0, plugins: 0 },
      skippedCount: 1,
    });
    expect(confirmations).toEqual([{ action: "execute", itemCount: 1 }]);
    await expect(controller.execute({ ticket: inspected.ticket })).rejects.toThrow(
      "missing or expired",
    );
  });

  it("does not consume a ticket when native confirmation is cancelled", async () => {
    let confirmed = false;
    const { controller } = makeController({ confirm: async () => confirmed });
    const inspected = await controller.inspect();
    if (inspected.status !== "ready") throw new Error("fixture inspection cancelled");
    await expect(controller.execute({ ticket: inspected.ticket })).resolves.toEqual({
      status: "cancelled",
    });
    confirmed = true;
    await expect(controller.execute({ ticket: inspected.ticket })).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("revokes an earlier ticket when a replacement native picker is cancelled", async () => {
    let selections = 0;
    const { controller } = makeController({
      selectLegacyRoot: async () => (++selections === 1 ? "/private/legacy" : undefined),
    });
    const inspected = await controller.inspect();
    if (inspected.status !== "ready") throw new Error("fixture inspection cancelled");
    await expect(controller.inspect()).resolves.toEqual({ status: "cancelled" });
    await expect(controller.execute({ ticket: inspected.ticket })).rejects.toThrow(
      "missing or expired",
    );
  });

  it("expires inspection authority and keeps rollback journal-driven", async () => {
    let now = 1_000;
    const { controller, calls } = makeController({ now: () => now });
    const inspected = await controller.inspect();
    if (inspected.status !== "ready") throw new Error("fixture inspection cancelled");
    now += 10 * 60 * 1_000 + 1;
    await expect(controller.execute({ ticket: inspected.ticket })).rejects.toThrow(
      "missing or expired",
    );
    await expect(controller.rollback({ importId: "legacy-fixture-id" })).resolves.toEqual({
      status: "completed",
      importId: "legacy-fixture-id",
      removed: { config: 1, history: 0, cost: 0, plugins: 0 },
      skippedCount: 1,
    });
    expect(calls.at(-1)).toMatchObject({
      legacyRoot: paths.destinationRoot,
      destinationRoot: paths.destinationRoot,
      importId: "legacy-fixture-id",
    });
  });
});
