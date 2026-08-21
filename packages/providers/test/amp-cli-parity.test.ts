import { describe, expect, it, vi } from "vite-plus/test";
import { amp, parseAmpUsage } from "../src/providers/amp.ts";
import type { ProviderContext, ProviderLocalProcessResult } from "../src/types.ts";
import monthlySubscription from "../../../Tests/CodexBarTests/Fixtures/Providers/Amp/monthly-subscription.txt?raw";
import daySubscription from "../../../Tests/CodexBarTests/Fixtures/Providers/Amp/day-subscription.txt?raw";

const dateParts = (timeZone: string, value: Date): Record<string, number> => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const result: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== "literal") result[part.type] = Number(part.value);
  }
  return result;
};

const zonedOffset = (timeZone: string, value: Date): number => {
  const parts = dateParts(timeZone, value);
  return (
    Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!) -
    value.getTime()
  );
};

const nextDailyReset = (nowMillis: number, timeZone: string, hour: number): string => {
  const now = new Date(nowMillis);
  const localNow = dateParts(timeZone, now);
  let localDate = new Date(Date.UTC(localNow.year!, localNow.month! - 1, localNow.day!, hour));
  let candidate = localDate.getTime() - zonedOffset(timeZone, localDate);
  candidate = localDate.getTime() - zonedOffset(timeZone, new Date(candidate));
  if (candidate <= nowMillis) {
    localDate = new Date(Date.UTC(localNow.year!, localNow.month! - 1, localNow.day! + 1, hour));
    candidate = localDate.getTime() - zonedOffset(timeZone, localDate);
    candidate = localDate.getTime() - zonedOffset(timeZone, new Date(candidate));
  }
  return new Date(candidate).toISOString();
};

const failure = (kind: string) => (message: string) => new Error(`${kind}:${message}`);

const context = (now: Date): ProviderContext =>
  ({
    settings: { get: () => undefined, getSecret: () => undefined },
    http: {
      get: async () => ({ status: 200, bodyText: "" }),
      getJSON: async () => ({ status: 200, bodyText: "", json: {} }),
      postJSON: async () => ({ status: 200, bodyText: "{}", json: {} }),
    },
    browser: { cookieHeader: async () => "" },
    env: {},
    date: {
      now: () => now,
      nowMillis: () => now.getTime(),
      iso: (value: string) => new Date(value).toISOString(),
      unixSeconds: (value: number) => new Date(value * 1_000).toISOString(),
      unixMillis: (value: number) => new Date(value).toISOString(),
      nextDailyReset: (timeZone: string, hour: number) =>
        nextDailyReset(now.getTime(), timeZone, hour),
    },
    format: {
      number: (value: number) => String(value),
      usd: (value: number) =>
        new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value),
      monthDay: () => "",
    },
    pct: (used: number, limit: number) => (used / limit) * 100,
    amountFromPercent: () => 0,
    fail: Object.fromEntries(
      [
        "authenticationExpired",
        "missingCredential",
        "permissionDenied",
        "rateLimited",
        "providerUnavailable",
        "parseFailure",
        "networkFailure",
        "apiFailure",
      ].map((kind) => [kind, failure(kind)]),
    ),
  }) as unknown as ProviderContext;

const unix = (seconds: number): Date => new Date(seconds * 1_000);
const iso = (value: string): Date => new Date(value);

const fetchAmp = async (
  result: ProviderLocalProcessResult,
  now = unix(1_700_000_000),
  run: (
    command: string,
    request: { readonly args: readonly string[]; readonly timeoutMs?: number },
  ) => Promise<ProviderLocalProcessResult> = async () => result,
) =>
  amp.fetchUsage({
    ...context(now),
    local: { run, readData: async () => undefined },
  });

describe("Swift-derived Amp CLI display parity", () => {
  it("parses current amp usage display text and keeps credits as details", () => {
    const now = unix(1_700_000_000);
    const snapshot = parseAmpUsage(
      `\u001B[2mSigned in as ampcode@3kh0.net (echo)\u001B[0m
Amp Free: $4.71/$10 remaining (replenishes +$0.42/hour) - https://ampcode.com/settings#amp-free
Individual credits: $25.64 remaining (set up automatic top-up to avoid running out) - https://ampcode.com/settings
Workspace meow: $10.22 remaining (set up automatic top-up to avoid running out) - https://ampcode.com/workspaces/meow
`,
      context(now),
    );
    expect(snapshot.primary?.usedPercent).toBeCloseTo(52.9, 3);
    expect(snapshot.primary).toMatchObject({
      windowMinutes: 1440,
      resetsAt: new Date(now.getTime() + (5.29 / 0.42) * 3600 * 1000).toISOString(),
    });
    expect(snapshot).toMatchObject({
      identity: {
        accountEmail: "ampcode@3kh0.net",
        accountOrganization: "echo",
        loginMethod: "Amp Free",
      },
      details: [
        {
          title: "Credits",
          rows: [
            { label: "Individual credits", value: "$25.64" },
            { label: "Workspace meow", value: "$10.22" },
          ],
        },
      ],
    });
    expect(snapshot).not.toHaveProperty("cost");
    expect(snapshot).not.toHaveProperty("providerCost");
    expect(snapshot.secondary).toBeUndefined();
  });

  it("parses percentage based amp free usage against the New York daily boundary", () => {
    const now = unix(1_700_000_000);
    const snapshot = parseAmpUsage(
      `Signed in as user@example.com (example)
Amp Free: 61% remaining today (resets daily) - https://ampcode.com/settings#amp-free
Individual credits: $9.86 remaining (set up automatic top-up to avoid running out)
Workspace example: $5.33 remaining (set up automatic top-up to avoid running out)
`,
      context(now),
    );
    expect(snapshot).toMatchObject({
      primary: {
        usedPercent: 39,
        windowMinutes: 1440,
        resetsAt: "2023-11-15T01:00:00.000Z",
        resetDescription: "resets daily",
      },
      identity: {
        accountEmail: "user@example.com",
        accountOrganization: "example",
        loginMethod: "Amp Free",
      },
      details: [
        {
          title: "Credits",
          rows: [
            { label: "Individual credits", value: "$9.86" },
            { label: "Workspace example", value: "$5.33" },
          ],
        },
      ],
    });
  });

  it("does not infer daily reset from percentage alone", () => {
    const snapshot = parseAmpUsage(
      "Signed in as user@example.com\nAmp Free: 61% remaining",
      context(unix(1_700_000_000)),
    );
    expect(snapshot.primary).toEqual({ usedPercent: 39, windowMinutes: 1440 });
  });

  it("parses the monthly subscription fixture and both metered pools", () => {
    const now = iso("2026-08-03T22:00:00Z");
    const snapshot = parseAmpUsage(monthlySubscription, context(now));
    expect(snapshot).toMatchObject({
      primary: {
        usedPercent: 27,
        windowMinutes: 43_200,
        resetsAt: "2026-09-03T22:00:00.000Z",
        resetDescription: "renews in 1 month",
      },
      secondary: {
        usedPercent: 9,
        windowMinutes: 43_200,
        resetsAt: "2026-09-03T22:00:00.000Z",
        resetDescription: "renews in 1 month",
      },
      extraRateWindows: [
        {
          id: "amp-free",
          title: "Amp Free",
          window: {
            usedPercent: 39,
            windowMinutes: 1440,
            resetsAt: "2026-08-04T00:00:00.000Z",
            resetDescription: "resets daily",
          },
        },
      ],
      identity: {
        accountEmail: "fixture@example.test",
        accountOrganization: "example",
        loginMethod: "Gigawatt",
      },
      details: [
        {
          title: "Credits",
          rows: [
            { label: "Individual credits", value: "$17.23" },
            { label: "Workspace meow", value: "$5.33" },
          ],
        },
      ],
    });
    expect(snapshot).not.toHaveProperty("cost");
  });

  it("parses the day-based subscription fixture", () => {
    const now = unix(1_700_000_000);
    const snapshot = parseAmpUsage(daySubscription, context(now));
    expect(snapshot).toMatchObject({
      primary: {
        usedPercent: 3,
        windowMinutes: 43_200,
        resetsAt: new Date(now.getTime() + 29 * 24 * 60 * 60 * 1000).toISOString(),
        resetDescription: "renews in 29 days",
      },
      secondary: {
        usedPercent: 0,
        windowMinutes: 43_200,
        resetsAt: new Date(now.getTime() + 29 * 24 * 60 * 60 * 1000).toISOString(),
      },
      identity: {
        accountEmail: "fixture@example.test",
        accountOrganization: "example",
        loginMethod: "Megawatt",
      },
    });
    expect(snapshot.extraRateWindows).toBeUndefined();
  });

  it("observes the New York free-tier boundary across daylight saving time", () => {
    const summerBefore = iso("2026-08-03T23:59:59Z");
    const summerAtBoundary = iso("2026-08-04T00:00:00Z");
    const winterBefore = iso("2026-01-16T00:59:59Z");
    expect(
      parseAmpUsage(monthlySubscription, context(summerBefore)).extraRateWindows?.[0]?.window
        .resetsAt,
    ).toBe("2026-08-04T00:00:00.000Z");
    expect(
      parseAmpUsage(monthlySubscription, context(summerAtBoundary)).extraRateWindows?.[0]?.window
        .resetsAt,
    ).toBe("2026-08-05T00:00:00.000Z");
    expect(
      parseAmpUsage(monthlySubscription, context(winterBefore)).extraRateWindows?.[0]?.window
        .resetsAt,
    ).toBe("2026-01-16T01:00:00.000Z");
  });

  it("parses the current Amp subscription line and keeps credits as details", () => {
    const now = iso("2026-08-18T12:00:00Z");
    const snapshot = parseAmpUsage(
      `Signed in as you@example.com (username)
Amp Megawatt Subscription: 100% other usage and 100% orb usage remaining - resets upon renewal in 1 month
Individual credits: $4.35 remaining (set up auto-reload to avoid running out) - https://ampcode.com/settings
`,
      context(now),
    );
    expect(snapshot).toMatchObject({
      primary: {
        usedPercent: 0,
        windowMinutes: 43_200,
        resetsAt: "2026-09-18T12:00:00.000Z",
      },
      secondary: { usedPercent: 0, resetsAt: "2026-09-18T12:00:00.000Z" },
      identity: { loginMethod: "Megawatt" },
      details: [{ title: "Credits", rows: [{ label: "Individual credits", value: "$4.35" }] }],
    });
  });

  it("clamps calendar-month renewal at the target month's last day", () => {
    const snapshot = parseAmpUsage(
      "Subscription Megawatt: 97% other usage and 100% orb usage remaining - resets upon renewal in 1 month",
      context(iso("2027-01-31T12:00:00Z")),
    );
    expect(snapshot.primary?.resetsAt).toBe("2027-02-28T12:00:00.000Z");
  });

  it("parses the legacy Amp subscription line format with a settings link", () => {
    const snapshot = parseAmpUsage(
      "Subscription Megawatt: 97% other usage and 100% orb usage remaining - resets upon renewal in 29 days - https://ampcode.com/settings#subscription",
      context(unix(1_700_000_000)),
    );
    expect(snapshot).toMatchObject({
      primary: { usedPercent: 3 },
      secondary: { usedPercent: 0 },
      identity: { loginMethod: "Megawatt" },
    });
  });

  it("keeps hourly replenishment reset when percentage text also exists", () => {
    const now = unix(1_700_000_000);
    const snapshot = parseAmpUsage(
      `Signed in as user@example.com
Amp Free: $6/$10 remaining (replenishes +$0.5/hour)
Amp Free: 61% remaining today (resets daily)
`,
      context(now),
    );
    expect(snapshot.primary).toEqual({
      usedPercent: 40,
      windowMinutes: 1200,
      resetsAt: new Date(now.getTime() + 8 * 3600 * 1000).toISOString(),
    });
  });

  it("parses individual credits without a free-tier window", () => {
    const snapshot = parseAmpUsage(
      `Signed in as paid@example.com
Individual credits: $25.64 remaining
`,
      context(unix(1_700_000_000)),
    );
    expect(snapshot.primary).toBeUndefined();
    expect(snapshot.secondary).toBeUndefined();
    expect(snapshot).toMatchObject({
      identity: { accountEmail: "paid@example.com", loginMethod: "Amp" },
      details: [{ title: "Credits", rows: [{ label: "Individual credits", value: "$25.64" }] }],
    });
  });

  it("parses workspace credits without a free-tier window", () => {
    const snapshot = parseAmpUsage(
      `Signed in as workspace@example.com (team)
Workspace Alpha Team: $1,234.56 remaining
Workspace Beta: $7 remaining
`,
      context(unix(1_700_000_000)),
    );
    expect(snapshot.primary).toBeUndefined();
    expect(snapshot).toMatchObject({
      details: [
        {
          title: "Credits",
          rows: [
            { label: "Workspace Alpha Team", value: "$1,234.56" },
            { label: "Workspace Beta", value: "$7.00" },
          ],
        },
      ],
    });
  });

  it("allows a signed-in identity that contains login", () => {
    const snapshot = parseAmpUsage(
      `Signed in as login@example.com (login-team)
Amp Free: $6/$10 remaining (replenishes +$0.5/hour)
`,
      context(unix(1_700_000_000)),
    );
    expect(snapshot.identity).toMatchObject({
      accountEmail: "login@example.com",
      accountOrganization: "login-team",
    });
  });

  it("omits hourly reset when replenishment is zero", () => {
    const snapshot = parseAmpUsage(
      "Signed in as user@example.com\nAmp Free: $80/$100 remaining",
      context(unix(1_700_030_000)),
    );
    expect(snapshot.primary).toEqual({ usedPercent: 20 });
  });

  it("runs the fixed amp usage command and prefers stdout", async () => {
    const run = vi.fn(async () => ({
      exitCode: 0,
      signal: undefined,
      stdout: `Signed in as cli@example.com (team)
Amp Free: $6/$10 remaining (replenishes +$0.5/hour)
Individual credits: $12.50 remaining
Workspace Test Team: $7.25 remaining
`,
      stderr: "ignored",
    }));
    await expect(
      fetchAmp({} as ProviderLocalProcessResult, unix(1_700_000_000), run),
    ).resolves.toMatchObject({
      primary: { usedPercent: 40 },
      identity: { accountEmail: "cli@example.com", accountOrganization: "team" },
      details: [
        {
          title: "Credits",
          rows: [
            { label: "Individual credits", value: "$12.50" },
            { label: "Workspace Test Team", value: "$7.25" },
          ],
        },
      ],
    });
    expect(run).toHaveBeenCalledWith("amp", { args: ["usage"], timeoutMs: 15_000 });
  });

  it("classifies signed-out CLI output as authentication expired", async () => {
    await expect(
      fetchAmp({
        exitCode: 1,
        signal: undefined,
        stdout: "Please sign in to Amp.",
        stderr: "",
      }),
    ).rejects.toThrow("authenticationExpired:Not logged in to Amp. Please log in via ampcode.com.");
  });

  it("classifies empty CLI output as a parse failure", async () => {
    await expect(
      fetchAmp({ exitCode: 0, signal: undefined, stdout: "  \n", stderr: "" }),
    ).rejects.toThrow("parseFailure:The Amp CLI returned no usage data.");
  });

  it("classifies a nonzero CLI failure as provider unavailable", async () => {
    await expect(
      fetchAmp({
        exitCode: 2,
        signal: undefined,
        stdout: "amp: unexpected error",
        stderr: "",
      }),
    ).rejects.toThrow("providerUnavailable:Amp CLI exited with status 2.");
  });

  it("does not accept parseable usage from a failed CLI process", async () => {
    await expect(
      fetchAmp({
        exitCode: 2,
        signal: undefined,
        stdout: "Signed in as stale@example.com\nAmp Free: $6/$10 remaining",
        stderr: "",
      }),
    ).rejects.toThrow("providerUnavailable:Amp CLI exited with status 2.");
  });

  it("keeps cancellation terminal", async () => {
    const abort = new DOMException("Process execution was cancelled.", "AbortError");
    await expect(
      fetchAmp({} as ProviderLocalProcessResult, unix(1_700_000_000), async () => {
        throw abort;
      }),
    ).rejects.toBe(abort);
  });
});
