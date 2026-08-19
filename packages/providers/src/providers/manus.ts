import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
const definition: ProviderDefinition = {
  id: "manus",
  name: "Manus",
  endpoints: ["https://api.manus.im"],
  settings: [],
  capabilities: ["browser-cookies"],
  cookieDomains: ["manus.im"],
  fetchUsage: async (ctx: ProviderContext) => {
    const cookies: any = await ctx.browser.cookieHeader("manus.im");
    const match: any = /(?:^|;\s*)session_id=([^;]+)/i.exec(cookies);
    if (!match) throw new Error("Manus session cookie is missing");
    const response: any = await ctx.http.postJSON(
      "https://api.manus.im/user.v1.UserService/GetAvailableCredits",
      {
        body: {},
        headers: {
          Authorization: `Bearer ${match[1]}`,
          Origin: "https://manus.im",
          Referer: "https://manus.im/",
          "Connect-Protocol-Version": "1",
        },
      },
    );
    if (response.status !== 200) throw new Error(`Manus API error: HTTP ${response.status}`);
    const root: any = response.json || {};
    const data: any = root.data || root.result || root.response || root.availableCredits || root;
    const number: any = (key: any) => Number(data[key] || 0);
    const total: any = number("totalCredits");
    const free: any = number("freeCredits");
    const monthly: any = number("proMonthlyCredits");
    const periodic: any = number("periodicCredits");
    const refresh: any = number("refreshCredits");
    const maxRefresh: any = number("maxRefreshCredits");
    const format: any = (value: any) =>
      ctx.format.number(Math.round(value), { maximumFractionDigits: 0 });
    return {
      primary:
        monthly > 0
          ? {
              usedPercent: ctx.pct(monthly - periodic, monthly),
              resetDescription: `Total ${format(total)} • Free ${format(free)}`,
            }
          : undefined,
      secondary:
        maxRefresh > 0
          ? {
              usedPercent: ctx.pct(maxRefresh - refresh, maxRefresh),
              resetsAt: data.nextRefreshTime ? ctx.date.iso(data.nextRefreshTime) : undefined,
              resetDescription: data.refreshInterval
                ? `${String(data.refreshInterval).replace(/^./, (value: any) => value.toUpperCase())}: ${format(refresh)} / ${format(maxRefresh)}`
                : `${format(refresh)} / ${format(maxRefresh)}`,
            }
          : undefined,
      identity: { loginMethod: `Balance: ${format(total)} credits` },
    };
  },
};
const strategy: ProviderStrategy = {
  id: "manus.web",
  kind: "web",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const manus: FirstPartyProvider = { ...strategy, descriptor };
