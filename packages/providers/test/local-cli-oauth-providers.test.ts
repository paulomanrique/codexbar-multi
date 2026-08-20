import { describe, expect, it, vi } from "vite-plus/test";
import { amp, parseAmpUsage } from "../src/providers/amp.ts";
import { jetbrains } from "../src/providers/jetbrains.ts";
import { kiro } from "../src/providers/kiro.ts";
import { zed } from "../src/providers/zed.ts";
import type { ProviderContext } from "../src/types.ts";
const ctx = (json: unknown = {}) =>
  ({
    settings: {
      get: (key: string) =>
        (({ ZED_USER_ID: "u", ZED_ACCESS_TOKEN: "t" }) as Record<string, string>)[key],
      getSecret: (key: string) => (({ ZED_ACCESS_TOKEN: "t" }) as Record<string, string>)[key],
    },
    http: {
      get: async () => ({ status: 200, bodyText: JSON.stringify(json) }),
      getJSON: async () => ({ status: 200, bodyText: JSON.stringify(json), json }),
      postJSON: async () => ({ status: 200, bodyText: "{}", json: {} }),
    },
    browser: { cookieHeader: async () => "" },
    env: {},
    date: {
      now: () => new Date(),
      nowMillis: () => 0,
      iso: (x: string) => new Date(x).toISOString(),
      unixSeconds: (x: number) => new Date(x * 1000).toISOString(),
      unixMillis: (x: number) => new Date(x).toISOString(),
      nextDailyReset: () => "",
    },
    format: {
      number: (x: number) => String(x),
      usd: (x: number) => `$${x.toFixed(2)}`,
      monthDay: () => "",
    },
    pct: (x: number, y: number) => (x / y) * 100,
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
      ].map((k) => [k, (m: string) => new Error(`${k}:${m}`)]),
    ),
  }) as unknown as ProviderContext;
describe("Swift-derived local/CLI provider domains", () => {
  it("parses Amp CLI quota text", () =>
    expect(parseAmpUsage("Plan: Pro\nUsage: 25%\nBalance: $12.50", ctx())).toMatchObject({
      primary: { usedPercent: 25 },
      identity: { loginMethod: "Pro" },
    }));
  it("runs Amp through the named local broker instead of a settings fixture", async () => {
    const run = vi.fn(async () => ({
      exitCode: 0,
      signal: undefined,
      stdout: "Plan: Pro\nUsage: 25%\nBalance: $12.50",
      stderr: "",
    }));
    const context = ctx() as ProviderContext;
    await expect(
      amp.fetchUsage({ ...context, local: { run, readData: async () => undefined } }),
    ).resolves.toMatchObject({ primary: { usedPercent: 25 } });
    expect(run).toHaveBeenCalledWith("amp", { args: ["usage"], timeoutMs: 15_000 });
  });
  it("classifies a Kiro login prompt from the named local broker", async () => {
    await expect(
      kiro.fetchUsage({
        ...(ctx() as ProviderContext),
        local: {
          run: async () => ({
            exitCode: 1,
            signal: undefined,
            stdout: "Not logged in. Run kiro-cli login first.",
            stderr: "",
          }),
          readData: async () => undefined,
        },
      }),
    ).rejects.toThrow("authenticationExpired");
  });
  it("obtains JetBrains quota XML through the named local data broker", async () => {
    const readData = vi.fn(async () => ({
      text: `<component name="AIAssistantQuotaManager2"><option name="quotaInfo" value="{&quot;current&quot;:&quot;5&quot;,&quot;maximum&quot;:&quot;10&quot;}"/></component>`,
      label: "WebStorm 2026.1",
    }));
    await expect(
      jetbrains.fetchUsage({
        ...(ctx() as ProviderContext),
        local: {
          run: async () => ({ exitCode: 0, signal: undefined, stdout: "", stderr: "" }),
          readData,
        },
      }),
    ).resolves.toMatchObject({
      primary: { usedPercent: 50 },
      identity: { organization: "WebStorm 2026.1" },
    });
    expect(readData).toHaveBeenCalledWith("jetbrains-ai-quota", undefined);
  });
  it("maps Zed edit predictions from injected credentials", async () =>
    expect(
      await zed.fetchUsage(
        ctx({
          user: { github_login: "octo" },
          plan: {
            plan_v3: "zed pro",
            usage: { edit_predictions: { used: 2, limit: 10 } },
            subscription_period: { ended_at: "2026-09-01T00:00:00Z" },
          },
        }),
      ),
    ).toMatchObject({
      primary: { usedPercent: 20 },
      identity: { accountID: "octo", loginMethod: "Zed Pro" },
    }));
});
