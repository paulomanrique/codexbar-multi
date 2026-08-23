import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { number, object, status, string } from "./_http.ts";

const clampPercent = (value: number) => Math.max(0, Math.min(100, value));
/** Upstream app-auto order; the CLI runtime uses web → cli and is selected by the host. */
export const claudeAppAutoSourceOrder = ["oauth", "cli", "web"] as const;
const window = (value: unknown, minutes: number, ctx: ProviderContext) => {
  const record = object(value);
  const used = number(record?.utilization) ?? number(record?.pct_used);
  if (used === undefined) return undefined;
  const reset = string(record?.resets_at) ?? string(record?.resets);
  return {
    usedPercent: clampPercent(used),
    windowMinutes: minutes,
    ...(reset && /^\d{4}-\d{2}-\d{2}T/u.test(reset) ? { resetsAt: ctx.date.iso(reset) } : {}),
    ...(reset ? { resetDescription: reset } : {}),
  };
};

/**
 * Shared parser for Claude's OAuth, web and `/usage` JSON payloads.  The
 * process that obtains CLI output and the Electron session that owns cookies
 * remain platform adapters; this function deliberately receives only data.
 */
export const parseClaudeUsage = (payload: unknown, ctx: ProviderContext) => {
  const root = object(payload);
  if (!root) throw ctx.fail.parseFailure("Claude usage response is not an object.");
  const primary =
    window(root.five_hour, 300, ctx) ??
    window(root.session_5h, 300, ctx) ??
    window(root.seven_day, 10_080, ctx) ??
    window(root.week_all_models, 10_080, ctx);
  if (!primary) throw ctx.fail.parseFailure("Claude usage response is missing session data.");
  const weekly = window(root.seven_day, 10_080, ctx) ?? window(root.week_all_models, 10_080, ctx);
  const scoped =
    window(root.seven_day_sonnet, 10_080, ctx) ??
    window(root.week_sonnet, 10_080, ctx) ??
    window(root.seven_day_opus, 10_080, ctx) ??
    window(root.week_opus, 10_080, ctx);
  const routines =
    window(root.seven_day_routines, 10_080, ctx) ??
    window(root.seven_day_claude_routines, 10_080, ctx) ??
    window(root.routines, 10_080, ctx);
  const extra = object(root.extra_usage);
  const usedCredits = number(extra?.used_credits);
  const monthlyLimit = number(extra?.monthly_limit);
  const currencyCode = string(extra?.currency) ?? "USD";
  return {
    primary,
    ...(weekly ? { secondary: weekly } : {}),
    ...(scoped ? { tertiary: scoped } : {}),
    ...(routines
      ? { extraRateWindows: [{ id: "claude-routines", title: "Daily Routines", window: routines }] }
      : {}),
    ...(usedCredits !== undefined && monthlyLimit !== undefined
      ? {
          providerCost: {
            // The OAuth/Web APIs return minor units; upstream converts to major units.
            used: usedCredits / 100,
            limit: monthlyLimit / 100,
            currencyCode,
            period: "Monthly cap",
          },
        }
      : {}),
    identity: {
      providerId: "claude",
      ...(string(root.account_email) ? { accountEmail: string(root.account_email) } : {}),
      ...(string(root.account_org) ? { accountOrganization: string(root.account_org) } : {}),
      ...(string(root.login_method) ? { loginMethod: string(root.login_method) } : {}),
    },
  };
};

/** Parses the JSON emitted by the direct `/usage` CLI probe. */
export const parseClaudeCLIUsage = (text: string, ctx: ProviderContext) => {
  try {
    return parseClaudeUsage(JSON.parse(text) as unknown, ctx);
  } catch (error) {
    if (error instanceof SyntaxError)
      throw ctx.fail.parseFailure("Claude CLI output was not valid JSON.");
    throw error;
  }
};

const stripAnsi = (text: string): string => {
  const escape = String.fromCharCode(27);
  const bell = String.fromCharCode(7);
  const withoutAnsi = text
    .replace(new RegExp(`${escape}\\[[0-9;?]*[a-zA-Z]`, "gu"), "")
    .replace(new RegExp(`${escape}\\][^${bell}]*${bell}`, "gu"), "");
  return [...withoutAnsi]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
    })
    .join("");
};

const normalized = (text: string): string => text.toLowerCase().replace(/\s+/gu, "");

const isUsageSectionLabel = (line: string): boolean => {
  const value = line.trim().toLowerCase();
  return value.startsWith("current session") || value.startsWith("current week");
};

const isSubscriptionNoticeOnly = (text: string): boolean => {
  const n = normalized(text);
  if (!n.includes("currentlyusingyoursubscription")) return false;
  if (!n.includes("claudecodeusage")) return false;
  const hasQuota =
    n.includes("currentsession") ||
    n.includes("currentweek") ||
    n.includes("%used") ||
    n.includes("%left") ||
    n.includes("%remaining") ||
    n.includes("%available");
  return !hasQuota;
};

const extractPercentLeft = (lines: readonly string[], label: string): number | undefined => {
  const labelLower = label.toLowerCase();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (!line.toLowerCase().includes(labelLower)) continue;
    const end = Math.min(lines.length, i + 12);
    for (let index = i + 1; index < end; index += 1) {
      const candidate = lines[index] ?? "";
      const candidateLower = candidate.toLowerCase();
      if (isUsageSectionLabel(candidate)) break;
      const m = candidate.match(/([0-9]{1,3}(?:\.[0-9]+)?)\s*%/u);
      if (!m) continue;
      const raw = Number(m[1]);
      if (!Number.isFinite(raw)) continue;
      const clamped = Math.max(0, Math.min(100, raw));
      if (candidateLower.includes("used")) return Math.round(100 - clamped);
      if (
        candidateLower.includes("left") ||
        candidateLower.includes("remaining") ||
        candidateLower.includes("available")
      )
        return Math.round(clamped);
    }
  }
  return undefined;
};

const extractReset = (lines: readonly string[], label: string): string | undefined => {
  const labelLower = label.toLowerCase();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (!line.toLowerCase().includes(labelLower)) continue;
    const end = Math.min(lines.length, i + 14);
    for (let index = i + 1; index < end; index += 1) {
      const candidate = lines[index] ?? "";
      if (isUsageSectionLabel(candidate)) break;
      const m = candidate.match(/\bresets?\b[^\r\n]*/iu);
      if (!m) continue;
      const raw = m[0].trim();
      let cleaned = raw.replace(/([A-Za-z]{3}\s+\d{1,2})\s+t\s+(\d)/u, "$1 at $2").trim();
      // Keep balanced parentheses like Swift's cleanResetLine
      const open = (cleaned.match(/\(/gu) ?? []).length;
      const close = (cleaned.match(/\)/gu) ?? []).length;
      if (open > close) cleaned += ")";
      return cleaned;
    }
  }
  return undefined;
};

/**
 * Minimal exact-label Claude TUI parser ported from Swift ClaudeStatusProbe.parse.
 * Handles ANSI/control stripping; Current session and Current week (all models);
 * percent left -> used; resets where safely parseable; dataConfidence percentOnly.
 * Subscription/unavailable notices fail closed, never fabricate zero/percent/identity.
 */
export const parseClaudeCliUsagePanel = (text: string, ctx: ProviderContext) => {
  if (text.includes("\u0000")) throw ctx.fail.parseFailure("Claude CLI output contains NUL.");
  if (text.length > 1024 * 1024 || new TextEncoder().encode(text).byteLength > 1024 * 1024)
    throw ctx.fail.parseFailure("Claude CLI output exceeds 1 MiB.");
  const clean = stripAnsi(text);
  if (clean.trim() === "")
    throw ctx.fail.parseFailure("Claude CLI /usage is still loading usage data.");
  if (isSubscriptionNoticeOnly(clean)) {
    throw ctx.fail.providerUnavailable(
      "Claude CLI /usage returned a subscription notice without session quota data. Local cost and token history remain available.",
    );
  }
  if (normalized(clean).includes("failedtoloadusagedata")) {
    throw ctx.fail.parseFailure(
      "Claude CLI could not load usage data. Open the CLI and retry `/usage`.",
    );
  }

  // Trim to latest usage panel if Settings: ... Usage present, mirroring Swift
  let panelText = clean;
  const lowerClean = clean.toLowerCase();
  const settingsIdx = lowerClean.lastIndexOf("settings:");
  if (settingsIdx >= 0) {
    const tail = clean.slice(settingsIdx);
    if (tail.toLowerCase().includes("usage")) {
      const hasPercent = tail.includes("%");
      const hasUsageWords = /used|left|remaining|available/iu.test(tail);
      const hasLoading = tail.toLowerCase().includes("loading usage");
      if ((hasPercent && hasUsageWords) || hasLoading) panelText = tail;
    }
  }
  if (
    normalized(panelText).includes("loadingusage") &&
    !panelText.toLowerCase().includes("current session")
  ) {
    throw ctx.fail.parseFailure("Claude CLI /usage is still loading usage data.");
  }

  const lines = panelText.split(/\r?\n/u);
  const sessionLeft = extractPercentLeft(lines, "Current session");
  const weeklyLeft = extractPercentLeft(lines, "Current week (all models)");

  if (sessionLeft === undefined) {
    throw ctx.fail.parseFailure("Missing Current session.");
  }
  const sessionUsed = Math.max(0, Math.min(100, 100 - sessionLeft));
  const weeklyUsed =
    weeklyLeft === undefined ? undefined : Math.max(0, Math.min(100, 100 - weeklyLeft));

  const sessionReset = extractReset(lines, "Current session");
  const weeklyReset =
    weeklyLeft === undefined ? undefined : extractReset(lines, "Current week (all models)");

  const resetsAt = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    // Only safely parse ISO timestamps; other resets stay as resetDescription only.
    if (/^\d{4}-\d{2}-\d{2}T/u.test(value)) {
      try {
        return ctx.date.iso(value);
      } catch {
        return undefined;
      }
    }
    return undefined;
  };

  return {
    primary: {
      usedPercent: clampPercent(sessionUsed),
      windowMinutes: 300,
      ...(resetsAt(sessionReset) ? { resetsAt: resetsAt(sessionReset) } : {}),
      ...(sessionReset ? { resetDescription: sessionReset } : {}),
    },
    ...(weeklyUsed === undefined
      ? {}
      : {
          secondary: {
            usedPercent: clampPercent(weeklyUsed),
            windowMinutes: 10_080,
            ...(resetsAt(weeklyReset) ? { resetsAt: resetsAt(weeklyReset) } : {}),
            ...(weeklyReset ? { resetDescription: weeklyReset } : {}),
          },
        }),
    identity: { providerId: "claude" as const },
    dataConfidence: "percentOnly" as const,
  };
};

const oauthUsage = async (ctx: ProviderContext, token: string) => {
  const response = await ctx.http.getJSON("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "anthropic-beta": "oauth-2025-04-20",
      // Deliberately static: version discovery belongs to ProcessRunner.
      "User-Agent": "claude-code/2.1.0",
    },
  });
  status(ctx, "Claude OAuth", response);
  return parseClaudeUsage(response.json, ctx);
};

const webUsage = async (ctx: ProviderContext, cookie: string) => {
  const headers = {
    Cookie: cookie.includes("=") ? cookie : `sessionKey=${cookie}`,
    Accept: "application/json",
  };
  const organizations = await ctx.http.getJSON("https://claude.ai/api/organizations", { headers });
  status(ctx, "Claude web", organizations);
  const selected = (Array.isArray(organizations.json) ? organizations.json : [])
    .map(object)
    .find((organization) => Boolean(string(organization?.uuid)));
  const organizationID = string(selected?.uuid);
  if (!organizationID)
    throw ctx.fail.parseFailure("Claude web response is missing an organization.");
  const response = await ctx.http.getJSON(
    `https://claude.ai/api/organizations/${encodeURIComponent(organizationID)}/usage`,
    { headers },
  );
  status(ctx, "Claude web", response);
  const snapshot = parseClaudeUsage(response.json, ctx);
  return {
    ...snapshot,
    identity: {
      ...object(snapshot.identity),
      providerId: "claude",
      ...(string(selected?.name) ? { accountOrganization: string(selected?.name) } : {}),
      loginMethod: "Cookie",
    },
  };
};

const definition: ProviderDefinition = {
  id: "claude",
  name: "Claude",
  endpoints: ["https://api.anthropic.com", "https://claude.ai"],
  settings: [
    { key: "CLAUDE_OAUTH_ACCESS_TOKEN", title: "OAuth access token", type: "secure" },
    { key: "CLAUDE_COOKIE_HEADER", title: "Cookie header", type: "secure" },
    { key: "CLAUDE_CLI_USAGE_JSON", title: "CLI usage JSON", type: "secure" },
  ],
  capabilities: ["browser-cookies"],
  cookieDomains: ["claude.ai"],
  fetchUsage: async (ctx) => {
    // The TypeScript provider keeps the app-auto ordering. Runtime-specific
    // source planning belongs in core, where ProcessRunner availability is known.
    const token = ctx.settings.getSecret("CLAUDE_OAUTH_ACCESS_TOKEN")?.trim();
    if (token) return oauthUsage(ctx, token);
    const cliUsage = ctx.settings.getSecret("CLAUDE_CLI_USAGE_JSON")?.trim();
    if (cliUsage) return parseClaudeCLIUsage(cliUsage, ctx);
    const cookie =
      ctx.settings.getSecret("CLAUDE_COOKIE_HEADER")?.trim() ||
      (await ctx.browser.cookieHeader("claude.ai"));
    if (cookie) return webUsage(ctx, cookie);
    throw ctx.fail.missingCredential(
      "Claude needs an OAuth credential, an Electron-managed claude.ai session, or ProcessRunner CLI output.",
    );
  },
};

const claudeOAuthFallbackOn = [
  "missing-credential",
  "authentication-expired",
  "provider-unavailable",
  "parse-failure",
  "network-failure",
  "permission-denied",
  "api-failure",
] as const;

const oauthStrategy: ProviderStrategy = {
  id: "claude.oauth",
  kind: "oauth",
  fallbackOn: [...claudeOAuthFallbackOn],
  fetchUsage: async (ctx) => {
    const token = ctx.settings.getSecret("CLAUDE_OAUTH_ACCESS_TOKEN")?.trim();
    if (!token)
      throw ctx.fail.missingCredential(
        "Claude OAuth access token is not configured. Run `claude login`.",
      );
    return oauthUsage(ctx, token);
  },
};

const cliStrategy: ProviderStrategy = {
  id: "claude.cli",
  kind: "cli",
  fallbackOn: [...claudeOAuthFallbackOn],
  fetchUsage: async (ctx) => {
    // Prefer the named PTY capability when available; keep the JSON secret as a test seam.
    if (ctx.local?.fetchClaudeCliUsage !== undefined) {
      const result = await ctx.local.fetchClaudeCliUsage();
      if (!result.loggedIn)
        throw ctx.fail.missingCredential("Claude CLI is not logged in. Run `claude login`.");
      const parsed = parseClaudeCliUsagePanel(result.stdout, ctx);
      return parsed;
    }
    const cliUsage = ctx.settings.getSecret("CLAUDE_CLI_USAGE_JSON")?.trim();
    if (cliUsage) return parseClaudeCLIUsage(cliUsage, ctx);
    throw ctx.fail.missingCredential("Claude CLI usage is not available. Run `claude login`.");
  },
};

const webStrategy: ProviderStrategy = {
  id: "claude.web",
  kind: "web",
  fetchUsage: async (ctx) => {
    const cookie =
      ctx.settings.getSecret("CLAUDE_COOKIE_HEADER")?.trim() ||
      (await ctx.browser.cookieHeader("claude.ai"));
    if (!cookie) throw ctx.fail.missingCredential("Claude web session is not configured.");
    return webUsage(ctx, cookie);
  },
};

export const descriptor: ProviderDescriptor = {
  ...definition,
  status: "partial",
  isPrimaryProvider: true,
  strategies: [oauthStrategy, cliStrategy, webStrategy],
  strategy: oauthStrategy,
};
export const claude: FirstPartyProvider = {
  ...oauthStrategy,
  descriptor,
  strategies: [oauthStrategy, cliStrategy, webStrategy],
};
