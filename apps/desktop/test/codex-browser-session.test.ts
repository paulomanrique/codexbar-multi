import { describe, expect, it } from "vite-plus/test";

import {
  CodexBrowserSessionError,
  DesktopCodexBrowserSessionController,
  type DesktopCodexBrowserSessionDependencies,
} from "../src/main/codex-browser-session.ts";

const revisionA = "a".repeat(64);
const revisionB = "b".repeat(64);
const makeRoster = (revision = revisionA, ids = ["account-a"], activeIndex = 0) => ({
  provider: "codex" as const,
  accounts: ids.map((id) => ({ id, label: `${id}@example.com`, addedAt: 1 })),
  activeIndex,
  selectionAvailable: true,
  revision,
});

const makeDependencies = (
  overrides: Partial<DesktopCodexBrowserSessionDependencies> = {},
): DesktopCodexBrowserSessionDependencies => ({
  listRoster: async () => makeRoster(),
  readStatus: async () => "absent",
  cleanupIsPending: async () => false,
  stageLoginFence: async () => undefined,
  startBrowserSession: async () => "connected",
  commitBrowserSession: async () => undefined,
  cancelBrowserSession: () => undefined,
  cleanupBrowserSession: async () => undefined,
  enqueueCleanup: async () => undefined,
  drainCleanup: async () => undefined,
  ...overrides,
});

describe("desktop Codex browser-session controller", () => {
  it("authorizes the active account, validates it, and returns metadata only", async () => {
    const calls: string[] = [];
    const controller = new DesktopCodexBrowserSessionController(
      makeDependencies({
        readStatus: async () => "persisted",
        stageLoginFence: async () => {
          calls.push("fence");
        },
        startBrowserSession: async (accountId, expectedRevision) => {
          calls.push(`start:${accountId}:${expectedRevision}`);
          return "connected";
        },
        commitBrowserSession: async (accountId, expectedRevision) => {
          calls.push(`commit:${accountId}:${expectedRevision}`);
        },
      }),
    );

    const result = await controller.start({
      accountId: "account-a",
      expectedRevision: revisionA,
    });

    expect(calls).toEqual([
      "fence",
      `start:account-a:${revisionA}`,
      `commit:account-a:${revisionA}`,
    ]);
    expect(result).toEqual({
      provider: "codex",
      revision: revisionA,
      statuses: [{ accountId: "account-a", status: "persisted" }],
    });
    expect(JSON.stringify(result)).not.toMatch(/cookie|secret|partition|credential/iu);
  });

  it("rejects stale, missing, inactive, or cleanup-fenced accounts before opening", async () => {
    let starts = 0;
    const startBrowserSession = async () => {
      starts += 1;
      return "connected" as const;
    };
    await expect(
      new DesktopCodexBrowserSessionController(
        makeDependencies({ listRoster: async () => makeRoster(revisionB), startBrowserSession }),
      ).start({ accountId: "account-a", expectedRevision: revisionA }),
    ).rejects.toMatchObject({ code: "stale-revision" } satisfies Partial<CodexBrowserSessionError>);
    await expect(
      new DesktopCodexBrowserSessionController(makeDependencies({ startBrowserSession })).start({
        accountId: "missing",
        expectedRevision: revisionA,
      }),
    ).rejects.toMatchObject({
      code: "missing-account",
    } satisfies Partial<CodexBrowserSessionError>);
    await expect(
      new DesktopCodexBrowserSessionController(
        makeDependencies({
          listRoster: async () => makeRoster(revisionA, ["account-a", "account-b"], 1),
          startBrowserSession,
        }),
      ).start({ accountId: "account-a", expectedRevision: revisionA }),
    ).rejects.toMatchObject({
      code: "inactive-account",
    } satisfies Partial<CodexBrowserSessionError>);
    await expect(
      new DesktopCodexBrowserSessionController(
        makeDependencies({ cleanupIsPending: async () => true, startBrowserSession }),
      ).start({ accountId: "account-a", expectedRevision: revisionA }),
    ).rejects.toMatchObject({
      code: "cleanup-pending",
    } satisfies Partial<CodexBrowserSessionError>);
    expect(starts).toBe(0);
  });

  it("does not delete an existing credential when the login window is cancelled", async () => {
    let cleaned = false;
    const controller = new DesktopCodexBrowserSessionController(
      makeDependencies({
        readStatus: async () => "persisted",
        startBrowserSession: async () => "cancelled",
        cleanupBrowserSession: async () => {
          cleaned = true;
        },
      }),
    );

    const result = await controller.start({
      accountId: "account-a",
      expectedRevision: revisionA,
    });
    expect(result.statuses[0]?.status).toBe("persisted");
    expect(cleaned).toBe(false);
  });

  it("durably cleans a connected session when roster validation races", async () => {
    const calls: string[] = [];
    let rosterReads = 0;
    const controller = new DesktopCodexBrowserSessionController(
      makeDependencies({
        listRoster: async () => {
          rosterReads += 1;
          return rosterReads > 1 ? makeRoster(revisionB) : makeRoster(revisionA);
        },
        enqueueCleanup: async () => {
          calls.push("enqueue");
        },
        drainCleanup: async () => {
          calls.push("drain");
        },
      }),
    );

    const caught = await controller
      .start({ accountId: "account-a", expectedRevision: revisionA })
      .catch((error: unknown) => error);
    expect(calls).toEqual(["enqueue", "drain"]);
    expect(caught).toBeInstanceOf(CodexBrowserSessionError);
  });

  it("falls back to direct host cleanup if the journal cannot be staged", async () => {
    const calls: string[] = [];
    let rosterReads = 0;
    const controller = new DesktopCodexBrowserSessionController(
      makeDependencies({
        listRoster: async () => {
          rosterReads += 1;
          return rosterReads > 1 ? makeRoster(revisionB) : makeRoster(revisionA);
        },
        enqueueCleanup: async () => {
          calls.push("enqueue");
          throw new Error("disk full");
        },
        cleanupBrowserSession: async () => {
          calls.push("cleanup");
        },
      }),
    );

    await expect(
      controller.start({ accountId: "account-a", expectedRevision: revisionA }),
    ).rejects.toMatchObject({ code: "stale-revision" });
    expect(calls).toEqual(["enqueue", "cleanup"]);
  });

  it("preserves an existing credential when pre-persistence validation rejects", async () => {
    let cleaned = false;
    const controller = new DesktopCodexBrowserSessionController(
      makeDependencies({
        startBrowserSession: async () => {
          throw new Error("candidate contained secret data");
        },
        cleanupBrowserSession: async () => {
          cleaned = true;
        },
      }),
    );
    const caught = await controller
      .start({ accountId: "account-a", expectedRevision: revisionA })
      .catch((error: unknown) => error);
    expect(caught).toMatchObject({ code: "start-failed" });
    expect(String(caught)).not.toContain("secret");
    expect(cleaned).toBe(false);
  });

  it("writes the durable marker before logout cleanup and fences pending status", async () => {
    const calls: string[] = [];
    const controller = new DesktopCodexBrowserSessionController(
      makeDependencies({
        cleanupIsPending: async () => calls.includes("enqueue"),
        enqueueCleanup: async () => {
          calls.push("enqueue");
        },
        drainCleanup: async () => {
          calls.push("drain");
        },
      }),
    );

    await controller.logout({ accountId: "account-a", expectedRevision: revisionA });
    expect(calls).toEqual(["enqueue", "drain"]);
  });

  it("returns unavailable for cleanup-fenced credentials and signals cancellation before roster lookup", async () => {
    const cancelled: string[] = [];
    const controller = new DesktopCodexBrowserSessionController(
      makeDependencies({
        readStatus: async () => "persisted",
        cleanupIsPending: async () => true,
        cancelBrowserSession: (accountId) => {
          cancelled.push(accountId);
        },
      }),
    );
    await expect(controller.statuses({ expectedRevision: revisionB })).rejects.toMatchObject({
      code: "stale-revision",
    });
    expect(await controller.statuses({ expectedRevision: revisionA })).toEqual({
      provider: "codex",
      revision: revisionA,
      statuses: [{ accountId: "account-a", status: "unavailable" }],
    });
    await controller.cancel({ accountId: "account-a" });
    await expect(controller.cancel({ accountId: "missing" })).rejects.toMatchObject({
      code: "missing-account",
    });
    expect(cancelled).toEqual(["account-a", "missing"]);
  });

  it("durably cleans an active start when cancellation races candidate publication", async () => {
    const calls: string[] = [];
    let finishStart: ((status: "connected" | "cancelled") => void) | undefined;
    let markStartEntered: (() => void) | undefined;
    const startEntered = new Promise<void>((resolve) => {
      markStartEntered = resolve;
    });
    const controller = new DesktopCodexBrowserSessionController(
      makeDependencies({
        startBrowserSession: () =>
          new Promise((resolve) => {
            finishStart = resolve;
            markStartEntered?.();
          }),
        cancelBrowserSession: () => {
          calls.push("cancel");
          finishStart?.("cancelled");
        },
        enqueueCleanup: async () => {
          calls.push("enqueue");
        },
        drainCleanup: async () => {
          calls.push("drain");
        },
        commitBrowserSession: async () => {
          calls.push("commit");
        },
      }),
    );

    const start = controller.start({ accountId: "account-a", expectedRevision: revisionA });
    await startEntered;
    const cancel = controller.cancel({ accountId: "account-a" });

    await expect(start).resolves.toMatchObject({ provider: "codex" });
    await expect(cancel).resolves.toMatchObject({ provider: "codex" });
    expect(calls).toEqual(["cancel", "enqueue", "drain", "drain"]);
  });
});
