import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { fetchCodexPATUsage, isCodexPATAuthenticationFailure } from "./codex-pat.ts";
import {
  evaluateCodexDashboardAuthority,
  makeLiveCodexDashboardInput,
  normalizeCodexAccountId,
  normalizeCodexEmail,
  resolveCodexIdentity,
} from "./codex-dashboard-authority.ts";

const usageEndpoint = "https://chatgpt.com/backend-api/wham/usage";
const webIdentityEndpoints = [
  "https://chatgpt.com/backend-api/me",
  "https://chatgpt.com/api/auth/session",
] as const;

interface CodexWindow {
  readonly used_percent: number;
  readonly reset_at: number;
  readonly limit_window_seconds: number;
}

interface CodexUsagePayload {
  readonly account_id?: unknown;
  readonly accountId?: unknown;
  readonly plan_type?: unknown;
  readonly rate_limit?: {
    readonly primary_window?: unknown;
    readonly secondary_window?: unknown;
  };
  readonly credits?: {
    readonly has_credits?: unknown;
    readonly unlimited?: unknown;
    readonly balance?: unknown;
  };
}

function parseWindow(ctx: ProviderContext, value: unknown, field: string) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value))
    throw ctx.fail.parseFailure(`Codex ${field} must be an object`);
  const candidate = value as Partial<CodexWindow>;
  if (
    typeof candidate.used_percent !== "number" ||
    !Number.isFinite(candidate.used_percent) ||
    typeof candidate.reset_at !== "number" ||
    !Number.isFinite(candidate.reset_at) ||
    typeof candidate.limit_window_seconds !== "number" ||
    !Number.isFinite(candidate.limit_window_seconds)
  )
    throw ctx.fail.parseFailure(`Codex ${field} is malformed`);
  return {
    usedPercent: Math.max(0, Math.min(100, candidate.used_percent)),
    windowMinutes: Math.max(0, candidate.limit_window_seconds / 60),
    resetsAt: ctx.date.unixSeconds(candidate.reset_at),
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.trim())
        : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

const parseJSONBody = (ctx: ProviderContext, bodyText: string, message: string): unknown => {
  try {
    return JSON.parse(bodyText) as unknown;
  } catch {
    throw ctx.fail.parseFailure(message);
  }
};

const definition: ProviderDefinition = {
  id: "codex",
  name: "Codex",
  endpoints: ["https://chatgpt.com", "https://auth.openai.com"],
  capabilities: ["browser-cookies"],
  cookieDomains: ["chatgpt.com"],
  settings: [
    { key: "CODEX_ACCESS_TOKEN", title: "Codex OAuth access token", type: "secure" },
    {
      key: "CODEX_PERSONAL_ACCESS_TOKEN",
      title: "Codex personal access token",
      type: "secure",
    },
    { key: "CODEX_ACCOUNT_ID", title: "ChatGPT account ID", type: "plain" },
    { key: "CODEX_CLI_USER_AGENT", title: "Codex CLI user agent", type: "plain" },
  ],
  fetchUsage: async (ctx: ProviderContext) => {
    const pat = optionalString(ctx.settings.getSecret("CODEX_PERSONAL_ACCESS_TOKEN"));
    const oauth = optionalString(ctx.settings.getSecret("CODEX_ACCESS_TOKEN"));
    if (ctx.sourceMode !== "oauth" && pat !== undefined) {
      try {
        return await fetchCodexPATUsage(ctx, pat);
      } catch (error) {
        // Upstream only falls through from an unusable PAT in Auto mode. A
        // malformed/server response remains terminal so it cannot hide data
        // corruption or an API outage behind a different credential.
        if (
          ctx.sourceMode === "auto" &&
          oauth !== undefined &&
          isCodexPATAuthenticationFailure(error)
        ) {
          return fetchOAuthUsage(ctx, oauth);
        }
        throw error;
      }
    }
    if (ctx.sourceMode === "api") {
      throw ctx.fail.missingCredential(
        "Missing Codex personal access token. Run `codex login` to re-authenticate.",
      );
    }
    if (oauth === undefined) {
      throw ctx.fail.missingCredential(
        "Missing Codex personal access token or OAuth access token. Run `codex login` to re-authenticate.",
      );
    }
    return fetchOAuthUsage(ctx, oauth);
  },
};

const fetchOAuthUsage = async (ctx: ProviderContext, accessToken: string) => {
  const accountId = ctx.settings.get("CODEX_ACCOUNT_ID");
  const response = await ctx.http.get(usageEndpoint, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "User-Agent": "CodexBar Multi",
      ...(accountId === undefined ? {} : { "ChatGPT-Account-Id": accountId }),
    },
  });
  if (response.status === 401 || response.status === 403) {
    throw ctx.fail.authenticationExpired(
      "Codex OAuth token expired or invalid. Run `codex login` to re-authenticate.",
    );
  }
  if (response.status === 429)
    throw ctx.fail.rateLimited("Codex usage API rate limited the request");
  if (response.status < 200 || response.status >= 300) {
    throw ctx.fail.apiFailure(`Codex usage API error: HTTP ${response.status}`);
  }
  const json = parseJSONBody(ctx, response.bodyText, "Invalid response from Codex usage API");
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw ctx.fail.parseFailure("Invalid response from Codex usage API");
  }
  const payload = json as CodexUsagePayload;
  const resolvedAccountId =
    optionalString(payload.account_id) ?? optionalString(payload.accountId) ?? accountId;
  return mapCodexUsagePayload(
    ctx,
    payload,
    resolvedAccountId === undefined ? {} : { accountId: resolvedAccountId },
  );
};

const mapCodexUsagePayload = (
  ctx: ProviderContext,
  payload: CodexUsagePayload,
  identity: { readonly accountId?: string; readonly accountEmail?: string },
) => {
  const primary = parseWindow(ctx, payload.rate_limit?.primary_window, "primary_window");
  const secondary = parseWindow(ctx, payload.rate_limit?.secondary_window, "secondary_window");
  const balance = optionalNumber(payload.credits?.balance);
  return {
    ...(primary === undefined ? {} : { primary }),
    ...(secondary === undefined ? {} : { secondary }),
    identity: {
      providerId: "codex",
      ...(identity.accountId === undefined ? {} : { accountId: identity.accountId }),
      ...(identity.accountEmail === undefined ? {} : { accountEmail: identity.accountEmail }),
      loginMethod: optionalString(payload.plan_type),
    },
    ...(payload.credits === undefined
      ? {}
      : {
          credits: {
            hasCredits: payload.credits.has_credits === true,
            unlimited: payload.credits.unlimited === true,
            ...(balance === undefined ? {} : { balance }),
          },
        }),
    details: [],
    updatedAt: ctx.date.now().toISOString(),
    dataConfidence: primary === undefined && secondary === undefined ? "unknown" : "exact",
  };
};

const responseFailure = (ctx: ProviderContext, status: number, operation: string): Error => {
  if (status === 401 || status === 403) {
    return ctx.fail.authenticationExpired(
      "Codex web session expired or invalid. Sign in again from CodexBar Multi.",
    );
  }
  if (status === 429) return ctx.fail.rateLimited(`Codex ${operation} rate limited the request`);
  if (status >= 500)
    return ctx.fail.providerUnavailable(`Codex ${operation} is unavailable: HTTP ${status}`);
  return ctx.fail.apiFailure(`Codex ${operation} error: HTTP ${status}`);
};

const collectIdentityEmails = (root: unknown): readonly string[] => {
  if (typeof root !== "object" || root === null) return [];
  const queue: unknown[] = [root];
  const seen = new Set<object>();
  const emails = new Set<string>();
  let visited = 0;
  while (queue.length > 0 && visited < 2_000) {
    const value = queue.shift();
    if (typeof value !== "object" || value === null || seen.has(value)) continue;
    seen.add(value);
    visited += 1;
    for (const [key, child] of Object.entries(value)) {
      if (
        typeof child === "string" &&
        (key.toLowerCase() === "email" || key.toLowerCase().endsWith("_email"))
      ) {
        const email = normalizeCodexEmail(child);
        if (email?.includes("@")) emails.add(email);
      } else if (typeof child === "object" && child !== null) {
        queue.push(child);
      }
    }
  }
  return [...emails];
};

const fetchWebIdentityEmail = async (
  ctx: ProviderContext,
  cookie: string,
  accountId: string | undefined,
): Promise<string> => {
  let lastFailure: Error | undefined;
  for (const endpoint of webIdentityEndpoints) {
    const response = await ctx.http.get(endpoint, {
      headers: {
        Cookie: cookie,
        Accept: "application/json",
        "User-Agent": "CodexBar Multi",
        ...(accountId === undefined ? {} : { "ChatGPT-Account-Id": accountId }),
      },
    });
    if (response.status < 200 || response.status >= 300) {
      lastFailure = responseFailure(ctx, response.status, "identity API");
      continue;
    }
    const json = parseJSONBody(
      ctx,
      response.bodyText,
      "Codex web identity response was not valid JSON.",
    );
    const emails = collectIdentityEmails(json);
    if (emails.length === 1) return emails[0]!;
    if (emails.length > 1) {
      throw ctx.fail.permissionDenied(
        "Codex web identity response contains multiple account emails.",
      );
    }
  }
  if (lastFailure !== undefined) throw lastFailure;
  throw ctx.fail.parseFailure("Codex web identity response did not include a signed-in email.");
};

const fetchWebUsage = async (ctx: ProviderContext) => {
  const selected = ctx.selectedAccount;
  const expectedEmail = normalizeCodexEmail(selected?.accountEmail);
  if (selected === undefined || expectedEmail === undefined) {
    throw ctx.fail.missingCredential(
      "Codex web usage requires a selected account with an auth-backed email.",
    );
  }
  const expectedAccountId = normalizeCodexAccountId(ctx.settings.get("CODEX_ACCOUNT_ID"));
  if (expectedAccountId === undefined) {
    throw ctx.fail.missingCredential(
      "Codex web usage requires the selected account's auth-backed account ID.",
    );
  }
  const cookie = (await ctx.browser.cookieHeader("chatgpt.com")).trim();
  if (cookie === "") {
    throw ctx.fail.missingCredential("Missing selected Codex browser session.");
  }
  const signedInEmail = await fetchWebIdentityEmail(ctx, cookie, expectedAccountId);
  const identity = resolveCodexIdentity(expectedAccountId, expectedEmail);
  const authority = evaluateCodexDashboardAuthority(
    makeLiveCodexDashboardInput({
      currentIdentity: identity,
      expectedScopedEmail: expectedEmail,
      dashboardSignedInEmail: signedInEmail,
      knownOwners: [{ identity, normalizedEmail: expectedEmail }],
      routingTargetEmail: expectedEmail,
    }),
  );
  if (authority.disposition !== "attach") {
    throw ctx.fail.permissionDenied(
      `Codex web dashboard ownership rejected (${authority.reason.kind}).`,
    );
  }
  const response = await ctx.http.get(usageEndpoint, {
    headers: {
      Cookie: cookie,
      Accept: "application/json",
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent": "CodexBar Multi",
      "ChatGPT-Account-Id": expectedAccountId,
    },
  });
  if (response.status < 200 || response.status >= 300) {
    throw responseFailure(ctx, response.status, "usage API");
  }
  const json = parseJSONBody(ctx, response.bodyText, "Invalid response from Codex web usage API");
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw ctx.fail.parseFailure("Invalid response from Codex web usage API");
  }
  const payload = json as CodexUsagePayload;
  const rawPayloadAccountId = payload.account_id ?? payload.accountId;
  if (typeof rawPayloadAccountId !== "string" || rawPayloadAccountId.trim() === "") {
    throw ctx.fail.parseFailure("Codex web usage account ID is malformed.");
  }
  const payloadAccountId = optionalString(rawPayloadAccountId);
  if (payloadAccountId !== expectedAccountId) {
    throw ctx.fail.permissionDenied("Codex web usage belongs to a different account.");
  }
  return mapCodexUsagePayload(ctx, payload, {
    accountId: expectedAccountId,
    accountEmail: expectedEmail,
  });
};

const oauthStrategy: ProviderStrategy = {
  id: "codex.oauth",
  kind: "oauth",
  autoRequiresAnySecret: ["CODEX_ACCESS_TOKEN"],
  fetchUsage: async (ctx) => {
    const token = optionalString(ctx.settings.getSecret("CODEX_ACCESS_TOKEN"));
    if (token === undefined) {
      throw ctx.fail.missingCredential(
        "Missing Codex OAuth access token. Run `codex login` to re-authenticate.",
      );
    }
    return fetchOAuthUsage(ctx, token);
  },
};

const webStrategy: ProviderStrategy = {
  id: "codex.web.dashboard",
  kind: "web",
  explicitOnly: true,
  fetchUsage: fetchWebUsage,
};

const strategies = [
  { id: definition.id, kind: "api" as const, fetchUsage: definition.fetchUsage },
  oauthStrategy,
  webStrategy,
] as const;

export const descriptor: ProviderDescriptor = {
  ...definition,
  status: "partial",
  strategies,
  strategy: strategies[0],
};
export const codex: FirstPartyProvider = { ...definition, descriptor, kind: "api", strategies };
