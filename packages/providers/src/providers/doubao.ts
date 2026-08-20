import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { date, number, object, status, string } from "./_http.ts";

const cleaned = (value: string | undefined): string | undefined => {
  const trimmed = value
    ?.trim()
    .replace(/^("([\s\S]*)"|'([\s\S]*)')$/, "$2$3")
    .trim();
  return trimmed || undefined;
};
const firstSetting = (ctx: ProviderContext, keys: readonly string[]): string | undefined => {
  for (const key of keys) {
    const found = cleaned(ctx.settings.getSecret(key)) || cleaned(ctx.settings.get(key));
    if (found) return found;
  }
  return undefined;
};
const quotaWindows = (ctx: ProviderContext, root: Record<string, unknown>): unknown[] => {
  const source = Array.isArray(root.quotas)
    ? root.quotas
    : Array.isArray(root.data)
      ? root.data
      : [];
  const windows: unknown[] = [];
  for (const raw of source) {
    const quota = object(raw);
    const percent = number(quota?.percent ?? quota?.usage_percent ?? quota?.used_percent);
    if (percent === undefined) continue;
    const label = string(quota?.label ?? quota?.level ?? quota?.name) || "Quota";
    windows.push({
      id: label.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      title: label,
      window: {
        usedPercent: Math.max(0, Math.min(100, percent)),
        windowMinutes: /week/i.test(label)
          ? 7 * 24 * 60
          : /month/i.test(label)
            ? 30 * 24 * 60
            : /hour|session/i.test(label)
              ? 5 * 60
              : undefined,
        ...(date(quota?.reset_at ?? quota?.resetAt ?? quota?.reset_timestamp, ctx)
          ? { resetsAt: date(quota?.reset_at ?? quota?.resetAt ?? quota?.reset_timestamp, ctx) }
          : {}),
      },
    });
  }
  return windows;
};
const definition: ProviderDefinition = {
  id: "doubao",
  name: "Doubao",
  endpoints: ["https://ark.cn-beijing.volces.com"],
  auth: { type: "bearer", secret: "ARK_API_KEY" },
  settings: [
    { key: "ARK_API_KEY", title: "API key", type: "secure" },
    { key: "ARK_REGION", title: "Region", type: "plain" },
  ],
  fetchUsage: async (ctx) => {
    const key = firstSetting(ctx, ["ARK_API_KEY", "VOLCENGINE_API_KEY", "DOUBAO_API_KEY"]);
    if (!key) throw ctx.fail.missingCredential("Missing Doubao API key.");
    const response = await ctx.http.postJSON(
      "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions",
      {
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
        method: "POST",
        body: {
          model: "doubao-seed-2.0-code",
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        },
      },
    );
    status(ctx, "Doubao", response);
    const root = object(response.json);
    if (!root) throw ctx.fail.parseFailure("Doubao response must be an object.");
    const windows = quotaWindows(ctx, root);
    const usage = object(root.usage);
    const totalTokens = number(usage?.total_tokens);
    return windows.length
      ? {
          primary: (windows[0] as Record<string, unknown>).window,
          extraRateWindows: windows.slice(1),
          identity: { loginMethod: "API key" },
        }
      : {
          identity: { loginMethod: "API key" },
          ...(totalTokens !== undefined
            ? {
                details: [
                  { title: "Probe", rows: [{ label: "Total tokens", value: String(totalTokens) }] },
                ],
              }
            : {}),
        };
  },
};
const strategy: ProviderStrategy = {
  id: "doubao.api",
  kind: "api",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const doubao: FirstPartyProvider = { ...strategy, descriptor };
