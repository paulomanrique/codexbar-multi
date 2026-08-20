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
const strategy: ProviderStrategy = {
  id: "claude.oauth",
  kind: "api",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = {
  ...definition,
  status: "partial",
  isPrimaryProvider: true,
  strategy,
};
export const claude: FirstPartyProvider = { ...strategy, descriptor };
