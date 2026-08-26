import { describe, expect, it } from "vite-plus/test";
import type { DashboardSnapshotDTO, ProviderSettingsListDTO } from "@codexbar/contracts";

import {
  browserLoginActionState,
  browserLoginStatusFromDefaultSessionState,
  makeBrowserLoginMutationGate,
  makeDefaultBrowserSessionStatusLoader,
  makeOverviewLoader,
  costTotals,
  displayPercent,
  firstPartyProviderId,
  codexAccountLoginSuccessDisposition,
  historySince,
  implementationPresentation,
  shouldAutoCancelCodexAccountLogin,
  shouldAutoCancelCodexBrowserSession,
  shouldPublishCodexAccountLoginFailure,
  claudeSwapActivationRequest,
  safeDateFromTimestamp,
  codexBrowserSessionStatusForRoster,
} from "../src/renderer/view-model.ts";

const deferred = <Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (error: Error) => void;
} => {
  let resolve!: (value: Value) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Value>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const overviewFixture = (id: string): DashboardSnapshotDTO =>
  ({ providers: [{ id }] }) as unknown as DashboardSnapshotDTO;

const settingsFixture = (id: string): ProviderSettingsListDTO =>
  ({ providers: [{ provider: id }] }) as unknown as ProviderSettingsListDTO;

describe("desktop renderer view model", () => {
  it("cancels a pending Codex login only after leaving Codex and only once", () => {
    expect(shouldAutoCancelCodexAccountLogin(true, "openai", false)).toBe(true);
    expect(shouldAutoCancelCodexAccountLogin(true, "codex", false)).toBe(false);
    expect(shouldAutoCancelCodexAccountLogin(false, "openai", false)).toBe(false);
    expect(shouldAutoCancelCodexAccountLogin(true, "openai", true)).toBe(false);
  });

  it("cancels a Codex browser login when either provider or active account changes", () => {
    expect(shouldAutoCancelCodexBrowserSession("start", "codex", "a", "a")).toBe(false);
    expect(shouldAutoCancelCodexBrowserSession("start", "codex", "b", "a")).toBe(true);
    expect(shouldAutoCancelCodexBrowserSession("start", "openai", "a", "a")).toBe(true);
    expect(shouldAutoCancelCodexBrowserSession("cancel", "openai", "a", "a")).toBe(false);
    expect(shouldAutoCancelCodexBrowserSession(undefined, "codex", "a", "a")).toBe(false);
  });

  it("reconciles every successful Codex login without publishing a stale roster", () => {
    expect(codexAccountLoginSuccessDisposition(4, 4, "codex")).toEqual({
      publishRoster: true,
      reconcile: true,
    });
    expect(codexAccountLoginSuccessDisposition(4, 6, "codex")).toEqual({
      publishRoster: false,
      reconcile: true,
    });
    expect(codexAccountLoginSuccessDisposition(4, 4, "openai")).toEqual({
      publishRoster: false,
      reconcile: true,
    });
  });

  it("keeps stale and cancelled Codex login failures out of another provider", () => {
    expect(shouldPublishCodexAccountLoginFailure(4, 4, "codex", false)).toBe(true);
    expect(shouldPublishCodexAccountLoginFailure(4, 5, "codex", false)).toBe(false);
    expect(shouldPublishCodexAccountLoginFailure(4, 4, "openai", false)).toBe(false);
    expect(shouldPublishCodexAccountLoginFailure(4, 4, "codex", true)).toBe(false);
  });

  it("accepts Codex browser metadata only for the exact active roster revision", () => {
    const roster = {
      provider: "codex" as const,
      accounts: [
        { id: "account-a", label: "A", addedAt: 1 },
        { id: "account-b", label: "B", addedAt: 2 },
      ],
      activeIndex: 1,
      selectionAvailable: true,
      revision: "a".repeat(64),
    };
    const result = {
      provider: "codex" as const,
      revision: "a".repeat(64),
      statuses: [
        { accountId: "account-a", status: "absent" as const },
        { accountId: "account-b", status: "persisted" as const },
      ],
    };
    expect(codexBrowserSessionStatusForRoster(result, roster)).toBe("persisted");
    expect(
      codexBrowserSessionStatusForRoster({ ...result, revision: "b".repeat(64) }, roster),
    ).toBeUndefined();
    expect(
      codexBrowserSessionStatusForRoster(result, { ...roster, provider: "openai" }),
    ).toBeUndefined();
    expect(
      codexBrowserSessionStatusForRoster(
        { ...result, statuses: [{ accountId: "account-a", status: "persisted" }] },
        roster,
      ),
    ).toBeUndefined();
  });

  it("forwards only an eligible opaque Claude account ID", () => {
    expect(
      claudeSwapActivationRequest(
        { id: "claude" },
        { id: "source-account", active: false, canActivate: true },
      ),
    ).toEqual({ provider: "claude", accountId: "source-account" });
    expect(
      claudeSwapActivationRequest(
        { id: "claude" },
        { id: "source-account", active: true, canActivate: true },
      ),
    ).toBeUndefined();
    expect(
      claudeSwapActivationRequest(
        { id: "openai" },
        { id: "source-account", active: false, canActivate: true },
      ),
    ).toBeUndefined();
  });

  it("maps persisted default browser sessions into fail-closed login presentation", () => {
    expect(browserLoginStatusFromDefaultSessionState("persisted")).toBe("connected");
    expect(browserLoginStatusFromDefaultSessionState("absent")).toBe("idle");
    expect(browserLoginStatusFromDefaultSessionState("unavailable")).toBe("unavailable");
    expect(
      browserLoginActionState("unavailable", "Grok", {
        waiting: "Waiting for login...",
        connected: "T3 Chat connected",
        start: "Sign in to T3 Chat",
        logout: "Sign out",
        unavailable: "Unavailable",
      }),
    ).toEqual({
      loginLabel: "Grok: Unavailable",
      loginDisabled: true,
      showLogout: false,
      logoutLabel: "Grok: Sign out",
      logoutDisabled: true,
    });
    expect(
      browserLoginActionState("connected", "Grok", {
        waiting: "Waiting for login...",
        connected: "T3 Chat connected",
        start: "Sign in to T3 Chat",
        logout: "Sign out",
        unavailable: "Unavailable",
      }),
    ).toMatchObject({
      loginLabel: "Grok connected",
      loginDisabled: false,
      showLogout: true,
    });
  });

  it("ignores stale status reads after login or logout invalidates them", async () => {
    let resolveFirst:
      | ((value: {
          readonly schemaVersion: 1;
          readonly claudeDefault: "persisted";
          readonly t3chatDefault: "persisted";
          readonly grokDefault: "persisted";
        }) => void)
      | undefined;
    const first = new Promise<{
      readonly schemaVersion: 1;
      readonly claudeDefault: "persisted";
      readonly t3chatDefault: "persisted";
      readonly grokDefault: "persisted";
    }>((resolve) => {
      resolveFirst = resolve;
    });
    const published: unknown[] = [];
    const loader = makeDefaultBrowserSessionStatusLoader({
      read: () => first,
      publish: (statuses) => published.push(statuses),
    });
    const pending = loader.load();
    loader.invalidate();
    resolveFirst?.({
      schemaVersion: 1,
      claudeDefault: "persisted",
      t3chatDefault: "persisted",
      grokDefault: "persisted",
    });
    await pending;
    expect(published).toEqual([]);
  });

  it("serializes Claude, T3, and Grok login mutations before the renderer rerenders", () => {
    const gate = makeBrowserLoginMutationGate();
    expect(gate.tryStart()).toBe(true);
    expect(gate.tryStart()).toBe(false);
    gate.finish();
    expect(gate.tryStart()).toBe(true);
  });

  it("publishes only the latest status read and fails closed", async () => {
    const published: unknown[] = [];
    let attempt = 0;
    const loader = makeDefaultBrowserSessionStatusLoader({
      read: () => {
        attempt += 1;
        return attempt === 1
          ? Promise.reject(new Error("locked keyring"))
          : Promise.resolve({
              schemaVersion: 1 as const,
              claudeDefault: "persisted" as const,
              t3chatDefault: "absent" as const,
              grokDefault: "persisted" as const,
            });
      },
      publish: (statuses) => published.push(statuses),
    });
    await loader.load();
    await loader.load();
    expect(published).toEqual([
      { claude: "unavailable", t3chat: "unavailable", grok: "unavailable" },
      { claude: "connected", t3chat: "idle", grok: "connected" },
    ]);
  });

  it("publishes only the newest overview/settings response", async () => {
    const firstOverview = deferred<DashboardSnapshotDTO>();
    const firstSettings = deferred<ProviderSettingsListDTO>();
    const secondOverview = deferred<DashboardSnapshotDTO>();
    const secondSettings = deferred<ProviderSettingsListDTO>();
    const overviewReads = [firstOverview, secondOverview];
    const settingsReads = [firstSettings, secondSettings];
    const published: unknown[] = [];
    const errors: string[] = [];
    const loader = makeOverviewLoader({
      readOverview: () => overviewReads.shift()!.promise,
      readProviderSettings: () => settingsReads.shift()!.promise,
      publish: (publication) => published.push(publication),
      publishError: () => errors.push("error"),
    });
    loader.activate();

    const staleLoad = loader.load();
    const latestLoad = loader.load();
    secondOverview.resolve(overviewFixture("second"));
    secondSettings.resolve(settingsFixture("second"));
    await latestLoad;
    expect(published).toEqual([
      { overview: overviewFixture("second"), providerSettings: settingsFixture("second") },
    ]);

    firstOverview.resolve(overviewFixture("first"));
    firstSettings.resolve(settingsFixture("first"));
    await staleLoad;
    expect(published).toEqual([
      { overview: overviewFixture("second"), providerSettings: settingsFixture("second") },
    ]);
    expect(errors).toEqual([]);
  });

  it("ignores stale overview errors after a newer success", async () => {
    const firstOverview = deferred<DashboardSnapshotDTO>();
    const firstSettings = deferred<ProviderSettingsListDTO>();
    const secondOverview = deferred<DashboardSnapshotDTO>();
    const secondSettings = deferred<ProviderSettingsListDTO>();
    const overviewReads = [firstOverview, secondOverview];
    const settingsReads = [firstSettings, secondSettings];
    const published: unknown[] = [];
    const errors: string[] = [];
    const loader = makeOverviewLoader({
      readOverview: () => overviewReads.shift()!.promise,
      readProviderSettings: () => settingsReads.shift()!.promise,
      publish: (publication) => published.push(publication),
      publishError: () => errors.push("error"),
    });
    loader.activate();

    const staleLoad = loader.load();
    const latestLoad = loader.load();
    secondOverview.resolve(overviewFixture("latest"));
    secondSettings.resolve(settingsFixture("latest"));
    await latestLoad;

    firstOverview.reject(new Error("stale"));
    firstSettings.resolve(settingsFixture("stale"));
    await staleLoad;

    expect(published).toEqual([
      { overview: overviewFixture("latest"), providerSettings: settingsFixture("latest") },
    ]);
    expect(errors).toEqual([]);
  });

  it("does not publish overview success or error after dispose", async () => {
    const pendingOverview = deferred<DashboardSnapshotDTO>();
    const pendingSettings = deferred<ProviderSettingsListDTO>();
    const published: unknown[] = [];
    const errors: string[] = [];
    const loader = makeOverviewLoader({
      readOverview: () => pendingOverview.promise,
      readProviderSettings: () => pendingSettings.promise,
      publish: (publication) => published.push(publication),
      publishError: () => errors.push("error"),
    });
    loader.activate();

    const load = loader.load();
    loader.dispose();
    loader.dispose();
    pendingOverview.resolve(overviewFixture("disposed"));
    pendingSettings.resolve(settingsFixture("disposed"));
    await load;

    expect(published).toEqual([]);
    expect(errors).toEqual([]);

    await loader.load();
    expect(published).toEqual([]);
    expect(errors).toEqual([]);

    loader.activate();
    await loader.load();
    expect(published).toEqual([
      {
        overview: overviewFixture("disposed"),
        providerSettings: settingsFixture("disposed"),
      },
    ]);
  });

  it("keeps the default browser login UI requests closed over Claude, T3, and Grok", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../src/renderer/index.tsx", import.meta.url), "utf8"),
    );
    expect(source).toContain('type BrowserLoginProvider = "claude" | "t3chat" | "grok"');
    expect(source).toContain('claude: { provider: "claude", accountId: "default" }');
    expect(source).toContain('t3chat: { provider: "t3chat", accountId: "default" }');
    expect(source).toContain('grok: { provider: "grok", accountId: "default" }');
    expect(source).toContain("setClaudeStatus(statuses.claude)");
    expect(source).toContain('startBrowserLogin("claude", setClaudeStatus)');
    expect(source).toContain('logoutBrowserLogin("claude", setClaudeStatus)');
  });

  it("wires overview startup, background invalidation, cleanup, and manual refresh through one loader", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../src/renderer/index.tsx", import.meta.url), "utf8"),
    );
    expect(source).toContain("makeOverviewLoader");
    expect(source).toContain("const loadOverview = (): Promise<void> => overviewLoader.load()");
    expect(source).toContain("overviewLoader.activate();");
    expect(source).toContain("void overviewLoader.load();");
    expect(source).toContain("window.codexbar.onOverviewUpdated");
    expect(source).toContain("const unsubscribe");
    expect(source).toContain("unsubscribe();");
    expect(source).toContain("overviewLoader.dispose();");
    expect(source).toContain(".then(loadOverview)");
  });

  it("never represents a partial implementation as release-ready", () => {
    expect(implementationPresentation({ implementationStatus: "partial" })).toBe("parity-pending");
    expect(implementationPresentation({ implementationStatus: "unported" })).toBe("unported");
  });

  it("bounds malformed usage values before they reach progress geometry", () => {
    expect(displayPercent(-3)).toBe(0);
    expect(displayPercent(36.5)).toBe(36.5);
    expect(displayPercent(140)).toBe(100);
    expect(displayPercent(Number.NaN)).toBe(0);
    expect(displayPercent(Number.POSITIVE_INFINITY)).toBe(0);
    expect(displayPercent(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it("rejects timestamps that JavaScript cannot render safely", () => {
    expect(safeDateFromTimestamp(0)?.toISOString()).toBe("1970-01-01T00:00:00.000Z");
    expect(safeDateFromTimestamp(-1)).toBeUndefined();
    expect(safeDateFromTimestamp(8_640_000_000_000_001)).toBeUndefined();
    expect(safeDateFromTimestamp(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it("only permits the fixed first-party roster through the refresh UI", () => {
    expect(firstPartyProviderId("codex")).toBe("codex");
    expect(firstPartyProviderId("fixture-meter")).toBeUndefined();
  });

  it("keeps history ranges bounded and aggregates the renderer-safe cost DTO", () => {
    expect(historySince(0, 86_400_000)).toBe(0);
    expect(historySince(7, 1_000_000_000)).toBe(395_200_000);
    expect(
      costTotals([
        { providerId: "codex", recordedAt: 1, inputTokens: 3, outputTokens: 5, costUsd: 0.01 },
        { providerId: "codex", recordedAt: 2, inputTokens: 7, outputTokens: 11, costUsd: 0.03 },
      ]),
    ).toEqual({ inputTokens: 10, outputTokens: 16, costUsd: 0.04 });
  });
});
