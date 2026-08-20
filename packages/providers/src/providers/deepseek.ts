import type {
  FirstPartyProvider,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { get, json, number, object, status, string } from "./_http.ts";
const definition: ProviderDefinition = {
  id: "deepseek",
  name: "DeepSeek",
  endpoints: ["https://api.deepseek.com", "https://platform.deepseek.com"],
  auth: { type: "bearer", secret: "DEEPSEEK_API_KEY" },
  settings: [
    { key: "DEEPSEEK_API_KEY", title: "API key", type: "secure" },
    { key: "DEEPSEEK_PLATFORM_TOKEN", title: "Platform token", type: "secure" },
  ],
  fetchUsage: async (ctx) => {
    const key = (
      ctx.settings.getSecret("DEEPSEEK_API_KEY") ||
      ctx.settings.get("DEEPSEEK_API_KEY") ||
      ""
    ).trim();
    if (!key) throw ctx.fail.missingCredential("Missing DeepSeek API key.");
    const response = await get(ctx, "https://api.deepseek.com/user/balance", {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    });
    status(ctx, "DeepSeek", response);
    const root = object(json(ctx, "DeepSeek", response));
    if (!root) throw ctx.fail.parseFailure("DeepSeek balance response must be an object.");
    if (typeof root.is_available !== "boolean" || !Array.isArray(root.balance_infos))
      throw ctx.fail.parseFailure("DeepSeek balance response is missing required fields.");
    const infos = root.balance_infos;
    const balances: Array<{ currency: string; total: number; granted: number; paid: number }> = [];
    for (const raw of infos) {
      const row = object(raw);
      const total = row && number(row.total_balance);
      const granted = row && number(row.granted_balance);
      const paid = row && number(row.topped_up_balance);
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
    const result: Record<string, unknown> = {
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
    const platform =
      ctx.settings.getSecret("DEEPSEEK_PLATFORM_TOKEN") ||
      ctx.settings.get("DEEPSEEK_PLATFORM_TOKEN");
    if (platform) {
      const summary = await get(
        ctx,
        "https://platform.deepseek.com/api/v0/users/get_user_summary",
        { headers: { Authorization: `Bearer ${platform}`, Accept: "application/json" } },
      );
      if (summary.status === 200) {
        const sr = object(json(ctx, "DeepSeek", summary));
        const data = object(sr?.data);
        const biz = object(data?.biz_data);
        const wallets = [
          ...(Array.isArray(biz?.normal_wallets) ? biz.normal_wallets : []),
          ...(Array.isArray(biz?.bonus_wallets) ? biz.bonus_wallets : []),
        ];
        if (wallets.length)
          result.details = [
            {
              title: "Detailed usage",
              rows: wallets.map((w) => ({
                label: string(object(w)?.currency) || "Balance",
                value: String(number(object(w)?.balance) ?? 0),
              })),
            },
          ];
      }
    }
    return result;
  },
};
const strategy: ProviderStrategy = {
  id: "deepseek.api",
  kind: "api",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const deepseek: FirstPartyProvider = { ...strategy, descriptor };
