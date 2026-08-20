import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderResponse,
  ProviderStrategy,
} from "../types.ts";
import { date, get, json, number, object, string } from "./_http.ts";

type Dict = Record<string, unknown>;
type Headers = Record<string, string>;

const trim = (value: string | undefined): string | undefined => value?.trim() || undefined;
const token = (raw: string | undefined): string | undefined => {
  let value = trim(raw);
  if (!value) return undefined;
  const header = /^authorization\s*:\s*(.+)$/imu.exec(value);
  if (header?.[1]) value = header[1].trim();
  value = value.replace(/^bearer\s+/iu, "").trim();
  return value || undefined;
};
const cookie = (raw: string | undefined): string | undefined => {
  const value = trim(raw);
  if (!value || /^authorization\s*:/iu.test(value)) return undefined;
  return value.replace(/^cookie\s*:\s*/iu, "").trim() || undefined;
};
const title = (value: string | undefined): string | undefined =>
  value?.trim().replace(/\b\w/g, (letter) => letter.toUpperCase());
const numberAt = (source: Dict | undefined, key: string): number | undefined =>
  source ? number(source[key]) : undefined;
const objectAt = (source: Dict | undefined, key: string): Dict | undefined =>
  source ? object(source[key]) : undefined;
const resetDescription = (ctx: ProviderContext, raw: unknown): string | undefined => {
  const parsed = date(raw, ctx);
  if (!parsed) return undefined;
  return `Resets ${ctx.format.monthDay(new Date(parsed))}`;
};
const ratio = (used: number, allowance: number, raw: unknown): number => {
  const api = number(raw);
  const unlimited = allowance > 1_000_000_000_000;
  if (
    api !== undefined &&
    Number.isFinite(api) &&
    !(api === 0 && used > 0 && allowance > 0 && !unlimited)
  ) {
    if (api >= -0.001 && api <= 1.001) return Math.max(0, Math.min(100, api * 100));
    if ((!allowance || unlimited) && api >= -0.1 && api <= 100.1)
      return Math.max(0, Math.min(100, api));
  }
  if (unlimited) return Math.min(100, (used / 100_000_000) * 100);
  return allowance > 0 ? Math.min(100, (used / allowance) * 100) : 0;
};
const requestHeaders = (cookieHeader: string | undefined, bearer: string | undefined): Headers => ({
  Accept: "application/json",
  "Content-Type": "application/json",
  Origin: "https://app.factory.ai",
  Referer: "https://app.factory.ai/",
  "x-factory-client": "web-app",
  ...(cookieHeader ? { Cookie: cookieHeader } : {}),
  ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
});
const responseObject = (ctx: ProviderContext, response: ProviderResponse, label: string): Dict => {
  if (response.status === 401) throw ctx.fail.authenticationExpired("Factory session is expired.");
  if (response.status === 403) throw ctx.fail.permissionDenied("Factory denied access.");
  if (response.status === 429) throw ctx.fail.rateLimited("Factory API returned HTTP 429.");
  if (response.status >= 500)
    throw ctx.fail.providerUnavailable(`Factory API returned HTTP ${response.status}.`);
  if (response.status < 200 || response.status >= 300)
    throw ctx.fail.apiFailure(`Factory ${label} API returned HTTP ${response.status}.`);
  const parsed = object(json(ctx, "Factory", response));
  if (!parsed) throw ctx.fail.parseFailure(`Factory ${label} response must be an object.`);
  return parsed;
};
const userID = (auth: Dict): string | undefined =>
  string(objectAt(auth, "userProfile")?.id) ?? string(auth.userId);
const identity = (auth: Dict) => {
  const org = objectAt(auth, "organization");
  const subscription = objectAt(org, "subscription");
  const orb = objectAt(subscription, "orbSubscription");
  const plan = objectAt(orb, "plan");
  const tier = title(string(subscription?.factoryTier));
  const planName = string(plan?.name);
  const parts = [
    tier ? `Factory ${tier}` : undefined,
    planName?.toLowerCase().includes("factory") ? undefined : planName,
  ].filter((part): part is string => Boolean(part));
  return {
    ...(string(objectAt(auth, "userProfile")?.email)
      ? { email: string(objectAt(auth, "userProfile")?.email) }
      : {}),
    ...(string(org?.name) ? { organization: string(org?.name) } : {}),
    ...(parts.length ? { loginMethod: parts.join(" - ") } : {}),
  };
};
const billingWindow = (ctx: ProviderContext, raw: unknown, windowMinutes?: number) => {
  const source = object(raw);
  if (!source) return undefined;
  const used = number(source.usedPercent);
  if (used === undefined) return undefined;
  const reset = date(source.windowEnd, ctx);
  const seconds = number(source.secondsRemaining);
  const resetsAt =
    seconds !== undefined && seconds > 0
      ? ctx.date.unixMillis(ctx.date.nowMillis() + seconds * 1_000)
      : reset;
  const stale = reset && !seconds && Date.parse(reset) <= ctx.date.nowMillis();
  return {
    usedPercent: stale ? 0 : Math.max(0, Math.min(100, used)),
    ...(windowMinutes ? { windowMinutes } : {}),
    ...(resetsAt ? { resetsAt } : {}),
    ...(resetsAt ? { resetDescription: resetDescription(ctx, resetsAt) } : {}),
  };
};
const rateLimitSnapshot = (ctx: ProviderContext, auth: Dict, billing: Dict) => {
  const limits = objectAt(billing, "limits");
  const standard = objectAt(limits, "standard");
  if (!standard) return undefined;
  const primary = billingWindow(ctx, standard.fiveHour, 300);
  const secondary = billingWindow(ctx, standard.weekly, 10_080);
  const tertiary = billingWindow(ctx, standard.monthly);
  if (!primary && !secondary && !tertiary) return undefined;
  const core = objectAt(limits, "core");
  const extraRateWindows: {
    id: string;
    title: string;
    window: NonNullable<ReturnType<typeof billingWindow>>;
  }[] = [];
  if (core) {
    for (const [id, label, raw, minutes] of [
      ["factory-core-5h", "Core 5h", core.fiveHour, 300],
      ["factory-core-7d", "Core 7-day", core.weekly, 10_080],
      ["factory-core-monthly", "Core Monthly", core.monthly, undefined],
    ] as const) {
      const window = billingWindow(ctx, raw, minutes);
      if (window) extraRateWindows.push({ id, title: label, window });
    }
  }
  const currentIdentity = identity(auth);
  const preference = string(billing.overagePreference);
  const loginMethod = [
    currentIdentity.loginMethod,
    preference ? `Fallback: ${preference}` : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" - ");
  const balanceCents = number(billing.extraUsageBalanceCents);
  return {
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    ...(tertiary ? { tertiary } : {}),
    ...(extraRateWindows.length ? { extraRateWindows } : {}),
    ...(balanceCents !== undefined
      ? {
          cost: {
            used: balanceCents / 100,
            limit: 0,
            currency: "USD",
            period: "Extra usage balance",
          },
        }
      : {}),
    identity: { ...currentIdentity, ...(loginMethod ? { loginMethod } : {}) },
  };
};

const definition: ProviderDefinition = {
  id: "factory",
  name: "Factory",
  endpoints: ["https://app.factory.ai", "https://auth.factory.ai", "https://api.factory.ai"],
  auth: { type: "bearer", secret: "FACTORY_API_KEY" },
  settings: [
    { key: "FACTORY_API_KEY", title: "API key", type: "secure" },
    { key: "FACTORY_COOKIE_HEADER", title: "Cookie or Authorization header", type: "secure" },
  ],
  capabilities: ["browser-cookies"],
  cookieDomains: ["app.factory.ai", "auth.factory.ai", "api.factory.ai"],
  fetchUsage: async (ctx: ProviderContext) => {
    const apiKey = token(
      ctx.settings.getSecret("FACTORY_API_KEY") ?? ctx.settings.get("FACTORY_API_KEY"),
    );
    const manual =
      ctx.settings.getSecret("FACTORY_COOKIE_HEADER") ?? ctx.settings.get("FACTORY_COOKIE_HEADER");
    const cookieHeader = cookie(manual) ?? trim(await ctx.browser.cookieHeader("app.factory.ai"));
    const bearerToken = apiKey ?? token(manual);
    if (!cookieHeader && !bearerToken)
      throw ctx.fail.missingCredential("Factory API key or browser session is not configured.");
    const bases = ["https://api.factory.ai", "https://app.factory.ai", "https://auth.factory.ai"];
    let lastError: Error | undefined;
    for (const base of bases) {
      try {
        const authResponse = await get(ctx, `${base}/api/app/auth/me`, {
          headers: requestHeaders(cookieHeader, bearerToken),
        });
        const auth = responseObject(ctx, authResponse, "auth");
        const billingResponse = await get(ctx, "https://api.factory.ai/api/billing/limits", {
          headers: requestHeaders(cookieHeader, bearerToken),
        });
        if (billingResponse.status === 200) {
          const billing = object(json(ctx, "Factory", billingResponse));
          if (billing?.usesTokenRateLimitsBilling === true) {
            const snapshot = rateLimitSnapshot(ctx, auth, billing);
            if (snapshot) return snapshot;
          }
        }
        const query = new URLSearchParams({ useCache: "true" });
        const id = userID(auth);
        if (id) query.set("userId", id);
        const usageResponse = await get(
          ctx,
          `${base}/api/organization/subscription/usage?${query}`,
          {
            headers: requestHeaders(cookieHeader, bearerToken),
          },
        );
        const usageRoot = responseObject(ctx, usageResponse, "usage");
        const usage = objectAt(usageRoot, "usage") ?? usageRoot;
        const standard = objectAt(usage, "standard") ?? {};
        const premium = objectAt(usage, "premium") ?? {};
        const periodEnd = date(usage.endDate, ctx);
        const window = (entry: Dict) => {
          const used = numberAt(entry, "userTokens") ?? 0;
          const allowance = numberAt(entry, "totalAllowance") ?? 0;
          return {
            usedPercent: ratio(used, allowance, entry.usedRatio),
            ...(periodEnd
              ? { resetsAt: periodEnd, resetDescription: resetDescription(ctx, periodEnd) }
              : {}),
          };
        };
        return { primary: window(standard), secondary: window(premium), identity: identity(auth) };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (
          String(lastError.message).startsWith("authentication-expired:") ||
          String(lastError.message).startsWith("permission-denied:")
        )
          throw lastError;
      }
    }
    throw lastError ?? ctx.fail.apiFailure("Factory usage endpoints did not succeed.");
  },
};

const strategy: ProviderStrategy = {
  id: "factory.web",
  kind: "web",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const factory: FirstPartyProvider = { ...strategy, descriptor };
