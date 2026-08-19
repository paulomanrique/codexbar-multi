import type {
  FirstPartyProvider,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { date, get, json, number, object, status, string } from "./_http.ts";
const definition: ProviderDefinition = {
  id: "codebuff",
  name: "Codebuff",
  endpoints: ["https://www.codebuff.com", { setting: "CODEBUFF_API_URL", policy: "https" }],
  auth: { type: "bearer", secret: "CODEBUFF_API_KEY" },
  settings: [
    { key: "CODEBUFF_API_KEY", title: "API key", type: "secure" },
    { key: "CODEBUFF_API_URL", title: "API URL", type: "plain" },
  ],
  fetchUsage: async (ctx) => {
    const key = ctx.settings.getSecret("CODEBUFF_API_KEY") || ctx.settings.get("CODEBUFF_API_KEY");
    if (!key) throw ctx.fail.missingCredential("Codebuff API token not configured.");
    const base = (ctx.settings.get("CODEBUFF_API_URL") || "https://www.codebuff.com").replace(
      /\/+$/,
      "",
    );
    const headers = { Authorization: `Bearer ${key}`, Accept: "application/json" };
    const usage = await get(ctx, `${base}/api/v1/usage`, {
      headers,
      method: "POST",
      body: { fingerprintId: "codexbar-usage" },
    });
    status(ctx, "Codebuff", usage);
    const root = object(json(ctx, "Codebuff", usage));
    if (!root) throw ctx.fail.parseFailure("Codebuff usage response must be an object.");
    const used = number(root.usage) ?? number(root.used);
    const total = number(root.quota) ?? number(root.limit);
    const remaining = number(root.remainingBalance) ?? number(root.remaining);
    const result: Record<string, unknown> = {
      identity: {
        loginMethod:
          remaining !== undefined ? `${remaining.toLocaleString("en-US")} remaining` : undefined,
      },
    };
    if (total !== undefined || used !== undefined)
      result.primary = {
        usedPercent:
          total && total > 0
            ? ((used ?? Math.max(0, total - (remaining ?? 0))) / total) * 100
            : 100,
        resetsAt: date(root.next_quota_reset, ctx),
      };
    const sub = await get(ctx, `${base}/api/user/subscription`, { headers });
    if (sub.status >= 200 && sub.status < 300) {
      const s = object(json(ctx, "Codebuff", sub));
      const subscription = object(s?.subscription);
      const rate = object(s?.rateLimit);
      if (rate && number(rate.weeklyLimit ?? rate.limit) !== undefined)
        result.secondary = {
          usedPercent:
            ((number(rate.weeklyUsed ?? rate.used) ?? 0) /
              (number(rate.weeklyLimit ?? rate.limit) as number)) *
            100,
          windowMinutes: 10080,
          resetsAt: date(rate.weeklyResetsAt, ctx),
        };
      if (subscription || s)
        result.identity = {
          loginMethod:
            string(subscription?.displayName) || string(subscription?.tier) || string(s?.tier),
        };
    }
    return result;
  },
};
const strategy: ProviderStrategy = {
  id: "codebuff.api",
  kind: "api",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const codebuff: FirstPartyProvider = { ...strategy, descriptor };
