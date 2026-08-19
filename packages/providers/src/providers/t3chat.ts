import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
const definition: ProviderDefinition = {
  id: "t3chat",
  name: "T3 Chat",
  endpoints: ["https://t3.chat"],
  settings: [],
  capabilities: ["browser-cookies"],
  cookieDomains: ["t3.chat"],
  fetchUsage: async (ctx: ProviderContext) => {
    const cookie: any = await ctx.browser.cookieHeader("t3.chat");
    const input: any = encodeURIComponent(
      JSON.stringify({
        0: { json: { sessionId: null }, meta: { values: { sessionId: ["undefined"] } } },
      }),
    );
    const response: any = await ctx.http.get(
      `https://t3.chat/api/trpc/getCustomerData?batch=1&input=${input}`,
      {
        headers: {
          Cookie: cookie,
          Origin: "https://t3.chat",
          Referer: "https://t3.chat/settings/customization",
          "trpc-accept": "application/jsonl",
          "x-trpc-source": "web-client",
          "x-trpc-batch": "true",
        },
      },
    );
    if (response.status !== 200) throw new Error(`T3 Chat API error: HTTP ${response.status}`);
    function find(value: any) {
      if (!value || typeof value !== "object") return null;
      if (
        "usageFourHourPercentage" in value ||
        "usageMonthPercentage" in value ||
        (value.subscription && value.usageBand)
      )
        return value;
      for (const child of Object.values(value)) {
        const found: any = find(child);
        if (found) return found;
      }
      return null;
    }
    let data: any = null;
    for (const line of response.bodyText.split(/\r?\n/)) {
      try {
        data = find(JSON.parse(line));
      } catch {}
      if (data) break;
    }
    if (!data) throw new Error("T3 Chat response is missing customer data");
    const date: any = (value: any) =>
      !value || value <= 0
        ? undefined
        : value > 10000000000
          ? ctx.date.unixMillis(value)
          : ctx.date.unixSeconds(value);
    const rawPlan: any = (data.subscription && data.subscription.productName) || data.subTier;
    const plan: any =
      rawPlan &&
      String(rawPlan)
        .split("-")
        .map((part: any) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
    return {
      primary: {
        usedPercent: Math.max(0, Math.min(100, Number(data.usageFourHourPercentage || 0))),
        windowMinutes: 240,
        resetsAt: date(data.usageFourHourNextResetAt || data.usageWindowNextResetAt),
        resetDescription: data.usageBand ? `Base - ${String(data.usageBand).trim()}` : "Base",
      },
      secondary: {
        usedPercent: Math.max(
          0,
          Math.min(100, Number(data.usageMonthPercentage ?? data.usagePeriodPercentage ?? 0)),
        ),
        resetsAt: date(data.subscription && data.subscription.currentPeriodEnd),
        resetDescription: "Overage",
      },
      identity: { loginMethod: plan || undefined },
    };
  },
};
const strategy: ProviderStrategy = {
  id: "t3chat.web",
  kind: "web",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const t3chat: FirstPartyProvider = { ...strategy, descriptor };
