import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { status } from "./_http.ts";

const cleanAPIKey = (raw: string | undefined): string | undefined => {
  let value = raw?.trim() ?? "";
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1).trim();
  }
  return value === "" ? undefined : value;
};

const definition: ProviderDefinition = {
  id: "venice",
  name: "Venice",
  endpoints: ["https://api.venice.ai"],
  settings: [
    {
      key: "VENICE_API_KEY",
      title: "API key",
      subtitle: "Venice API key used for the billing balance endpoint.",
      type: "secure",
    },
    {
      key: "VENICE_KEY",
      title: "Legacy API key",
      subtitle: "Legacy Venice environment alias.",
      type: "secure",
    },
  ],

  fetchUsage: async (ctx: ProviderContext) => {
    const key =
      cleanAPIKey(ctx.settings.getSecret("VENICE_API_KEY")) ??
      cleanAPIKey(ctx.settings.get("VENICE_API_KEY")) ??
      cleanAPIKey(ctx.settings.getSecret("VENICE_KEY")) ??
      cleanAPIKey(ctx.settings.get("VENICE_KEY"));
    if (key === undefined) throw ctx.fail.missingCredential("Missing Venice API key.");
    const response: any = await ctx.http.getJSON("https://api.venice.ai/api/v1/billing/balance", {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    });
    status(ctx, "Venice", response);
    if (response.status !== 200) {
      throw ctx.fail.apiFailure(`Venice API error: HTTP ${response.status}`);
    }

    const payload: any = response.json;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw ctx.fail.parseFailure("Failed to parse Venice response: expected an object");
    }
    if (typeof payload.canConsume !== "boolean") {
      throw ctx.fail.parseFailure("Failed to parse Venice response: canConsume must be a boolean");
    }
    if (
      !payload.balances ||
      typeof payload.balances !== "object" ||
      Array.isArray(payload.balances)
    ) {
      throw ctx.fail.parseFailure("Failed to parse Venice response: balances must be an object");
    }

    function optionalNumber(value: any, field: any) {
      if (value === null || value === undefined || value === "") return null;
      const number: any =
        typeof value === "number"
          ? value
          : typeof value === "string"
            ? Number(value.trim())
            : Number.NaN;
      if (!Number.isFinite(number))
        throw ctx.fail.parseFailure(`Failed to parse Venice response: ${field} must be numeric`);
      return number;
    }

    if (
      payload.consumptionCurrency !== null &&
      payload.consumptionCurrency !== undefined &&
      typeof payload.consumptionCurrency !== "string"
    ) {
      throw ctx.fail.parseFailure(
        "Failed to parse Venice response: consumptionCurrency must be a string",
      );
    }
    const currency: any = payload.consumptionCurrency
      ? payload.consumptionCurrency.toUpperCase()
      : null;
    const diem: any = optionalNumber(payload.balances.diem, "balances.diem");
    const usd: any = optionalNumber(payload.balances.usd, "balances.usd");
    const allocation: any = optionalNumber(payload.diemEpochAllocation, "diemEpochAllocation");

    let usedPercent;
    let resetDescription;
    if (!payload.canConsume) {
      usedPercent = 100;
      resetDescription = "Balance unavailable for API calls";
    } else if (currency === "USD" && usd !== null && usd > 0) {
      usedPercent = 0;
      resetDescription = `$${usd.toFixed(2)} USD remaining`;
    } else if (currency !== "USD" && diem !== null && allocation !== null && allocation > 0) {
      usedPercent = ctx.pct(allocation - diem, allocation);
      resetDescription = `DIEM ${diem.toFixed(2)} / ${allocation.toFixed(2)} epoch allocation`;
    } else if (currency === "DIEM" && diem !== null && diem > 0) {
      usedPercent = 0;
      resetDescription = `DIEM ${diem.toFixed(2)} remaining`;
    } else if (diem !== null && diem > 0) {
      usedPercent = 0;
      resetDescription = `DIEM ${diem.toFixed(2)} remaining`;
    } else if (usd !== null && usd > 0) {
      usedPercent = 0;
      resetDescription = `$${usd.toFixed(2)} USD remaining`;
    } else {
      usedPercent = 100;
      resetDescription = "No Venice API balance available";
    }

    return {
      primary: { usedPercent, resetDescription },
      identity: {},
    };
  },
};
const strategy: ProviderStrategy = {
  id: "venice.api",
  kind: "api",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const venice: FirstPartyProvider = { ...strategy, descriptor };
