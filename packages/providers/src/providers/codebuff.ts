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
    const usage = await ctx.http.postJSON(`${base}/api/v1/usage`, {
      headers,
      body: { fingerprintId: "codexbar-usage" },
    });
    status(ctx, "Codebuff", usage);
    const root = object(usage.json);
    if (!root) throw ctx.fail.parseFailure("Codebuff usage response must be an object.");
    const used = number(root.usage) ?? number(root.used);
    const total = number(root.quota) ?? number(root.limit);
    const remaining = number(root.remainingBalance) ?? number(root.remaining);
    const resolvedTotal =
      total !== undefined && total > 0
        ? total
        : used !== undefined && remaining !== undefined
          ? Math.max(0, used + remaining)
          : undefined;
    const resolvedUsed =
      used !== undefined
        ? Math.max(0, used)
        : resolvedTotal !== undefined && remaining !== undefined
          ? Math.max(0, resolvedTotal - remaining)
          : 0;
    const baseLoginParts = [
      remaining !== undefined ? `${remaining.toLocaleString("en-US")} remaining` : undefined,
      root.autoTopupEnabled === true || root.auto_topup_enabled === true
        ? "auto top-up"
        : undefined,
    ].filter((value): value is string => value !== undefined);
    const result: Record<string, unknown> = {
      identity: baseLoginParts.length ? { loginMethod: baseLoginParts.join(" · ") } : {},
    };
    if (resolvedTotal !== undefined || used !== undefined || remaining !== undefined)
      result.primary = {
        usedPercent:
          resolvedTotal !== undefined && resolvedTotal > 0
            ? Math.max(0, Math.min(100, (resolvedUsed / resolvedTotal) * 100))
            : 100,
        resetsAt: date(root.next_quota_reset, ctx),
      };
    // O endpoint de assinatura é enriquecimento best-effort no oracle Swift: uma
    // falha ou timeout nunca invalida o saldo primário já obtido.
    try {
      const sub = await get(ctx, `${base}/api/user/subscription`, { headers });
      if (sub.status >= 200 && sub.status < 300) {
        const s = object(json(ctx, "Codebuff", sub));
        const subscription = object(s?.subscription);
        const rate = object(s?.rateLimit);
        const weeklyLimit = number(rate?.weeklyLimit ?? rate?.limit);
        if (weeklyLimit !== undefined && weeklyLimit > 0) {
          const weeklyUsed = Math.max(0, number(rate?.weeklyUsed ?? rate?.used) ?? 0);
          result.secondary = {
            usedPercent: Math.max(0, Math.min(100, (weeklyUsed / weeklyLimit) * 100)),
            windowMinutes: 10080,
            resetsAt: date(rate?.weeklyResetsAt, ctx),
          };
        }
        if (s) {
          const tier =
            string(subscription?.displayName) ||
            string(s.displayName) ||
            string(subscription?.tier) ||
            string(s.tier) ||
            string(subscription?.scheduledTier);
          const loginParts = [
            tier?.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
            ...baseLoginParts,
          ].filter((value): value is string => value !== undefined);
          const email = string(s.email) || string(object(s.user)?.email);
          result.identity = {
            ...(loginParts.length ? { loginMethod: loginParts.join(" · ") } : {}),
            ...(email ? { email } : {}),
          };
        }
      }
    } catch {
      // Best-effort por paridade com BoundedTaskJoin no Swift.
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
