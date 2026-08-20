import type { ProviderContext, ProviderSnapshot } from "../types.ts";

interface CodexWindow {
  readonly used_percent: number;
  readonly reset_at: number;
  readonly limit_window_seconds: number;
}

interface CodexUsagePayload {
  readonly credits?: {
    readonly has_credits?: unknown;
    readonly unlimited?: unknown;
    readonly balance?: unknown;
  };
  readonly rate_limit?: {
    readonly primary_window?: unknown;
    readonly secondary_window?: unknown;
  };
}

interface CodexPATWhoami {
  readonly chatgpt_account_id?: unknown;
  readonly chatgpt_plan_type?: unknown;
  readonly email?: unknown;
}

const usageURL = "https://chatgpt.com/backend-api/wham/usage";
const whoamiURL = "https://auth.openai.com/api/accounts/v1/user-auth-credential/whoami";

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

const optionalWhoamiString = (
  ctx: ProviderContext,
  value: unknown,
  field: string,
): string | undefined => {
  if (value !== undefined && value !== null && typeof value !== "string")
    throw ctx.fail.parseFailure(`Codex PAT whoami ${field} must be a string`);
  return optionalString(value);
};

const optionalNumber = (value: unknown): number | undefined => {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.trim())
        : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};

const parseWindow = (ctx: ProviderContext, value: unknown, field: string) => {
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
};

const headersFor = (ctx: ProviderContext, token: string): Readonly<Record<string, string>> => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/json",
  // Host-supplied CLI metadata is a plain setting; providers never inspect
  // the platform or invoke the Codex CLI themselves.
  "User-Agent": optionalString(ctx.settings.get("CODEX_CLI_USER_AGENT")) ?? "codex_cli_rs",
  originator: "codex_cli_rs",
});

const throwForResponse = (ctx: ProviderContext, status: number, operation: string): void => {
  if (status === 401 || status === 403)
    throw ctx.fail.authenticationExpired("Codex personal access token is expired or invalid.");
  if (status < 200 || status >= 300)
    throw ctx.fail.apiFailure(`Codex ${operation} API error: HTTP ${status}`);
};

const usagePayload = (ctx: ProviderContext, value: unknown): CodexUsagePayload => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw ctx.fail.parseFailure("Invalid response from Codex usage API");
  return value as CodexUsagePayload;
};

/**
 * Fetch a PAT's identity before usage. The account header is intentionally
 * derived only from whoami, never from an OAuth/managed-workspace setting.
 */
export const fetchCodexPATUsage = async (
  ctx: ProviderContext,
  token: string,
): Promise<ProviderSnapshot> => {
  const whoami = await ctx.http.getJSON(whoamiURL, { headers: headersFor(ctx, token) });
  throwForResponse(ctx, whoami.status, "whoami");
  if (typeof whoami.json !== "object" || whoami.json === null || Array.isArray(whoami.json))
    throw ctx.fail.parseFailure("Invalid response from Codex PAT whoami API");
  const identity = whoami.json as CodexPATWhoami;
  const accountId = optionalWhoamiString(ctx, identity.chatgpt_account_id, "chatgpt_account_id");
  const email = optionalWhoamiString(ctx, identity.email, "email");
  const planType = optionalWhoamiString(ctx, identity.chatgpt_plan_type, "chatgpt_plan_type");
  const usage = await ctx.http.getJSON(usageURL, {
    headers: {
      ...headersFor(ctx, token),
      ...(accountId === undefined ? {} : { "ChatGPT-Account-Id": accountId }),
    },
  });
  throwForResponse(ctx, usage.status, "usage");
  const payload = usagePayload(ctx, usage.json);
  const primary = parseWindow(ctx, payload.rate_limit?.primary_window, "primary_window");
  const secondary = parseWindow(ctx, payload.rate_limit?.secondary_window, "secondary_window");
  const balance = optionalNumber(payload.credits?.balance);
  return {
    ...(primary === undefined ? {} : { primary }),
    ...(secondary === undefined ? {} : { secondary }),
    identity: {
      providerId: "codex",
      ...(accountId === undefined ? {} : { accountId }),
      ...(email === undefined ? {} : { email }),
      ...(planType === undefined ? {} : { loginMethod: planType }),
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

export const isCodexPATAuthenticationFailure = (error: unknown): boolean =>
  error instanceof Error && error.message.startsWith("authentication-expired:");
