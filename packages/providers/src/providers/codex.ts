import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
} from "../types.ts";

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

const definition: ProviderDefinition = {
  id: "codex",
  name: "Codex",
  endpoints: ["https://chatgpt.com"],
  auth: { type: "bearer", secret: "CODEX_ACCESS_TOKEN" },
  settings: [
    { key: "CODEX_ACCESS_TOKEN", title: "Codex OAuth access token", type: "secure" },
    { key: "CODEX_ACCOUNT_ID", title: "ChatGPT account ID", type: "plain" },
  ],
  fetchUsage: async (ctx: ProviderContext) => {
    const accountId = ctx.settings.get("CODEX_ACCOUNT_ID");
    const response = await ctx.http.getJSON("https://chatgpt.com/backend-api/wham/usage", {
      headers: {
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
    if (
      typeof response.json !== "object" ||
      response.json === null ||
      Array.isArray(response.json)
    ) {
      throw ctx.fail.parseFailure("Invalid response from Codex usage API");
    }
    const payload = response.json as CodexUsagePayload;
    const primary = parseWindow(ctx, payload.rate_limit?.primary_window, "primary_window");
    const secondary = parseWindow(ctx, payload.rate_limit?.secondary_window, "secondary_window");
    const balance = optionalNumber(payload.credits?.balance);
    return {
      ...(primary === undefined ? {} : { primary }),
      ...(secondary === undefined ? {} : { secondary }),
      identity: {
        providerId: "codex",
        accountId:
          optionalString(payload.account_id) ?? optionalString(payload.accountId) ?? accountId,
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
  },
};

export const descriptor: ProviderDescriptor = { ...definition, status: "partial" };
export const codex: FirstPartyProvider = { ...definition, descriptor, kind: "api" };
