import { describe, expect, it } from "vite-plus/test";

import {
  PluginSandboxProtocolVersion,
  PluginExecutionCache,
  QuickJsPluginExecution,
  nextDailyResetMillis,
  type PluginBrokerRequestMessage,
  type PluginSandboxCapabilityRequest,
} from "../src/index.js";

async function eventually<T>(read: () => T | undefined): Promise<T> {
  for (let index = 0; index < 50; index += 1) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("value was not produced");
}

describe("QuickJS user-plugin execution", () => {
  it("brokers HTTP through the host without exposing host globals or secrets", async () => {
    const messages: (PluginBrokerRequestMessage | PluginSandboxCapabilityRequest)[] = [];
    const execution = new QuickJsPluginExecution("execution-1", (message) =>
      messages.push(message),
    );
    const result = execution.execute(`
      if (typeof process !== "undefined" || typeof require !== "undefined" || typeof fetch !== "undefined" || typeof setTimeout !== "undefined") throw new Error("host globals leaked");
      defineProvider({
        id: "sample-plugin", name: "Sample", endpoints: ["https://api.example.com"], settings: [],
        async fetchUsage(ctx) {
          const payload = await ctx.http.getJSON("https://api.example.com/v1", { includeStatus: true });
          return { primary: { usedPercent: payload.json.used }, details: [{ title: "status", rows: [{ label: "HTTP", value: String(payload.status) }] }] };
        }
      });
    `);
    const message = await eventually(() => messages[0]);
    if (message.type !== "http") throw new Error("expected HTTP broker request");
    expect(message).toMatchObject({
      type: "http",
      request: { url: "https://api.example.com/v1", includeStatus: true },
    });
    execution.receive({
      version: PluginSandboxProtocolVersion,
      type: "broker-response",
      executionId: "execution-1",
      message: {
        version: 1,
        type: "response",
        id: message.id,
        ok: true,
        response: {
          body: new TextEncoder().encode('{"used":37}'),
          headers: { "x-safe": "ok" },
          status: 200,
        },
      },
    });
    await expect(result).resolves.toMatchObject({ primary: { usedPercent: 37 } });
  });

  it("fails closed for malformed and oversized guest output", async () => {
    const malformed = new QuickJsPluginExecution("malformed", () => undefined);
    await expect(
      malformed.execute(`defineProvider({ fetchUsage() { return []; } })`),
    ).rejects.toMatchObject({ kind: "invalid-snapshot" });
    const oversized = new QuickJsPluginExecution("oversized", () => undefined);
    await expect(
      oversized.execute(
        `defineProvider({ fetchUsage() { return { value: "x".repeat(1024 * 1024 + 1) }; } })`,
      ),
    ).rejects.toMatchObject({ kind: "response-too-large" });
  });

  it("keeps declared settings synchronous while browser cookie access remains capability-brokered", async () => {
    const messages: (PluginBrokerRequestMessage | PluginSandboxCapabilityRequest)[] = [];
    const execution = new QuickJsPluginExecution("capabilities", (message) =>
      messages.push(message),
    );
    const result = execution.execute(
      `
      defineProvider({ async fetchUsage(ctx) { const plain = ctx.settings.get("baseUrl"); const secret = ctx.settings.getSecret("apiKey"); const cookie = await ctx.browser.cookieHeader("example.com"); return { details: [{ rows: [{ label: "configured", value: String(Boolean(plain && secret && cookie)) }] }] }; } });
    `,
      {
        settings: {
          plain: { baseUrl: "https://api.example.com" },
          secure: { apiKey: "host-secret" },
        },
        settingKinds: { baseUrl: "plain", apiKey: "secure" },
      },
    );
    const cookieRequest = await eventually(() => messages[0]);
    if (cookieRequest.type !== "capability-request") throw new Error("expected capability request");
    expect(cookieRequest).toMatchObject({ capability: "cookie", key: "example.com" });
    execution.receive({
      version: PluginSandboxProtocolVersion,
      type: "capability-response",
      executionId: "capabilities",
      id: cookieRequest.id,
      ok: true,
      value: "session=host-only",
    });
    await expect(result).resolves.toMatchObject({ details: [{ rows: [{ value: "true" }] }] });
  });

  it("rejects undeclared and mismatched synchronous setting reads inside the guest", async () => {
    const execution = new QuickJsPluginExecution("settings-kinds", () => undefined);
    await expect(
      execution.execute(
        `defineProvider({ fetchUsage(ctx) { let undeclared = false, mismatch = false; try { ctx.settings.get("missing"); } catch { undeclared = true; } try { ctx.settings.get("apiKey"); } catch { mismatch = true; } return { details: [{ rows: [{ label: "undeclared", value: String(undeclared) }, { label: "mismatch", value: String(mismatch) }] }] }; } })`,
        {
          settings: { plain: {}, secure: { apiKey: "secret" } },
          settingKinds: { apiKey: "secure" },
        },
      ),
    ).resolves.toMatchObject({ details: [{ rows: [{ value: "true" }, { value: "true" }] }] });
  });

  it("interrupts a running guest when cancelled", async () => {
    const execution = new QuickJsPluginExecution("cancelled", () => undefined);
    const result = execution.execute(
      `defineProvider({ fetchUsage() { return new Promise(() => {}); } })`,
    );
    execution.terminate();
    await expect(result).rejects.toMatchObject({ kind: "cancelled" });
  });

  it("keeps upstream pct semantics for zero or invalid limits", async () => {
    const execution = new QuickJsPluginExecution("pct", () => undefined);
    await expect(
      execution.execute(
        `defineProvider({ fetchUsage(ctx) { return { details: [{ rows: [{ label: "pct", value: String(ctx.pct(3, 0)) }, { label: "invalid", value: String(ctx.pct(3, NaN)) }] }] }; } })`,
      ),
    ).resolves.toMatchObject({ details: [{ rows: [{ value: "100" }, { value: "100" }] }] });
  });

  it("provides a frozen deterministic timezone environment and IANA/DST daily reset", async () => {
    const execution = new QuickJsPluginExecution("timezone", () => undefined);
    await expect(
      execution.execute(
        `defineProvider({ fetchUsage(ctx) { let frozen = false; try { ctx.env.timeZone = "UTC"; } catch { frozen = true; } const reset = ctx.date.nextDailyReset("America/Chicago", 3); return { primary: { usedPercent: 1, resetsAt: ctx.date.iso(reset) }, details: [{ rows: [{ label: "zone", value: ctx.env.timeZone }, { label: "frozen", value: String(frozen) }, { label: "reset", value: reset.toISOString() }] }] }; } })`,
        { nowMillis: Date.parse("2026-03-08T07:00:00Z"), timeZone: "America/Chicago" },
      ),
    ).resolves.toMatchObject({
      primary: { resetsAt: "2026-03-08T08:00:00.000Z" },
      details: [
        {
          rows: [
            { value: "America/Chicago" },
            { value: "true" },
            { value: "2026-03-08T08:00:00.000Z" },
          ],
        },
      ],
    });
    expect(nextDailyResetMillis(Date.parse("2026-08-20T03:00:00Z"), "America/Chicago", 0)).toBe(
      Date.parse("2026-08-20T05:00:00Z"),
    );
    expect(() => nextDailyResetMillis(0, "Not/AZone", 0)).toThrow(RangeError);
  });

  it("persists bounded JSON cache per plugin across serial executions with TTL", async () => {
    const cache = new PluginExecutionCache();
    const source = `defineProvider({ fetchUsage(ctx) { const cached = ctx.cache.get("usage"); if (cached === null) ctx.cache.set("usage", { marker: "persisted" }, 5); return { details: [{ rows: [{ label: "cache", value: cached === null ? "miss" : cached.marker }] }] }; } })`;
    const run = (id: string, pluginId: string, nowMillis: number) =>
      new QuickJsPluginExecution(id, () => undefined, { pluginId, cache }).execute(source, {
        nowMillis,
      });
    await expect(run("one", "plugin-a", 1_000)).resolves.toMatchObject({
      details: [{ rows: [{ value: "miss" }] }],
    });
    await expect(run("two", "plugin-a", 2_000)).resolves.toMatchObject({
      details: [{ rows: [{ value: "persisted" }] }],
    });
    await expect(run("three", "plugin-b", 2_000)).resolves.toMatchObject({
      details: [{ rows: [{ value: "miss" }] }],
    });
    await expect(run("four", "plugin-a", 7_000)).resolves.toMatchObject({
      details: [{ rows: [{ value: "miss" }] }],
    });
    cache.set("plugin-a", "ignored", "value", 0, 7_000);
    expect(cache.get("plugin-a", "ignored", 7_000)).toBeUndefined();
  });
});
