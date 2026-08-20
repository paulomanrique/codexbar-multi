import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { date, number, object, string } from "./_http.ts";

const plans: Record<string, readonly [string, number]> = {
  "individual-go": ["Go", 10],
  "individual-goat": ["GOAT", 70],
  "individual-pro": ["Pro", 30],
  "individual-max": ["Max", 150],
  "individual-ultra": ["Ultra", 300],
};
const cookie = (raw: string | undefined): string | undefined => {
  const value = raw?.trim();
  if (!value) return undefined;
  if (!value.includes("=") && !value.includes(";"))
    return `__Secure-better-auth.session_token=${value}`;
  const names = [
    "__Secure-commandcode_prod_.session_token",
    "commandcode_prod_.session_token",
    "__Host-commandcode_prod_.session_token",
    "__Host-better-auth.session_token",
    "__Secure-better-auth.session_token",
    "better-auth.session_token",
  ];
  const pairs = value.split(";").map((part) => part.trim());
  const found = names
    .map((name) => pairs.find((pair) => pair.toLowerCase().startsWith(`${name.toLowerCase()}=`)))
    .find(Boolean);
  return found ?? value;
};
const headers = (cookie: string) => ({
  Cookie: cookie,
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Origin: "https://commandcode.ai",
  Referer: "https://commandcode.ai/",
});
const status = (ctx: ProviderContext, response: { status: number }) => {
  if (response.status === 401 || response.status === 403)
    throw ctx.fail.authenticationExpired("Command Code session is invalid or expired.");
  if (response.status < 200 || response.status >= 300)
    throw ctx.fail.apiFailure(`Command Code API returned HTTP ${response.status}.`);
};
const window = (ctx: ProviderContext, raw: unknown, minutes: number) => {
  const value = object(raw);
  const cap = number(value?.cap);
  if (!cap || cap <= 0) return undefined;
  const used = number(value?.used) ?? 0;
  const reset = date(value?.resetAt, ctx);
  return {
    usedPercent: ctx.pct(used, cap),
    windowMinutes: minutes,
    ...(reset ? { resetsAt: reset } : {}),
  };
};
const definition: ProviderDefinition = {
  id: "commandcode",
  name: "Command Code",
  endpoints: ["https://api.commandcode.ai", "https://commandcode.ai"],
  settings: [{ key: "COMMANDCODE_COOKIE", title: "Session cookie", type: "secure" }],
  capabilities: ["browser-cookies"],
  cookieDomains: ["commandcode.ai", "www.commandcode.ai"],
  fetchUsage: async (ctx) => {
    const session = cookie(
      ctx.settings.getSecret("COMMANDCODE_COOKIE") ??
        ctx.settings.get("COMMANDCODE_COOKIE") ??
        (await ctx.browser.cookieHeader("commandcode.ai")),
    );
    if (!session) throw ctx.fail.missingCredential("Missing Command Code session cookie.");
    const creditsResponse = await ctx.http.getJSON(
      "https://api.commandcode.ai/internal/billing/credits",
      { headers: headers(session) },
    );
    status(ctx, creditsResponse);
    const creditsRoot = object(creditsResponse.json);
    const credits = object(creditsRoot?.credits);
    const monthlyRemaining = number(credits?.monthlyCredits);
    if (monthlyRemaining === undefined)
      throw ctx.fail.parseFailure("Command Code credits are missing monthlyCredits.");
    let subscription: Record<string, unknown> | undefined;
    try {
      const result = await ctx.http.getJSON(
        "https://api.commandcode.ai/internal/billing/subscriptions",
        {
          headers: headers(session),
          timeoutSeconds: ctx.__codexbarOptionalRequestTimeoutSeconds ?? 2,
        },
      );
      if (result.status === 200 && object(result.json)?.success === true)
        subscription = object(object(result.json)?.data);
    } catch {
      /* best effort */
    }
    const planId = string(subscription?.planId)?.toLowerCase();
    const plan = planId ? plans[planId] : undefined;
    if (subscription && string(subscription.status)?.toLowerCase() === "active" && !plan)
      throw ctx.fail.parseFailure(`Unknown Command Code plan: ${planId ?? "missing"}.`);
    const end = date(subscription?.currentPeriodEnd, ctx);
    const total = plan?.[1];
    const used =
      total === undefined ? undefined : Math.max(0, Math.min(total, total - monthlyRemaining));
    const purchased = number(credits?.purchasedCredits) ?? 0;
    const planText = plan
      ? `${plan[0]} · ${ctx.format.usd(used ?? 0)} of ${ctx.format.usd(total as number)}`
      : monthlyRemaining > 0
        ? `${ctx.format.usd(monthlyRemaining)} remaining`
        : undefined;
    return {
      ...(window(
        ctx,
        creditsRoot?.windowLimits
          ? object(creditsRoot.windowLimits)?.fiveHour
          : credits?.windowLimits && object(credits.windowLimits)?.fiveHour,
        300,
      )
        ? {
            primary: window(
              ctx,
              creditsRoot?.windowLimits
                ? object(creditsRoot.windowLimits)?.fiveHour
                : credits?.windowLimits && object(credits.windowLimits)?.fiveHour,
              300,
            ),
          }
        : {}),
      ...(window(
        ctx,
        creditsRoot?.windowLimits
          ? object(creditsRoot.windowLimits)?.weekly
          : credits?.windowLimits && object(credits.windowLimits)?.weekly,
        10080,
      )
        ? {
            secondary: window(
              ctx,
              creditsRoot?.windowLimits
                ? object(creditsRoot.windowLimits)?.weekly
                : credits?.windowLimits && object(credits.windowLimits)?.weekly,
              10080,
            ),
          }
        : {}),
      ...(total !== undefined
        ? {
            tertiary: {
              usedPercent: ctx.pct(used ?? 0, total),
              windowMinutes: 43200,
              ...(end ? { resetsAt: end } : {}),
            },
          }
        : monthlyRemaining > 0 || purchased > 0
          ? {
              tertiary: { usedPercent: 0, windowMinutes: 43200, ...(end ? { resetsAt: end } : {}) },
            }
          : {}),
      identity: planText
        ? {
            loginMethod: `${planText}${purchased > 0 ? ` · + ${ctx.format.usd(purchased)} credits` : ""}`,
          }
        : {},
    };
  },
};
const strategy: ProviderStrategy = {
  id: "commandcode.web",
  kind: "web",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const commandcode: FirstPartyProvider = { ...strategy, descriptor };
