import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderSnapshot,
  ProviderStrategy,
} from "../types.ts";
import { get, json, object } from "./_http.ts";
import { fetchCopilotBudgetWindows } from "./copilot-budgets.ts";
import { mapCopilotUsage } from "./copilot-usage.ts";

/**
 * The Copilot internal endpoint deliberately accepts the GitHub OAuth token,
 * rather than a short-lived Copilot token. This mirrors CopilotUsageFetcher.
 *
 * Chrome-only cookie import and CookieHeaderCache stay host-owned. This module
 * declares `browser-cookies` plus github.com domains and consumes
 * `ctx.browser.cookieHeader` / a manual Cookie header only.
 */
const defaultHost = "github.com";

const usageHeaders = (token: string): Readonly<Record<string, string>> => ({
  Authorization: `token ${token}`,
  Accept: "application/json",
  "Editor-Version": "vscode/1.96.2",
  "Editor-Plugin-Version": "copilot-chat/0.26.7",
  "User-Agent": "GitHubCopilotChat/0.26.7",
  "X-Github-Api-Version": "2025-04-01",
});

export const normalizedHost = (raw: string | undefined): string => {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) return defaultHost;
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    const host = url.hostname.toLowerCase();
    const port = url.port ? `:${url.port}` : "";
    const normalized = `${host}${port}`.replace(/^\.+|\.+$/gu, "");
    return normalized || defaultHost;
  } catch {
    let host = trimmed;
    const lower = host.toLowerCase();
    if (lower.startsWith("https://")) host = host.slice("https://".length);
    else if (lower.startsWith("http://")) host = host.slice("http://".length);
    host = host.split("/")[0] ?? host;
    const normalized = host.replace(/^\.+|\.+$/gu, "").toLowerCase();
    return normalized || defaultHost;
  }
};

export const apiHost = (enterpriseHost: string | undefined): string => {
  const host = normalizedHost(enterpriseHost);
  if (host === defaultHost) return "api.github.com";
  return host.startsWith("api.") ? host : `api.${host}`;
};

const usageURL = (ctx: ProviderContext, enterpriseHost: string | undefined): string => {
  const host = apiHost(enterpriseHost);
  try {
    return new URL(`https://${host}/copilot_internal/user`).href;
  } catch {
    throw ctx.fail.apiFailure("Copilot enterprise host is invalid.");
  }
};

const cookieHeaderPatterns = [
  /-H\s*'Cookie:\s*([^']+)'/iu,
  /-H\s*"Cookie:\s*([^"]+)"/iu,
  /\bcookie:\s*'([^']+)'/iu,
  /\bcookie:\s*"([^"]+)"/iu,
  /\bcookie:\s*([^\r\n]+)/iu,
  /(?:^|\s)(?:--cookie|-b)\s*'([^']+)'/iu,
  /(?:^|\s)(?:--cookie|-b)\s*"([^"]+)"/iu,
  /(?:^|\s)-b([^\s=]+=[^\s]+)/iu,
  /(?:^|\s)(?:--cookie|-b)\s+([^\s]+)/iu,
];

const stripWrappingQuotes = (raw: string): string => {
  if (
    raw.length >= 2 &&
    ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
  ) {
    return raw.slice(1, -1);
  }
  return raw;
};

const stripCookiePrefix = (raw: string): string => {
  const trimmed = raw.trim();
  return trimmed.toLowerCase().startsWith("cookie:")
    ? trimmed.slice("cookie:".length).trim()
    : trimmed;
};

export const normalizeCookieHeader = (raw: string | undefined): string | undefined => {
  let value = raw?.trim() ?? "";
  if (!value) return undefined;
  for (const pattern of cookieHeaderPatterns) {
    const match = pattern.exec(value);
    if (match?.[1]?.trim()) {
      value = match[1].trim();
      break;
    }
  }
  value = stripWrappingQuotes(stripCookiePrefix(value)).trim();
  return value || undefined;
};

export const budgetCookieHeaderOverride = (
  source: string | undefined,
  header: string | undefined,
): string | undefined => {
  if ((source ?? "auto").trim().toLowerCase() !== "manual") return undefined;
  return normalizeCookieHeader(header);
};

const truthy = (value: string | undefined): boolean => {
  const raw = value?.trim().toLowerCase() ?? "";
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
};

const cookieSource = (ctx: ProviderContext): "auto" | "manual" | "off" => {
  const raw = ctx.settings.get("COPILOT_BUDGET_COOKIE_SOURCE")?.trim().toLowerCase();
  return raw === "manual" || raw === "off" ? raw : "auto";
};

const cancelled = (error: unknown): boolean =>
  (error instanceof DOMException && error.name === "AbortError") ||
  (error instanceof Error && error.name === "AbortError");

const classifyCopilotStatus = (ctx: ProviderContext, status: number, label: string): void => {
  if (status === 401 || status === 403) {
    throw ctx.fail.authenticationExpired(`${label} rejected the GitHub OAuth token.`);
  }
  if (status !== 200) throw ctx.fail.apiFailure(`${label} API returned HTTP ${status}.`);
};

const fetchGitHubIdentity = async (
  ctx: ProviderContext,
  token: string,
): Promise<{ id: number; login: string }> => {
  const response = await get(ctx, "https://api.github.com/user", {
    headers: { Authorization: `token ${token}`, Accept: "application/json" },
  });
  classifyCopilotStatus(ctx, response.status, "GitHub identity");
  const root = object(json(ctx, "GitHub identity", response));
  const id = typeof root?.id === "number" && Number.isFinite(root.id) ? root.id : undefined;
  const login = typeof root?.login === "string" ? root.login : undefined;
  if (id === undefined || !login) {
    throw ctx.fail.parseFailure("GitHub identity response is missing id or login.");
  }
  return { id, login };
};

const browserCookieHeader = async (ctx: ProviderContext): Promise<string | undefined> => {
  const github = (await ctx.browser.cookieHeader("github.com")).trim();
  if (github) return github;
  const www = (await ctx.browser.cookieHeader("www.github.com")).trim();
  return www || undefined;
};

const addBudgetWindowsIfNeeded = async (
  ctx: ProviderContext,
  snapshot: ProviderSnapshot,
  token: string,
): Promise<ProviderSnapshot> => {
  if (!truthy(ctx.settings.get("COPILOT_BUDGET_EXTRAS_ENABLED"))) return snapshot;
  const source = cookieSource(ctx);
  if (source === "off") return snapshot;
  const manual = budgetCookieHeaderOverride(
    source,
    ctx.settings.getSecret("COPILOT_BUDGET_COOKIE_HEADER") ??
      ctx.settings.get("COPILOT_BUDGET_COOKIE_HEADER"),
  );
  if (source === "manual" && !manual) return snapshot;

  try {
    const cookie = manual ?? (await browserCookieHeader(ctx));
    if (!cookie) return snapshot;
    const identity = await fetchGitHubIdentity(ctx, token);
    const windows = await fetchCopilotBudgetWindows(ctx, cookie, `github:user:${identity.id}`);
    if (windows.length === 0) return snapshot;
    return { ...snapshot, extraRateWindows: windows };
  } catch (error) {
    if (cancelled(error)) throw error;
    return snapshot;
  }
};

const definition: ProviderDefinition = {
  id: "copilot",
  name: "Copilot",
  endpoints: [
    "https://api.github.com",
    "https://github.com",
    {
      setting: "COPILOT_ENTERPRISE_HOST",
      policy: "https",
      subdomainPrefixes: ["api"],
    },
  ],
  auth: { type: "authorization-scheme", secret: "COPILOT_API_TOKEN", scheme: "token" },
  settings: [
    { key: "COPILOT_API_TOKEN", title: "GitHub OAuth token", type: "secure" },
    { key: "COPILOT_ENTERPRISE_HOST", title: "Enterprise host", type: "plain" },
    {
      key: "COPILOT_BUDGET_EXTRAS_ENABLED",
      title: "Budget extras",
      subtitle: "Fetch configured GitHub Copilot budget limits as extra bars.",
      type: "plain",
    },
    {
      key: "COPILOT_BUDGET_COOKIE_SOURCE",
      title: "GitHub cookies",
      subtitle: "auto, manual, or off. Auto imports github.com cookies for budget extras.",
      type: "plain",
    },
    {
      key: "COPILOT_BUDGET_COOKIE_HEADER",
      title: "Manual GitHub Cookie header",
      subtitle: "Paste a github.com Cookie header. Treat this value like a password.",
      type: "secure",
    },
  ],
  capabilities: ["browser-cookies"],
  cookieDomains: ["github.com", "www.github.com"],
  fetchUsage: async (ctx: ProviderContext) => {
    const token =
      ctx.settings.getSecret("COPILOT_API_TOKEN")?.trim() ||
      ctx.settings.get("COPILOT_API_TOKEN")?.trim();
    if (!token) throw ctx.fail.missingCredential("GitHub OAuth token is not configured.");
    const response = await get(ctx, usageURL(ctx, ctx.settings.get("COPILOT_ENTERPRISE_HOST")), {
      headers: usageHeaders(token),
    });
    classifyCopilotStatus(ctx, response.status, "Copilot");
    const snapshot = mapCopilotUsage(ctx, json(ctx, "Copilot", response));
    return addBudgetWindowsIfNeeded(ctx, snapshot, token);
  },
};

const strategy: ProviderStrategy = {
  id: "copilot.api",
  kind: "api",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const copilot: FirstPartyProvider = { ...strategy, descriptor };
