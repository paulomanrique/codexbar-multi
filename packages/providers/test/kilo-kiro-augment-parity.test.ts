import { describe, expect, it } from "vite-plus/test";
import { kilo } from "../src/providers/kilo.ts";
import { kiro } from "../src/providers/kiro.ts";
import { augment } from "../src/providers/augment.ts";
import type { ProviderContext } from "../src/types.ts";
const context = (data: unknown, values: Record<string, string>) =>
  ({
    settings: { get: (k: string) => values[k], getSecret: (k: string) => values[k] },
    http: {
      get: async () => ({ status: 200, bodyText: JSON.stringify(data) }),
      getJSON: async () => ({ status: 200, bodyText: JSON.stringify(data), json: data }),
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
    format: { number: (x: number) => String(x), usd: (x: number) => `$${x}`, monthDay: () => "" },
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
describe("Swift-derived Kilo Kiro Augment boundary parity", () => {
  it("keeps stable provider strategy IDs", () =>
    expect([kilo, kiro, augment].map((p) => [p.descriptor.id, p.id])).toEqual([
      ["kilo", "kilo.api"],
      ["kiro", "kiro.cli"],
      ["augment", "augment.web"],
    ]));
  it("maps Kilo profile quota", async () =>
    expect(
      await kilo.fetchUsage(
        context({ plan: "pro", usage: { used: 2, limit: 10 } }, { KILO_BEARER_TOKEN: "token" }),
      ),
    ).toMatchObject({ primary: { usedPercent: 20 }, identity: { loginMethod: "pro" } }));
  it("parses Kiro collected CLI output", async () =>
    expect(
      await kiro.fetchUsage({
        ...context({}, {}),
        local: {
          run: async () => ({ exitCode: 0, signal: undefined, stdout: "20% used", stderr: "" }),
          readData: async () => undefined,
        },
      }),
    ).toEqual({ primary: { usedPercent: 20 } }));
  it("maps Augment web session usage", async () =>
    expect(
      await augment.fetchUsage(
        context(
          { plan: "Pro", usage: { usedPercent: 30 } },
          { AUGMENT_COOKIE_HEADER: "session=ok" },
        ),
      ),
    ).toMatchObject({ primary: { usedPercent: 30 }, identity: { loginMethod: "Pro" } }));
});
