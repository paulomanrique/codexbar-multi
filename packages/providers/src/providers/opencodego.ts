import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderResponse,
  ProviderStrategy,
} from "../types.ts";
import { number, object, status } from "./_http.ts";

const BASE = "https://opencode.ai";
const BILLING = "c83b78a614689c38ebee981f9b39a8b377716db85c1fd7dbab604adc02d3313d";
const WORKSPACES = "def39973159c7f0483d8793a822b8dbb10d067e12c65455fcb4608459ba0234f";
const clamp = (value: number) => Math.max(0, Math.min(100, value));
const signedOut = (text: string) =>
  /login|sign in|auth\/authorize|not associated with an account|actor of type "public"/iu.test(
    text,
  );
const header = (id: string, cookie: string, referer: string) => ({
  Cookie: cookie,
  "X-Server-Id": id,
  "X-Server-Instance": "server-fn:codexbar-multi",
  Origin: BASE,
  Referer: referer,
  Accept: "text/javascript, application/json;q=0.9, */*;q=0.8",
});
const text = (ctx: ProviderContext, response: ProviderResponse): string => {
  if (signedOut(response.bodyText) || response.status === 401 || response.status === 403)
    throw ctx.fail.authenticationExpired("OpenCode Go session cookie is invalid or expired.");
  status(ctx, "OpenCode Go", response);
  return response.bodyText;
};
const parse = (raw: string): unknown | undefined => {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
};
const workspaceFrom = (raw: string) => /wrk_[A-Za-z0-9_-]+/u.exec(raw)?.[0];
type Window = { readonly percent: number; readonly seconds: number };
const value = (record: Record<string, unknown>, keys: readonly string[]) =>
  keys.map((key) => number(record[key])).find((candidate) => candidate !== undefined);
const window = (raw: unknown, now: number): Window | undefined => {
  const record = object(raw);
  if (!record) return undefined;
  const direct = value(record, [
    "usagePercent",
    "usedPercent",
    "percentUsed",
    "percent",
    "usage_percent",
    "used_percent",
    "utilization",
  ]);
  const used = value(record, ["used", "usage", "consumed", "count"]);
  const limit = value(record, ["limit", "total", "quota", "max", "cap"]);
  const rawPercent =
    direct ??
    (used !== undefined && (limit ?? 0) > 0 ? (used / (limit as number)) * 100 : undefined);
  if (rawPercent === undefined) return undefined;
  let seconds =
    value(record, [
      "resetInSec",
      "resetInSeconds",
      "resetSeconds",
      "reset_sec",
      "reset_in_sec",
      "resetsInSec",
      "resetIn",
      "resetSec",
    ]) ?? 0;
  if (!seconds) {
    const resetAt = value(record, ["resetAt", "resetsAt", "reset_at", "nextReset", "renewAt"]);
    if (resetAt !== undefined)
      seconds = Math.max(0, ((resetAt > 10_000_000_000 ? resetAt : resetAt * 1000) - now) / 1000);
  }
  return {
    percent: clamp(
      direct !== undefined && rawPercent >= 0 && rawPercent <= 1 ? rawPercent * 100 : rawPercent,
    ),
    seconds: Math.max(0, Math.trunc(seconds)),
  };
};
const allWindows = (raw: unknown, now: number) => {
  const found: { rolling?: Window; weekly?: Window; monthly?: Window } = {};
  const visit = (input: unknown, path = "") => {
    const record = object(input);
    if (record) {
      const parsed = window(record, now);
      const lower = path.toLowerCase();
      if (parsed) {
        if (!found.rolling && /rolling|hour|5h/u.test(lower)) found.rolling = parsed;
        else if (!found.weekly && /week/u.test(lower)) found.weekly = parsed;
        else if (!found.monthly && /month/u.test(lower)) found.monthly = parsed;
      }
      for (const [key, child] of Object.entries(record)) visit(child, `${path}.${key}`);
    } else if (Array.isArray(input))
      input.forEach((child, index) => visit(child, `${path}.${index}`));
  };
  visit(raw);
  return found;
};
const numberDeep = (input: unknown, keys: readonly string[]): number | undefined => {
  const record = object(input);
  if (!record) return undefined;
  for (const key of keys) {
    const found = number(record[key]);
    if (found !== undefined) return found;
  }
  for (const child of Object.values(record)) {
    const found = numberDeep(child, keys);
    if (found !== undefined) return found;
  }
  return undefined;
};
const cookie = async (ctx: ProviderContext) => {
  const manual =
    ctx.settings.getSecret("OPENCODEGO_COOKIE") ?? ctx.settings.get("OPENCODEGO_COOKIE");
  const result = manual?.trim() || (await ctx.browser.cookieHeader("opencode.ai")).trim();
  if (!result) throw ctx.fail.missingCredential("No OpenCode Go session cookie is available.");
  return result;
};

const definition: ProviderDefinition = {
  id: "opencodego",
  name: "OpenCode Go",
  endpoints: [BASE],
  settings: [
    { key: "OPENCODEGO_COOKIE", title: "Cookie header", type: "secure" },
    { key: "OPENCODEGO_WORKSPACE_ID", title: "Workspace ID", type: "plain" },
  ],
  capabilities: ["browser-cookies"],
  cookieDomains: ["opencode.ai"],
  fetchUsage: async (ctx) => {
    const session = await cookie(ctx);
    let workspace = ctx.settings.get("OPENCODEGO_WORKSPACE_ID")?.trim();
    if (!workspace) {
      const response = await ctx.http.get(`${BASE}/_server?id=${encodeURIComponent(WORKSPACES)}`, {
        headers: header(WORKSPACES, session, BASE),
      });
      workspace = workspaceFrom(text(ctx, response));
    }
    if (!workspace) throw ctx.fail.parseFailure("OpenCode Go response is missing a workspace ID.");
    const page = await ctx.http.get(`${BASE}/workspace/${encodeURIComponent(workspace)}/go`, {
      headers: {
        Cookie: session,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    const usage = allWindows(parse(text(ctx, page)), ctx.date.nowMillis());
    const args = encodeURIComponent(JSON.stringify([workspace]));
    let balance: number | undefined;
    try {
      const response = await ctx.http.get(
        `${BASE}/_server?id=${encodeURIComponent(BILLING)}&args=${args}`,
        {
          headers: header(
            BILLING,
            session,
            `${BASE}/workspace/${encodeURIComponent(workspace)}/go`,
          ),
        },
      );
      balance = numberDeep(parse(text(ctx, response)), [
        "zenBalanceUSD",
        "zen_balance_usd",
        "balanceUSD",
        "balance_usd",
        "balance",
      ]);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("authentication-expired")) throw error;
      // The upstream balance request is optional and must not hide valid quota data.
    }
    if (!usage.rolling && balance === undefined)
      throw ctx.fail.parseFailure("OpenCode Go response is missing usage fields.");
    const at = (candidate: Window | undefined) =>
      candidate ? ctx.date.unixMillis(ctx.date.nowMillis() + candidate.seconds * 1000) : undefined;
    return {
      ...(usage.rolling
        ? {
            primary: {
              usedPercent: usage.rolling.percent,
              windowMinutes: 300,
              resetsAt: at(usage.rolling),
            },
          }
        : {}),
      ...(usage.weekly
        ? {
            secondary: {
              usedPercent: usage.weekly.percent,
              windowMinutes: 10080,
              resetsAt: at(usage.weekly),
            },
          }
        : {}),
      ...(usage.monthly
        ? {
            tertiary: {
              usedPercent: usage.monthly.percent,
              windowMinutes: 43200,
              resetsAt: at(usage.monthly),
            },
          }
        : {}),
      ...(balance === undefined
        ? {}
        : {
            providerCost: { used: balance, limit: 0, currencyCode: "USD", period: "Zen balance" },
          }),
    };
  },
};
const strategy: ProviderStrategy = {
  id: "opencodego.web",
  kind: "web",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const opencodego: FirstPartyProvider = { ...strategy, descriptor };
