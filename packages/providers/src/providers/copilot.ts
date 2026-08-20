import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { number, object, status, string } from "./_http.ts";

/**
 * The Copilot internal endpoint deliberately accepts the GitHub OAuth token,
 * rather than a short-lived Copilot token. This mirrors CopilotUsageFetcher.
 */
const apiHost = (enterpriseHost: string | undefined): string => {
  const host = enterpriseHost?.trim().toLowerCase() || "github.com";
  if (host === "github.com") return "api.github.com";
  return host.startsWith("api.") ? host : `api.${host}`;
};

type Quota = {
  readonly entitlement: number;
  readonly remaining: number;
  readonly creditsUsed?: number;
  readonly percentRemaining?: number;
  readonly unlimited: boolean;
  readonly decodedEntitlement: boolean;
  readonly decodedRemaining: boolean;
};

const quota = (value: unknown): Quota | undefined => {
  const root = object(value);
  if (!root) return undefined;
  const entitlement = number(root.entitlement) ?? 0;
  const remaining = number(root.remaining) ?? 0;
  const percentRemaining = number(root.percent_remaining);
  const creditsUsed = number(root.credits_used);
  return {
    entitlement,
    remaining,
    ...(creditsUsed === undefined ? {} : { creditsUsed }),
    ...(percentRemaining === undefined ? {} : { percentRemaining }),
    unlimited: root.unlimited === true,
    decodedEntitlement: root.entitlement !== undefined,
    decodedRemaining: root.remaining !== undefined,
  };
};

const placeholder = (value: Quota): boolean =>
  !value.unlimited &&
  ((value.entitlement === 0 && value.remaining === 0 && value.percentRemaining === undefined) ||
    (value.decodedEntitlement &&
      value.decodedRemaining &&
      value.entitlement === 0 &&
      value.remaining === 0));

const windowFor = (
  ctx: ProviderContext,
  value: Quota | undefined,
  resetsAt: string | undefined,
) => {
  if (!value || value.unlimited || placeholder(value) || value.percentRemaining === undefined)
    return undefined;
  const usedPercent = Math.max(0, 100 - value.percentRemaining);
  return {
    usedPercent,
    ...(resetsAt ? { resetsAt } : {}),
    ...(usedPercent > 100 ? { resetDescription: `${Math.round(usedPercent)}% used` } : {}),
  };
};

const reset = (ctx: ProviderContext, value: unknown): string | undefined => {
  const raw = string(value);
  if (!raw) return undefined;
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? ctx.date.iso(raw) : undefined;
};

const definition: ProviderDefinition = {
  id: "copilot",
  name: "Copilot",
  endpoints: [{ setting: "COPILOT_ENTERPRISE_HOST", policy: "https" }],
  auth: { type: "authorization-scheme", secret: "COPILOT_API_TOKEN", scheme: "token" },
  settings: [
    { key: "COPILOT_API_TOKEN", title: "GitHub OAuth token", type: "secure" },
    { key: "COPILOT_ENTERPRISE_HOST", title: "Enterprise host", type: "plain" },
  ],
  fetchUsage: async (ctx: ProviderContext) => {
    const token = ctx.settings.getSecret("COPILOT_API_TOKEN")?.trim();
    if (!token) throw ctx.fail.missingCredential("GitHub OAuth token is not configured.");
    const host = apiHost(ctx.settings.get("COPILOT_ENTERPRISE_HOST"));
    const response = await ctx.http.getJSON(`https://${host}/copilot_internal/user`, {
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/json",
        "Editor-Version": "vscode/1.96.2",
        "Editor-Plugin-Version": "copilot-chat/0.26.7",
        "User-Agent": "GitHubCopilotChat/0.26.7",
        "X-Github-Api-Version": "2025-04-01",
      },
    });
    status(ctx, "Copilot", response);
    const root = object(response.json);
    if (!root) throw ctx.fail.parseFailure("Copilot usage response must be an object.");
    const snapshots = object(root.quota_snapshots);
    const premium = quota(snapshots?.premium_interactions);
    const chat = quota(snapshots?.chat);
    const resetsAt = reset(ctx, root.quota_reset_date);
    const premiumWindow = windowFor(ctx, premium, resetsAt);
    const chatWindow = windowFor(ctx, chat, resetsAt);
    const tokenBasedBilling = root.token_based_billing === true;
    const unlimited = premium?.unlimited === true || chat?.unlimited === true;
    if (!premiumWindow && !chatWindow && !tokenBasedBilling && !unlimited) {
      throw ctx.fail.parseFailure("Copilot response has no metered quota window.");
    }
    const creditsUsed = premium?.creditsUsed ?? chat?.creditsUsed;
    return {
      ...(premiumWindow ? { primary: premiumWindow } : {}),
      ...(chatWindow ? { secondary: chatWindow } : {}),
      ...(creditsUsed === undefined
        ? {}
        : {
            details: [
              {
                title: "Credits",
                rows: [
                  {
                    label: "Credits used",
                    value: ctx.format.number(creditsUsed),
                    ...(resetsAt ? { secondaryValue: "Quota reset" } : {}),
                  },
                ],
              },
            ],
          }),
      identity: { loginMethod: string(root.copilot_plan) ?? "Unknown" },
    };
  },
};

const strategy: ProviderStrategy = {
  id: "copilot.api",
  kind: "api",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const copilot: FirstPartyProvider = { ...strategy, descriptor };
