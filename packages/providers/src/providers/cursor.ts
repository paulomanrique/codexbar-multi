import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { number, object, status, string } from "./_http.ts";

type Usage = {
  readonly used?: number;
  readonly limit?: number;
  readonly autoPercentUsed?: number;
  readonly apiPercentUsed?: number;
  readonly totalPercentUsed?: number;
};

const clamp = (value: number): number => Math.max(0, Math.min(100, value));
const membershipLabel = (value: string): string => {
  const plan =
    {
      enterprise: "Enterprise",
      express: "Start",
      free: "Free",
      free_trial: "Pro Trial",
      hobby: "Hobby",
      pro: "Pro",
      pro_student: "Pro",
      pro_plus: "Pro+",
      team: "Team",
      ultra: "Ultra",
    }[value.toLowerCase()] ?? value;
  return `Cursor ${plan}`;
};
const cents = (value: unknown): number => number(value) ?? 0;
const usage = (value: unknown): Usage => {
  const input = object(value);
  if (!input) return {};
  const result: {
    used?: number;
    limit?: number;
    autoPercentUsed?: number;
    apiPercentUsed?: number;
    totalPercentUsed?: number;
  } = {};
  const used = number(input.used);
  const limit = number(input.limit);
  const autoPercentUsed = number(input.autoPercentUsed);
  const apiPercentUsed = number(input.apiPercentUsed);
  const totalPercentUsed = number(input.totalPercentUsed);
  if (used !== undefined) result.used = used;
  if (limit !== undefined) result.limit = limit;
  if (autoPercentUsed !== undefined) result.autoPercentUsed = autoPercentUsed;
  if (apiPercentUsed !== undefined) result.apiPercentUsed = apiPercentUsed;
  if (totalPercentUsed !== undefined) result.totalPercentUsed = totalPercentUsed;
  return result;
};
const date = (value: unknown, ctx: ProviderContext): string | undefined => {
  const epoch = number(value);
  if (epoch !== undefined)
    return epoch > 10_000_000_000 ? ctx.date.unixMillis(epoch) : ctx.date.unixSeconds(epoch);
  const raw = string(value);
  if (!raw) return undefined;
  try {
    return ctx.date.iso(raw);
  } catch {
    return undefined;
  }
};
const cookie = async (ctx: ProviderContext): Promise<string> => {
  const manual = ctx.settings.getSecret("CURSOR_COOKIE") ?? ctx.settings.get("CURSOR_COOKIE");
  const value = manual?.trim() || (await ctx.browser.cookieHeader("cursor.com")).trim();
  if (!value) throw ctx.fail.missingCredential("No Cursor session cookie is available.");
  return value;
};

const definition: ProviderDefinition = {
  id: "cursor",
  name: "Cursor",
  endpoints: ["https://cursor.com", "https://www.cursor.com", "https://cursor.sh"],
  settings: [{ key: "CURSOR_COOKIE", title: "Cookie header", type: "secure" }],
  capabilities: ["browser-cookies"],
  cookieDomains: ["cursor.com", "www.cursor.com", "cursor.sh", "authenticator.cursor.sh"],
  fetchUsage: async (ctx) => {
    const header = await cookie(ctx);
    const headers = { Accept: "application/json", Cookie: header };
    let summaryResponse;
    try {
      summaryResponse = await ctx.http.getJSON("https://cursor.com/api/usage-summary", { headers });
    } catch (error) {
      throw ctx.fail.networkFailure(error instanceof Error ? error.message : String(error));
    }
    status(ctx, "Cursor", summaryResponse);
    const root = object(summaryResponse.json);
    if (!root) throw ctx.fail.parseFailure("Cursor usage summary must be an object.");
    const individual = object(root.individualUsage);
    const team = object(root.teamUsage);
    const plan = usage(individual?.plan);
    const overall = usage(individual?.overall);
    const pooled = usage(team?.pooled);
    const onDemand = usage(individual?.onDemand);
    const teamOnDemand = usage(team?.onDemand);
    const auto = plan.autoPercentUsed;
    const api = plan.apiPercentUsed;
    const total = plan.totalPercentUsed;
    const selected =
      plan.limit || plan.used ? plan : overall.limit || overall.used ? overall : pooled;
    const percent =
      total ??
      (auto !== undefined && api !== undefined ? (auto + api) / 2 : (api ?? auto)) ??
      (selected.limit && selected.limit > 0 ? ctx.pct(selected.used ?? 0, selected.limit) : 0);
    const cycleStart = date(root.billingCycleStart, ctx);
    const resetsAt = date(root.billingCycleEnd, ctx);
    const windowMinutes =
      cycleStart && resetsAt
        ? Math.max(1, Math.round((Date.parse(resetsAt) - Date.parse(cycleStart)) / 60_000))
        : undefined;
    const personalLimit = onDemand.limit === undefined ? undefined : cents(onDemand.limit) / 100;
    const sharedLimit =
      teamOnDemand.limit === undefined ? undefined : cents(teamOnDemand.limit) / 100;
    const usePersonal = (personalLimit ?? 0) > 0 || (sharedLimit ?? 0) === 0;
    const costUsed = (usePersonal ? cents(onDemand.used) : cents(teamOnDemand.used)) / 100;
    const costLimit = usePersonal ? personalLimit : sharedLimit;
    let user: Record<string, unknown> | undefined;
    try {
      const response = await ctx.http.getJSON("https://cursor.com/api/auth/me", { headers });
      if (response.status >= 200 && response.status < 300) user = object(response.json);
    } catch {
      // Identity is explicitly optional in the upstream fan-out.
    }
    return {
      primary: {
        usedPercent: clamp(percent),
        ...(windowMinutes === undefined ? {} : { windowMinutes }),
        ...(resetsAt ? { resetsAt } : {}),
        ...(resetsAt ? { resetDescription: `Resets ${resetsAt}` } : {}),
      },
      ...(auto === undefined
        ? {}
        : {
            secondary: {
              usedPercent: clamp(auto),
              ...(windowMinutes === undefined ? {} : { windowMinutes }),
              ...(resetsAt ? { resetsAt } : {}),
            },
          }),
      ...(api === undefined
        ? {}
        : {
            tertiary: {
              usedPercent: clamp(api),
              ...(windowMinutes === undefined ? {} : { windowMinutes }),
              ...(resetsAt ? { resetsAt } : {}),
            },
          }),
      ...(costUsed > 0 || (costLimit ?? 0) > 0
        ? {
            providerCost: {
              used: costUsed,
              limit: costLimit ?? 0,
              currencyCode: "USD",
              period: "Monthly",
              ...(resetsAt ? { resetsAt } : {}),
              ...(usePersonal || cents(onDemand.used) === 0
                ? {}
                : { personalUsed: cents(onDemand.used) / 100 }),
            },
          }
        : {}),
      identity: {
        ...(string(user?.email) ? { email: string(user?.email) } : {}),
        ...(string(user?.sub) ? { accountID: string(user?.sub) } : {}),
        ...(string(root.membershipType)
          ? { loginMethod: membershipLabel(string(root.membershipType)!) }
          : {}),
      },
    };
  },
};
const strategy: ProviderStrategy = {
  id: "cursor.web",
  kind: "web",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const cursor: FirstPartyProvider = { ...strategy, descriptor };
