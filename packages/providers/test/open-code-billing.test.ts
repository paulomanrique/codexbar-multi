import { describe, expect, it } from "vite-plus/test";
import { parseOpenCodeZenBilling } from "../src/providers/open-code-billing.ts";

const solidStartFixture =
  ';0x000002b9;((self.$R=self.$R||{})["server-fn:fixture"]=[],($R=>$R[0]={customerID:"cus_TEST",' +
  "balance:1250000000,monthlyLimit:20,monthlyUsage:1500000000," +
  'timeMonthlyUsageUpdated:$R[1]=new Date("2026-07-29T14:45:11.000Z"),' +
  'subscription:null,subscriptionID:null,subscriptionPlan:null})($R["server-fn:fixture"]))';

describe("Swift-derived OpenCode Zen billing parser", () => {
  it("parses the SolidStart pay-as-you-go fixture and fixed-point USD scale", () => {
    expect(parseOpenCodeZenBilling(solidStartFixture)).toEqual({
      monthlyUsageUSD: 15,
      monthlyLimitUSD: 20,
      balanceUSD: 12.5,
      hasSubscription: false,
      usageUpdatedAt: "2026-07-29T14:45:11.000Z",
    });
  });

  it("finds a nested JSON customer object", () => {
    expect(
      parseOpenCodeZenBilling(
        JSON.stringify({
          result: {
            customerID: "cus_TEST",
            balance: 500_000_000,
            monthlyLimit: 10,
            monthlyUsage: 250_000_000,
            subscription: null,
          },
        }),
      ),
    ).toEqual({
      monthlyUsageUSD: 2.5,
      monthlyLimitUSD: 10,
      balanceUSD: 5,
      hasSubscription: false,
    });
  });

  it("preserves a missing limit and detects a legacy subscription", () => {
    expect(
      parseOpenCodeZenBilling(
        JSON.stringify({
          customerID: "cus_TEST",
          monthlyLimit: null,
          monthlyUsage: 300_000_000,
          subscription: { id: "sub_TEST" },
        }),
      ),
    ).toEqual({ monthlyUsageUSD: 3, hasSubscription: true });
  });

  it.each(['{"monthlyUsage":1500000000}', "null", '{"customerID":"cus_TEST","balance":100}'])(
    "rejects unrelated or incomplete billing payload %s",
    (text) => {
      expect(parseOpenCodeZenBilling(text)).toBeUndefined();
    },
  );
});
