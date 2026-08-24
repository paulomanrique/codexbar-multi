import { describe, expect, it } from "vite-plus/test";

import {
  browserLoginActionState,
  browserLoginStatusFromDefaultSessionState,
  makeBrowserLoginMutationGate,
  makeDefaultBrowserSessionStatusLoader,
  costTotals,
  displayPercent,
  firstPartyProviderId,
  historySince,
  implementationPresentation,
  claudeSwapActivationRequest,
  safeDateFromTimestamp,
} from "../src/renderer/view-model.ts";

describe("desktop renderer view model", () => {
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
