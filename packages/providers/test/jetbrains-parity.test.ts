import { describe, expect, it } from "vite-plus/test";
import { parseJetBrainsQuota } from "../src/providers/jetbrains.ts";
import type { ProviderContext } from "../src/types.ts";
const ctx = {
  pct: (a: number, b: number) => (a / b) * 100,
  date: { iso: (x: string) => new Date(x).toISOString() },
  fail: { parseFailure: (x: string) => new Error(x) },
} as unknown as ProviderContext;
describe("Swift-derived JetBrains quota parser", () =>
  it("parses XML entity JSON and uses refill rather than quota until", () =>
    expect(
      parseJetBrainsQuota(
        `<component name="AIAssistantQuotaManager2"><option name="quotaInfo" value="{&#10;&quot;type&quot;:&quot;Available&quot;,&quot;current&quot;:&quot;25&quot;,&quot;maximum&quot;:&quot;100&quot;,&quot;until&quot;:&quot;2027-01-01T00:00:00Z&quot;}"/><option name="nextRefill" value="{&quot;next&quot;:&quot;2026-09-01T00:00:00Z&quot;}"/></component>`,
        ctx,
      ),
    ).toEqual({
      primary: { usedPercent: 25, resetsAt: "2026-09-01T00:00:00.000Z" },
      identity: { loginMethod: "Available" },
    })));
