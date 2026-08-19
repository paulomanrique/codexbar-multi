import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
const definition: ProviderDefinition = {
  id: "qoder",
  name: "Qoder",
  endpoints: ["https://qoder.com", "https://qoder.com.cn"],
  settings: [],
  capabilities: ["browser-cookies"],
  cookieDomains: ["qoder.com", "qoder.com.cn"],
  fetchUsage: async (ctx: ProviderContext) => {
    let response: any = null;
    for (const site of ["qoder.com", "qoder.com.cn"]) {
      const cookie: any = await ctx.browser.cookieHeader(site);
      const origin: any = `https://${site}`;
      const candidate: any = await ctx.http.getJSON(
        `${origin}/api/v2/me/usages/big_model_credits`,
        {
          headers: {
            Cookie: cookie,
            Origin: origin,
            Referer: `${origin}/account/usage`,
            "X-Requested-With": "XMLHttpRequest",
            "Bx-V": "2.5.35",
          },
        },
      );
      if (candidate.status >= 200 && candidate.status < 300) {
        response = candidate;
        break;
      }
    }
    if (!response) throw new Error("Qoder credentials were rejected");
    const root: any = response.json || {};
    const container: any = root.totalQuota || root.total_quota;
    const sharedContainer: any = root.sharedQuota || root.shared_quota;
    const summary: any = container && (container.quotaSummary || container.quota_summary);
    const shared: any =
      sharedContainer && (sharedContainer.quotaSummary || sharedContainer.quota_summary);
    if (!summary) throw new Error("Qoder response is missing quota summary");
    const read: any = (value: any, camel: any, snake: any) => Number(value[camel] ?? value[snake]);
    const used: any =
      read(summary, "usedValue", "used_value") +
      (shared ? read(shared, "usedValue", "used_value") : 0);
    const total: any =
      read(summary, "limitValue", "limit_value") +
      (shared ? read(shared, "limitValue", "limit_value") : 0);
    const percentage: any = shared
      ? ctx.pct(used, total)
      : Number(summary.usagePercentage ?? summary.usage_percentage ?? ctx.pct(used, total));
    const reset: any = root.nextResetAt ?? root.next_reset_at;
    const resetDate: any =
      typeof reset === "number"
        ? reset > 10000000000
          ? ctx.date.unixMillis(reset)
          : ctx.date.unixSeconds(reset)
        : reset
          ? ctx.date.iso(reset)
          : undefined;
    const format: any = (value: any) =>
      ctx.format.number(value, { maximumFractionDigits: Number.isInteger(value) ? 0 : 2 });
    return {
      primary: {
        usedPercent: Math.max(0, Math.min(100, percentage)),
        resetsAt: resetDate,
        resetDescription: `${format(used)} / ${format(total)} credits`,
      },
    };
  },
};
const strategy: ProviderStrategy = {
  id: "qoder.web",
  kind: "web",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const qoder: FirstPartyProvider = { ...strategy, descriptor };
