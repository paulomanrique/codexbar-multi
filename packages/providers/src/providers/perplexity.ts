import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
const definition: ProviderDefinition = {
  id: "perplexity",
  name: "Perplexity",
  endpoints: ["https://www.perplexity.ai"],
  settings: [],
  capabilities: ["browser-cookies"],
  cookieDomains: ["www.perplexity.ai"],
  fetchUsage: async (ctx: ProviderContext) => {
    const cookie: any = await ctx.browser.cookieHeader("www.perplexity.ai");
    const response: any = await ctx.http.getJSON(
      "https://www.perplexity.ai/rest/billing/credits?version=2.18&source=default",
      {
        headers: {
          Cookie: cookie,
          Origin: "https://www.perplexity.ai",
          Referer: "https://www.perplexity.ai/account/usage",
        },
      },
    );
    if (response.status !== 200) throw new Error(`Perplexity API error: HTTP ${response.status}`);
    const data: any = response.json;
    const grants: any = data.credit_grants || data.creditGrants || [];
    const now: any = Date.now() / 1000;
    const amount: any = (grant: any) => Number(grant.amount_cents ?? grant.amountCents ?? 0);
    const recurring: any = grants
      .filter((grant: any) => grant.type === "recurring")
      .reduce((sum: any, grant: any) => sum + amount(grant), 0);
    const promoGrants: any = grants.filter(
      (grant: any) =>
        grant.type === "promotional" &&
        Number(grant.expires_at_ts ?? grant.expiresAtTs ?? Infinity) > now,
    );
    const promo: any = promoGrants.reduce((sum: any, grant: any) => sum + amount(grant), 0);
    const purchasedGrants: any = grants
      .filter((grant: any) => grant.type === "purchased")
      .reduce((sum: any, grant: any) => sum + amount(grant), 0);
    const purchased: any = Math.max(
      purchasedGrants,
      Number(data.current_period_purchased_cents ?? data.currentPeriodPurchasedCents ?? 0),
    );
    let remaining: any = Number(data.total_usage_cents ?? data.totalUsageCents ?? 0);
    const recurringUsed: any = Math.min(remaining, recurring);
    remaining -= recurringUsed;
    const purchasedUsed: any = Math.min(remaining, purchased);
    remaining -= purchasedUsed;
    const promoUsed: any = Math.min(remaining, promo);
    const renewal: any = Number(data.renewal_date_ts ?? data.renewalDateTs);
    const promoExpiry: any = promoGrants
      .map((grant: any) => Number(grant.expires_at_ts ?? grant.expiresAtTs))
      .filter(Number.isFinite)
      .sort()[0];
    const integer: any = (value: any) => String(Math.round(value));
    const promoDescription: any = `${integer(promoUsed)}/${integer(promo)} bonus`;
    return {
      primary:
        recurring > 0
          ? {
              usedPercent: ctx.pct(recurringUsed, recurring),
              resetsAt: ctx.date.unixSeconds(renewal),
              resetDescription: `${integer(recurringUsed)}/${integer(recurring)} credits`,
            }
          : promo > 0 || purchased > 0
            ? undefined
            : {
                usedPercent: 100,
                resetsAt: ctx.date.unixSeconds(renewal),
                resetDescription: "0/0 credits",
              },
      secondary: {
        usedPercent: promo > 0 ? ctx.pct(promoUsed, promo) : 100,
        resetDescription: promoExpiry
          ? `${promoDescription} · exp. ${ctx.format.monthDay(new Date(promoExpiry * 1000))}`
          : promoDescription,
      },
      tertiary: {
        usedPercent: purchased > 0 ? ctx.pct(purchasedUsed, purchased) : 100,
        resetDescription: `${integer(purchasedUsed)}/${integer(purchased)} credits`,
      },
      identity: { loginMethod: recurring <= 0 ? undefined : recurring < 5000 ? "Pro" : "Max" },
    };
  },
};
const strategy: ProviderStrategy = {
  id: "perplexity.web",
  kind: "web",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const perplexity: FirstPartyProvider = { ...strategy, descriptor };
