import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderResponse,
  ProviderStrategy,
} from "../types.ts";
import { number, object, status } from "./_http.ts";
import {
  parseOpenCodeGoBillingBalance,
  parseOpenCodeGoZenBalance,
} from "./open-code-go-balance.ts";
import { openCodeRequestCookieHeader } from "./open-code-cookie.ts";

const BASE = "https://opencode.ai";
const USAGE_API = `${BASE}/zen/go/v1/usage`;
const BILLING = "c83b78a614689c38ebee981f9b39a8b377716db85c1fd7dbab604adc02d3313d";
const WORKSPACES = "def39973159c7f0483d8793a822b8dbb10d067e12c65455fcb4608459ba0234f";
const optionalBalanceStartDelayMs = 25;
const optionalBalanceJoinMs = 250;
const optionalBalanceTimeoutSeconds = 5;
const userAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
const clamp = (value: number) => Math.max(0, Math.min(100, value));
const signedOut = (text: string) =>
  /login|sign in|auth\/authorize|not associated with an account|actor of type "public"/iu.test(
    text,
  );
const header = (id: string, cookie: string, referer: string) => ({
  Cookie: cookie,
  "X-Server-Id": id,
  "X-Server-Instance": `server-fn:${crypto.randomUUID()}`,
  "User-Agent": userAgent,
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
export const normalizeOpenCodeGoWorkspaceID = (raw: string | undefined): string | undefined => {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("wrk_") && trimmed.length > 4) return trimmed;
  try {
    const parts = new URL(trimmed).pathname.split("/").filter(Boolean);
    const index = parts.indexOf("workspace");
    const candidate = index >= 0 ? parts[index + 1] : undefined;
    if (candidate?.startsWith("wrk_") && candidate.length > 4) return candidate;
  } catch {
    // Non-URL text can still contain a workspace identifier.
  }
  return /wrk_[A-Za-z0-9]+/u.exec(trimmed)?.[0];
};
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
    const resetAt = [
      "resetAt",
      "resetsAt",
      "reset_at",
      "resets_at",
      "nextReset",
      "next_reset",
      "renewAt",
      "renew_at",
    ]
      .map((key) => record[key])
      .find((candidate) => number(candidate) !== undefined || typeof candidate === "string");
    const numericResetAt = number(resetAt);
    const resetMillis =
      numericResetAt === undefined
        ? typeof resetAt === "string"
          ? Date.parse(resetAt)
          : Number.NaN
        : numericResetAt > 10_000_000_000
          ? numericResetAt
          : numericResetAt * 1000;
    if (Number.isFinite(resetMillis)) seconds = Math.max(0, (resetMillis - now) / 1000);
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
const hydrationNumber = (raw: string, lane: string, field: string): number | undefined => {
  const match = new RegExp(`${lane}[^}]*?${field}\\s*:\\s*([0-9]+(?:\\.[0-9]+)?)`, "u").exec(
    raw,
  )?.[1];
  return match === undefined ? undefined : number(match);
};
export const parseOpenCodeGoUsageText = (raw: string, now: number) => {
  const jsonUsage = allWindows(parse(raw), now);
  if (jsonUsage.rolling) return jsonUsage;
  const rollingPercent = hydrationNumber(raw, "rollingUsage", "usagePercent");
  const rollingReset = hydrationNumber(raw, "rollingUsage", "resetInSec");
  if (rollingPercent === undefined || rollingReset === undefined) return jsonUsage;
  const weeklyPercent = hydrationNumber(raw, "weeklyUsage", "usagePercent");
  const weeklyReset = hydrationNumber(raw, "weeklyUsage", "resetInSec");
  const monthlyPercent = hydrationNumber(raw, "monthlyUsage", "usagePercent");
  const monthlyReset = hydrationNumber(raw, "monthlyUsage", "resetInSec");
  return {
    rolling: { percent: clamp(rollingPercent), seconds: Math.max(0, Math.trunc(rollingReset)) },
    ...(weeklyPercent === undefined || weeklyReset === undefined
      ? {}
      : {
          weekly: {
            percent: clamp(weeklyPercent),
            seconds: Math.max(0, Math.trunc(weeklyReset)),
          },
        }),
    ...(monthlyPercent === undefined && monthlyReset === undefined
      ? {}
      : {
          monthly: {
            percent: clamp(monthlyPercent ?? 0),
            seconds: Math.max(0, Math.trunc(monthlyReset ?? 0)),
          },
        }),
  };
};
const apiKey = (raw: string | undefined): string | undefined => {
  let value = raw?.trim();
  if (!value) return undefined;
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  )
    value = value.slice(1, -1).trim();
  return value || undefined;
};
const apiKeyFrom = (ctx: ProviderContext): string | undefined =>
  apiKey(ctx.settings.getSecret("OPENCODE_API_KEY") ?? ctx.settings.get("OPENCODE_API_KEY"));
const cancelled = (error: unknown, ctx?: ProviderContext): boolean =>
  ctx?.signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
const snapshot = (ctx: ProviderContext, usage: ReturnType<typeof allWindows>) => {
  const at = (candidate: Window | undefined) =>
    candidate ? ctx.date.unixMillis(ctx.date.nowMillis() + candidate.seconds * 1000) : undefined;
  if (!usage.rolling) throw ctx.fail.parseFailure("OpenCode Go response is missing usage fields.");
  return {
    primary: {
      usedPercent: usage.rolling.percent,
      windowMinutes: 300,
      resetsAt: at(usage.rolling),
    },
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
  };
};
const fetchAPI = async (ctx: ProviderContext, token: string) => {
  const response = await ctx.http.get(USAGE_API, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "User-Agent": "CodexBar",
    },
  });
  if (response.status === 401 || response.status === 403)
    throw ctx.fail.authenticationExpired("OpenCode Go API key is invalid or expired.");
  status(ctx, "OpenCode Go", response);
  const usage = allWindows(parse(response.bodyText), ctx.date.nowMillis());
  return snapshot(ctx, usage);
};
const cookie = async (ctx: ProviderContext) => {
  const manual =
    ctx.settings.getSecret("OPENCODEGO_COOKIE") ?? ctx.settings.get("OPENCODEGO_COOKIE");
  if (manual?.trim()) {
    const result = openCodeRequestCookieHeader(manual);
    if (!result) throw ctx.fail.missingCredential("OpenCode Go cookie header is invalid.");
    return result;
  }
  const result = openCodeRequestCookieHeader(await ctx.browser.cookieHeader("opencode.ai"));
  if (!result) throw ctx.fail.missingCredential("No OpenCode Go session cookie is available.");
  return result;
};

const fetchZenBalance = async (
  ctx: ProviderContext,
  workspace: string,
  session: string,
  signal: AbortSignal,
): Promise<number | undefined> => {
  const dashboard = await ctx.http.get(`${BASE}/workspace/${encodeURIComponent(workspace)}`, {
    headers: {
      Cookie: session,
      "User-Agent": userAgent,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    signal,
    timeoutSeconds: optionalBalanceTimeoutSeconds,
  });
  const dashboardBalance = parseOpenCodeGoZenBalance(text(ctx, dashboard));
  if (dashboardBalance !== undefined) return dashboardBalance;
  const args = encodeURIComponent(JSON.stringify([workspace]));
  const response = await ctx.http.get(
    `${BASE}/_server?id=${encodeURIComponent(BILLING)}&args=${args}`,
    {
      headers: header(BILLING, session, `${BASE}/workspace/${encodeURIComponent(workspace)}`),
      signal,
      timeoutSeconds: optionalBalanceTimeoutSeconds,
    },
  );
  return parseOpenCodeGoBillingBalance(text(ctx, response));
};

const completedOptionalZenBalance = async (
  ctx: ProviderContext,
  task: Promise<number | undefined>,
  controller: AbortController,
): Promise<number | undefined> => {
  if (ctx.date.sleep === undefined) {
    try {
      return await task;
    } catch (error) {
      if (cancelled(error, ctx)) throw error;
      return undefined;
    }
  }
  const timeout = Symbol("OpenCode Go optional balance timeout");
  try {
    const result = await Promise.race([
      task,
      ctx.date.sleep(optionalBalanceJoinMs).then(() => timeout),
    ]);
    if (typeof result !== "symbol") return result;
    controller.abort(new DOMException("OpenCode Go optional balance timed out.", "AbortError"));
    void task.catch(() => undefined);
    return undefined;
  } catch (error) {
    if (cancelled(error, ctx)) throw error;
    return undefined;
  }
};

/**
 * The public API is preferred in Auto mode, but its failure must not make a
 * still-valid browser session unusable.  Swift keeps the pre-existing web
 * path as the compatibility fallback for this exact case.
 */
const fetchWebUsage = async (ctx: ProviderContext) => {
  const session = await cookie(ctx);
  let workspace = normalizeOpenCodeGoWorkspaceID(ctx.settings.get("OPENCODEGO_WORKSPACE_ID"));
  if (!workspace) {
    const response = await ctx.http.get(`${BASE}/_server?id=${encodeURIComponent(WORKSPACES)}`, {
      headers: header(WORKSPACES, session, BASE),
    });
    workspace = workspaceFrom(text(ctx, response));
    if (!workspace && ctx.http.post !== undefined) {
      const fallback = await ctx.http.post(`${BASE}/_server`, {
        headers: {
          ...header(WORKSPACES, session, BASE),
          "Content-Type": "application/json",
        },
        body: [],
      });
      workspace = workspaceFrom(text(ctx, fallback));
    }
  }
  if (!workspace) throw ctx.fail.parseFailure("OpenCode Go response is missing a workspace ID.");
  const pageTask = ctx.http.get(`${BASE}/workspace/${encodeURIComponent(workspace)}/go`, {
    headers: {
      Cookie: session,
      "User-Agent": userAgent,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  const balanceController = new AbortController();
  const balanceTask = (async () => {
    if (ctx.date.sleep !== undefined) await ctx.date.sleep(optionalBalanceStartDelayMs);
    balanceController.signal.throwIfAborted();
    return fetchZenBalance(ctx, workspace, session, balanceController.signal);
  })();
  // The balance runs concurrently and can reject before the usage page settles. Attach a
  // handler now to avoid an unhandled-rejection window; later awaits still observe the original.
  void balanceTask.catch(() => undefined);
  let page: ProviderResponse;
  try {
    page = await pageTask;
  } catch (error) {
    balanceController.abort(new DOMException("OpenCode Go usage request failed.", "AbortError"));
    void balanceTask.catch(() => undefined);
    throw error;
  }
  let usage: ReturnType<typeof parseOpenCodeGoUsageText>;
  try {
    usage = parseOpenCodeGoUsageText(text(ctx, page), ctx.date.nowMillis());
  } catch (error) {
    balanceController.abort(new DOMException("OpenCode Go usage parsing failed.", "AbortError"));
    void balanceTask.catch(() => undefined);
    throw error;
  }
  let balance: number | undefined;
  if (!usage.rolling) {
    balance = await balanceTask;
    if (balance === undefined) {
      throw ctx.fail.parseFailure("OpenCode Go response is missing usage fields.");
    }
  } else {
    balance = await completedOptionalZenBalance(ctx, balanceTask, balanceController);
  }
  return {
    ...(usage.rolling ? snapshot(ctx, usage) : {}),
    ...(balance === undefined
      ? {}
      : {
          providerCost: { used: balance, limit: 0, currencyCode: "USD", period: "Zen balance" },
        }),
  };
};

const definition: ProviderDefinition = {
  id: "opencodego",
  name: "OpenCode Go",
  endpoints: [BASE],
  settings: [
    { key: "OPENCODE_API_KEY", title: "API key", type: "secure" },
    { key: "OPENCODEGO_COOKIE", title: "Cookie header", type: "secure" },
    { key: "OPENCODEGO_WORKSPACE_ID", title: "Workspace ID", type: "plain" },
  ],
  capabilities: ["browser-cookies"],
  cookieDomains: ["opencode.ai"],
  fetchUsage: async (ctx) => {
    // Compatibility entry point for parser/direct-provider callers. The host
    // runtime uses `strategies` below, where each source is independently
    // selected and fallback is classified before the next source is attempted.
    const token = apiKeyFrom(ctx);
    const apiMode =
      ctx.sourceMode === undefined || ctx.sourceMode === "auto" || ctx.sourceMode === "api";
    if (token && apiMode) {
      try {
        return await fetchAPI(ctx, token);
      } catch (error) {
        if (ctx.sourceMode !== "auto" || cancelled(error)) throw error;
        return fetchWebUsage(ctx);
      }
    }
    if (ctx.sourceMode === "api")
      throw ctx.fail.missingCredential("No OpenCode Go API key is configured.");
    return fetchWebUsage(ctx);
  },
};
const legacyStrategy: ProviderStrategy = {
  id: "opencodego.web",
  kind: "web",
  fetchUsage: definition.fetchUsage,
};
const apiStrategy: ProviderStrategy = {
  id: "opencodego.api",
  kind: "api",
  fetchUsage: async (ctx) => {
    const token = apiKeyFrom(ctx);
    if (!token) throw ctx.fail.missingCredential("No OpenCode Go API key is configured.");
    return fetchAPI(ctx, token);
  },
  // This mirrors the prior Auto-only direct path: a bad, unavailable, or
  // malformed API response may use the separately approved web session, but
  // an explicit API request never crosses that source boundary.
  fallbackOn: [
    "authentication-expired",
    "missing-credential",
    "permission-denied",
    "rate-limited",
    "provider-unavailable",
    "parse-failure",
    "network-failure",
    "api-failure",
  ],
};
const webStrategy: ProviderStrategy = {
  id: "opencodego.web",
  kind: "web",
  fetchUsage: fetchWebUsage,
};
const strategies = [apiStrategy, webStrategy] as const;
export const descriptor: ProviderDescriptor = {
  ...definition,
  status: "partial",
  strategy: legacyStrategy,
  strategies,
};
export const opencodego: FirstPartyProvider = { ...legacyStrategy, descriptor, strategies };
