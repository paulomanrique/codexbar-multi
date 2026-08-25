import { describe, expect, it } from "vite-plus/test";
import {
  parseOpenCodeGoBillingBalance,
  parseOpenCodeGoZenBalance,
} from "../src/providers/open-code-go-balance.ts";
import {
  normalizeOpenCodeGoWorkspaceID,
  parseOpenCodeGoUsageText,
} from "../src/providers/opencodego.ts";

describe("Swift-derived OpenCode Go balance and workspace parsing", () => {
  it.each([
    ["wrk_DIRECT123", "wrk_DIRECT123"],
    ["https://opencode.ai/workspace/wrk_URL123/go", "wrk_URL123"],
    ["workspace is wrk_TEXT123 today", "wrk_TEXT123"],
    ["workspace", undefined],
  ] as const)("normalizes workspace %s", (raw, expected) => {
    expect(normalizeOpenCodeGoWorkspaceID(raw)).toBe(expected);
  });

  it("parses localized dashboard and nested JSON balances", () => {
    expect(parseOpenCodeGoZenBalance("<h2>現在の残高 $1,234.56</h2>")).toBe(1234.56);
    expect(
      parseOpenCodeGoZenBalance(
        JSON.stringify({
          data: { billing: { balanceUpdatedAt: 1_800_000_000, zenBalance: "1,042.75" } },
        }),
      ),
    ).toBe(1042.75);
  });

  it("ignores unrelated balance metadata", () => {
    expect(
      parseOpenCodeGoZenBalance(JSON.stringify({ balanceUpdatedAt: 1_800_000_000 })),
    ).toBeUndefined();
  });

  it("parses scaled SolidStart and JSON billing balances", () => {
    expect(
      parseOpenCodeGoBillingBalance(
        ';0x120;($R=>$R[0]={customerID:"cus_test",balance:$R[2]=2375000000,reload:!1})',
      ),
    ).toBe(23.75);
    expect(
      parseOpenCodeGoBillingBalance(
        JSON.stringify({ data: { customerID: "cus_test", balance: 500_000_000 } }),
      ),
    ).toBe(5);
  });

  it("requires a customer before trusting raw billing balance", () => {
    expect(
      parseOpenCodeGoBillingBalance("$R[0]={balanceEnabled:!0,balance:2375000000}"),
    ).toBeUndefined();
    expect(parseOpenCodeGoBillingBalance('{"customerID":null,"balance":0}')).toBeUndefined();
  });

  it("parses the upstream Solid hydration usage payload", () => {
    const usage = parseOpenCodeGoUsageText(
      '$R[16]($R[30],$R[41]={rollingUsage:$R[42]={status:"ok",resetInSec:5944,' +
        'usagePercent:17},weeklyUsage:$R[43]={status:"ok",resetInSec:278201,' +
        'usagePercent:75},monthlyUsage:$R[44]={status:"ok",resetInSec:880201,' +
        "usagePercent:91}});",
      0,
    );
    expect(usage).toEqual({
      rolling: { percent: 17, seconds: 5944 },
      weekly: { percent: 75, seconds: 278_201 },
      monthly: { percent: 91, seconds: 880_201 },
    });
  });

  it("requires both fields for rolling and weekly hydration windows", () => {
    expect(
      parseOpenCodeGoUsageText(
        "rollingUsage:{usagePercent:17}; weeklyUsage:{usagePercent:75,resetInSec:7200}",
        0,
      ).rolling,
    ).toBeUndefined();
    expect(
      parseOpenCodeGoUsageText(
        "rollingUsage:{usagePercent:17,resetInSec:600}; weeklyUsage:{usagePercent:75}",
        0,
      ),
    ).toEqual({ rolling: { percent: 17, seconds: 600 } });
  });
});
