import { describe, expect, it } from "vite-plus/test";
import { claude, parseClaudeCliUsagePanel, parseClaudeCLIUsage } from "../src/providers/claude.ts";
import type { ProviderContext } from "../src/types.ts";

const failure = (kind: string) => (message: string) => {
  const err = new Error(`${kind}: ${message}`) as Error & { kind: string };
  (err as unknown as { kind: string }).kind = kind;
  return err;
};
const ctx = (): ProviderContext =>
  ({
    settings: { get: () => undefined, getSecret: () => undefined },
    http: {
      get: async () => ({ status: 200, bodyText: "{}" }),
      getJSON: async () => ({ status: 200, bodyText: "{}", json: {} }),
      postJSON: async () => ({ status: 200, bodyText: "{}", json: {} }),
    },
    browser: { cookieHeader: async () => "" },
    env: {},
    date: {
      now: () => new Date("2026-08-20T12:00:00Z"),
      nowMillis: () => Date.parse("2026-08-20T12:00:00Z"),
      iso: (v: string) => new Date(v).toISOString(),
      unixSeconds: (v: number) => new Date(v * 1000).toISOString(),
      unixMillis: (v: number) => new Date(v).toISOString(),
      nextDailyReset: () => "",
    },
    format: { number: String, usd: (value: number) => `$${value}`, monthDay: () => "" },
    pct: (used: number, limit: number) => (used / limit) * 100,
    amountFromPercent: (percent: number, limit: number) => (percent / 100) * limit,
    fail: {
      authenticationExpired: failure("authentication-expired"),
      missingCredential: failure("missing-credential"),
      permissionDenied: failure("permission-denied"),
      rateLimited: failure("rate-limited"),
      providerUnavailable: failure("provider-unavailable"),
      parseFailure: failure("parse-failure"),
      networkFailure: failure("network-failure"),
      apiFailure: failure("api-failure"),
    },
  }) as unknown as ProviderContext;

const panel = (
  sessionLeft: number,
  weeklyLeft: number,
  sessionReset = "Resets 11am (Europe/Vienna)",
  weeklyReset = "Resets Nov 21 at 5am (Europe/Vienna)",
) => `
Settings: Claude Usage
Current session
${sessionLeft}% left
${sessionReset}
Current week (all models)
${weeklyLeft}% left
${weeklyReset}
`;

describe("Claude CLI panel parser (Swift fixtures)", () => {
  it("converts exact session/week percents left -> used", () => {
    const snap = parseClaudeCliUsagePanel(panel(20, 30), ctx());
    expect(snap.primary.usedPercent).toBe(80);
    expect(snap.primary.windowMinutes).toBe(300);
    expect(snap.primary.resetDescription).toBe("Resets 11am (Europe/Vienna)");
    expect(snap.secondary?.usedPercent).toBe(70);
    expect(snap.secondary?.windowMinutes).toBe(10_080);
    expect(snap.secondary?.resetDescription).toBe("Resets Nov 21 at 5am (Europe/Vienna)");
    expect(snap.dataConfidence).toBe("percentOnly");
    expect(snap.identity.providerId).toBe("claude");
  });

  it("handles missing weekly label as absent secondary", () => {
    const text = `
Settings: Claude Usage
Current session
40% left
Resets tomorrow
`;
    const snap = parseClaudeCliUsagePanel(text, ctx());
    expect(snap.primary.usedPercent).toBe(60);
    expect(snap.secondary).toBeUndefined();
  });

  it("fails closed for missing Current session label", () => {
    const text = `
Settings: Claude Usage
Current week (all models)
50% left
`;
    expect(() => parseClaudeCliUsagePanel(text, ctx())).toThrow("parse-failure");
  });

  it("does not borrow the weekly percentage for an incomplete session section", () => {
    const text = `
Settings: Claude Usage
Current session
Loading usage data
Current week (all models)
50% left
`;
    expect(() => parseClaudeCliUsagePanel(text, ctx())).toThrow("parse-failure");
  });

  it("does not guess whether an unlabeled percentage is used or remaining", () => {
    const text = `
Settings: Claude Usage
Current session
50%
`;
    expect(() => parseClaudeCliUsagePanel(text, ctx())).toThrow("parse-failure");
  });

  it("fails closed for subscription notice without numbers", () => {
    const text = "You are currently using your subscription to power your Claude Code usage";
    expect(() => parseClaudeCliUsagePanel(text, ctx())).toThrow("provider-unavailable");
    // never fabricates zero
    try {
      parseClaudeCliUsagePanel(text, ctx());
    } catch (e) {
      expect(String(e)).not.toContain("usedPercent");
    }
  });

  it("strips ANSI and control sequences", () => {
    const ansi = `\x1b[31mCurrent session\x1b[0m\n\x1b[2K80% left\nCurrent week (all models)\n\x1b[33m60% left\x1b[0m`;
    const snap = parseClaudeCliUsagePanel(ansi, ctx());
    expect(snap.primary.usedPercent).toBe(20);
    expect(snap.secondary?.usedPercent).toBe(40);
  });

  it("preserves source/confidence as percentOnly and no fabricated identity", () => {
    const snap = parseClaudeCliUsagePanel(panel(93, 79, "Resets 4:00PM", "Resets 11:00PM"), ctx());
    expect(snap.dataConfidence).toBe("percentOnly");
    expect("accountEmail" in snap.identity).toBe(false);
    expect("accountOrganization" in snap.identity).toBe(false);
  });

  it("keeps JSON parsing via CLAUDE_CLI_USAGE_JSON seam", () => {
    const json = JSON.stringify({ session_5h: { pct_used: 7 }, week_all_models: { pct_used: 21 } });
    expect(parseClaudeCLIUsage(json, ctx()).primary.usedPercent).toBe(7);
  });

  it("rejects NUL and oversized output", () => {
    expect(() => parseClaudeCliUsagePanel("Current session\u0000 10% left", ctx())).toThrow();
    expect(() => parseClaudeCliUsagePanel("x".repeat(1024 * 1024 + 1), ctx())).toThrow();
    expect(() =>
      parseClaudeCliUsagePanel(`Current session\n${"é".repeat(600_000)}% left`, ctx()),
    ).toThrow();
  });

  it("exposes strategy ids and app-auto order admin->oauth->cli->web", () => {
    const ids = (claude.descriptor.strategies ?? []).map((s) => s.id);
    expect(ids).toEqual(["claude.admin-api", "claude.oauth", "claude.cli", "claude.web"]);
    expect(claude.descriptor.strategy?.id).toBe("claude.auto");
  });
});
