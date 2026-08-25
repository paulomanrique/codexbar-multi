import type {
  FirstPartyProvider,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { get, json, object, string } from "./_http.ts";

const clean = (raw: string | undefined): string | undefined => {
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

const decimal = (raw: unknown): number | undefined => {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const definition: ProviderDefinition = {
  id: "deepseek",
  name: "DeepSeek",
  endpoints: ["https://api.deepseek.com", "https://platform.deepseek.com"],
  settings: [
    { key: "DEEPSEEK_API_KEY", title: "API key", type: "secure" },
    { key: "DEEPSEEK_KEY", title: "API key (legacy alias)", type: "secure" },
    { key: "DEEPSEEK_PLATFORM_TOKEN", title: "Platform token", type: "secure" },
    { key: "DEEPSEEK_USER_TOKEN", title: "Platform token (legacy alias)", type: "secure" },
    { key: "CODEXBAR_DEEPSEEK_PROFILE_ID", title: "Platform profile", type: "plain" },
    { key: "CODEXBAR_DEEPSEEK_PROFILE_SCOPE", title: "Platform profile scope", type: "plain" },
  ],
  fetchUsage: async (ctx) => {
    const key =
      clean(ctx.settings.getSecret("DEEPSEEK_API_KEY")) ??
      clean(ctx.settings.get("DEEPSEEK_API_KEY")) ??
      clean(ctx.settings.getSecret("DEEPSEEK_KEY")) ??
      clean(ctx.settings.get("DEEPSEEK_KEY"));
    if (!key) throw ctx.fail.missingCredential("Missing DeepSeek API key.");
    const response = await get(ctx, "https://api.deepseek.com/user/balance", {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    });
    if (response.status !== 200) {
      throw ctx.fail.apiFailure(`DeepSeek API returned HTTP ${response.status}.`);
    }
    const root = object(json(ctx, "DeepSeek", response));
    if (!root) throw ctx.fail.parseFailure("DeepSeek balance response must be an object.");
    if (typeof root.is_available !== "boolean" || !Array.isArray(root.balance_infos))
      throw ctx.fail.parseFailure("DeepSeek balance response is missing required fields.");
    const infos = root.balance_infos;
    const balances: Array<{ currency: string; total: number; granted: number; paid: number }> = [];
    for (const raw of infos) {
      const row = object(raw);
      const total = row && decimal(row.total_balance);
      const granted = row && decimal(row.granted_balance);
      const paid = row && decimal(row.topped_up_balance);
      const currency = row && string(row.currency);
      if (total === undefined || granted === undefined || paid === undefined || !currency)
        throw ctx.fail.parseFailure("DeepSeek balance contains invalid numeric values.");
      balances.push({ currency, total, granted, paid });
    }
    const selected =
      balances.find((b) => b.currency === "USD" && b.total > 0) ||
      balances.find((b) => b.total > 0) ||
      balances.find((b) => b.currency === "USD") ||
      balances[0];
    if (!selected)
      return {
        primary: {
          usedPercent: 100,
          resetDescription: "$0.00 — add credits at platform.deepseek.com",
        },
        identity: {},
      };
    const symbol = selected.currency === "CNY" ? "¥" : "$";
    return {
      primary: {
        usedPercent: selected.total > 0 && root.is_available === true ? 0 : 100,
        resetDescription:
          selected.total <= 0
            ? `${symbol}0.00 — add credits at platform.deepseek.com`
            : root.is_available === true
              ? `${symbol}${selected.total.toFixed(2)} (Paid: ${symbol}${selected.paid.toFixed(2)} / Granted: ${symbol}${selected.granted.toFixed(2)})`
              : "Balance unavailable for API calls",
      },
      identity: {},
    };
  },
};
const strategy: ProviderStrategy = {
  id: "deepseek.api",
  kind: "api",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const deepseek: FirstPartyProvider = { ...strategy, descriptor };
