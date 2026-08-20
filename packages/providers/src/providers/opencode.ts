import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderResponse,
  ProviderStrategy,
} from "../types.ts";
import { number, object, status } from "./_http.ts";

const WORKSPACES = "def39973159c7f0483d8793a822b8dbb10d067e12c65455fcb4608459ba0234f";
const SUBSCRIPTION = "7abeebee372f304e050aaaf92be863f4a86490e382f8c79db68fd94040d691b4";
const BILLING = "c83b78a614689c38ebee981f9b39a8b377716db85c1fd7dbab604adc02d3313d";
const base = "https://opencode.ai";
const clamp = (value: number) => Math.max(0, Math.min(100, value));
const serverHeaders = (id: string, cookie: string, referer: string) => ({
  Cookie: cookie,
  "X-Server-Id": id,
  "X-Server-Instance": "server-fn:codexbar-multi",
  Origin: base,
  Referer: referer,
  Accept: "text/javascript, application/json;q=0.9, */*;q=0.8",
});
const signedOut = (text: string) =>
  /login|sign in|auth\/authorize|not associated with an account|actor of type "public"/iu.test(
    text,
  );
const cookie = async (ctx: ProviderContext) => {
  const manual = ctx.settings.getSecret("OPENCODE_COOKIE") ?? ctx.settings.get("OPENCODE_COOKIE");
  const value = manual?.trim() || (await ctx.browser.cookieHeader("opencode.ai")).trim();
  if (!value) throw ctx.fail.missingCredential("No OpenCode session cookie is available.");
  return value;
};
const response = (ctx: ProviderContext, name: string, raw: ProviderResponse): string => {
  if (signedOut(raw.bodyText) || raw.status === 401 || raw.status === 403)
    throw ctx.fail.authenticationExpired(`${name} session cookie is invalid or expired.`);
  status(ctx, name, raw);
  return raw.bodyText;
};
const findWorkspace = (text: string): string | undefined => {
  const direct = /id\s*:\s*["'](wrk_[A-Za-z0-9_-]+)["']/u.exec(text)?.[1];
  if (direct) return direct;
  const match = /wrk_[A-Za-z0-9_-]+/u.exec(text)?.[0];
  return match;
};
type Window = { readonly percent: number; readonly resetInSec: number };
const numeric = (value: unknown) => number(value);
const valueFor = (record: Record<string, unknown>, names: readonly string[]) =>
  names.map((name) => record[name]).find((value) => numeric(value) !== undefined);
const parseWindow = (raw: unknown, now: Date): Window | undefined => {
  const record = object(raw);
  if (!record) return undefined;
  const direct = valueFor(record, [
    "usagePercent",
    "usedPercent",
    "percentUsed",
    "percent",
    "usage_percent",
    "used_percent",
    "utilization",
  ]);
  const used = valueFor(record, ["used", "usage", "consumed", "count"]);
  const limit = valueFor(record, ["limit", "total", "quota", "max", "cap"]);
  const result =
    numeric(direct) ??
    (numeric(used) !== undefined && (numeric(limit) ?? 0) > 0
      ? ((numeric(used) as number) / (numeric(limit) as number)) * 100
      : undefined);
  if (result === undefined) return undefined;
  let reset =
    numeric(
      valueFor(record, [
        "resetInSec",
        "resetInSeconds",
        "resetSeconds",
        "reset_sec",
        "reset_in_sec",
        "resetsInSec",
        "resetIn",
        "resetSec",
      ]),
    ) ?? 0;
  if (!reset) {
    const resetAt = valueFor(record, ["resetAt", "resetsAt", "reset_at", "nextReset", "renewAt"]);
    const rawDate = numeric(resetAt);
    if (rawDate !== undefined) {
      const resetMillis = rawDate > 10_000_000_000 ? rawDate : rawDate * 1000;
      reset = Math.max(0, (resetMillis - now.getTime()) / 1000);
    }
  }
  return {
    percent: clamp(result <= 1 && direct !== undefined ? result * 100 : result),
    resetInSec: Math.max(0, Math.trunc(reset)),
  };
};
const windows = (
  raw: unknown,
  now: Date,
): { rolling?: Window; weekly?: Window; monthly?: Window } => {
  const found: { rolling?: Window; weekly?: Window; monthly?: Window } = {};
  const visit = (value: unknown, path = "") => {
    const record = object(value);
    if (record) {
      const parsed = parseWindow(record, now);
      const lower = path.toLowerCase();
      if (parsed) {
        if (!found.rolling && /rolling|hour|5h/u.test(lower)) found.rolling = parsed;
        else if (!found.weekly && /week/u.test(lower)) found.weekly = parsed;
        else if (!found.monthly && /month/u.test(lower)) found.monthly = parsed;
      }
      for (const [key, child] of Object.entries(record)) visit(child, `${path}.${key}`);
    } else if (Array.isArray(value))
      value.forEach((child, index) => visit(child, `${path}.${index}`));
  };
  visit(raw);
  return found;
};
const json = (text: string): unknown | undefined => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

const definition: ProviderDefinition = {
  id: "opencode",
  name: "OpenCode",
  endpoints: [base],
  settings: [
    { key: "OPENCODE_COOKIE", title: "Cookie header", type: "secure" },
    { key: "OPENCODE_WORKSPACE_ID", title: "Workspace ID", type: "plain" },
  ],
  capabilities: ["browser-cookies"],
  cookieDomains: ["opencode.ai"],
  fetchUsage: async (ctx) => {
    const session = await cookie(ctx);
    let workspaceId = ctx.settings.get("OPENCODE_WORKSPACE_ID")?.trim();
    if (!workspaceId) {
      const workspacesResponse = await ctx.http.get(
        `${base}/_server?id=${encodeURIComponent(WORKSPACES)}`,
        {
          headers: serverHeaders(WORKSPACES, session, base),
        },
      );
      workspaceId = findWorkspace(response(ctx, "OpenCode", workspacesResponse));
    }
    if (!workspaceId) throw ctx.fail.parseFailure("OpenCode response is missing a workspace ID.");
    const args = encodeURIComponent(JSON.stringify([workspaceId]));
    const referer = `${base}/workspace/${encodeURIComponent(workspaceId)}/billing`;
    const subscriptionResponse = await ctx.http.get(
      `${base}/_server?id=${encodeURIComponent(SUBSCRIPTION)}&args=${args}`,
      { headers: serverHeaders(SUBSCRIPTION, session, referer) },
    );
    const subscription = response(ctx, "OpenCode", subscriptionResponse);
    const parsed = windows(json(subscription), ctx.date.now());
    if (parsed.rolling && parsed.weekly) {
      const primary = parsed.rolling;
      const secondary = parsed.weekly;
      return {
        primary: {
          usedPercent: primary.percent,
          windowMinutes: 300,
          resetsAt: ctx.date.unixMillis(ctx.date.nowMillis() + primary.resetInSec * 1000),
        },
        secondary: {
          usedPercent: secondary.percent,
          windowMinutes: 10080,
          resetsAt: ctx.date.unixMillis(ctx.date.nowMillis() + secondary.resetInSec * 1000),
        },
      };
    }
    const billingResponse = await ctx.http.get(
      `${base}/_server?id=${encodeURIComponent(BILLING)}&args=${args}`,
      { headers: serverHeaders(BILLING, session, referer) },
    );
    const billing = object(json(response(ctx, "OpenCode", billingResponse)));
    const usage = numeric(
      billing?.monthlyUsageUSD ?? billing?.monthly_usage_usd ?? billing?.usage ?? billing?.spent,
    );
    const limit = numeric(billing?.monthlyLimitUSD ?? billing?.monthly_limit_usd ?? billing?.limit);
    const balance = numeric(billing?.balanceUSD ?? billing?.balance_usd ?? billing?.balance);
    if (usage === undefined)
      throw ctx.fail.parseFailure("OpenCode response is missing subscription usage fields.");
    return {
      ...(limit && limit > 0
        ? { primary: { usedPercent: clamp((usage / limit) * 100), windowMinutes: 43200 } }
        : {}),
      providerCost: {
        used: usage,
        limit: limit ?? 0,
        currencyCode: "USD",
        period: "Monthly",
        ...(balance === undefined ? {} : { balance }),
      },
    };
  },
};
const strategy: ProviderStrategy = {
  id: "opencode.web",
  kind: "web",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const opencode: FirstPartyProvider = { ...strategy, descriptor };
