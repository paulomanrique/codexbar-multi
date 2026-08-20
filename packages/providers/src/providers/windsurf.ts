import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { number, object, status, string } from "./_http.ts";

type Session = {
  readonly sessionToken: string;
  readonly auth1Token: string;
  readonly accountID: string;
  readonly primaryOrgID: string;
};
const clean = (value: string | undefined) => value?.trim() || undefined;
const read = (record: Record<string, unknown>, keys: readonly string[]) => {
  for (const key of keys) {
    const value = string(record[key]);
    if (value) return value;
  }
  return undefined;
};
const session = (ctx: ProviderContext, raw: string): Session => {
  let values: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(raw);
    const parsedObject = object(parsed);
    if (parsedObject) values = parsedObject;
  } catch {
    for (const part of raw.split(/[\n,;]/u)) {
      const [key, ...rest] = part.split(/[=:]/u);
      if (key && rest.length)
        values[key.trim()] = rest
          .join("=")
          .trim()
          .replace(/^["']|["']$/gu, "");
    }
  }
  const sessionToken = read(values, ["devin_session_token", "devinSessionToken", "sessionToken"]);
  const auth1Token = read(values, ["devin_auth1_token", "devinAuth1Token", "auth1Token"]);
  const accountID = read(values, ["devin_account_id", "devinAccountId", "accountID", "accountId"]);
  const primaryOrgID = read(values, [
    "devin_primary_org_id",
    "devinPrimaryOrgId",
    "primaryOrgID",
    "primaryOrgId",
  ]);
  if (!sessionToken || !auth1Token || !accountID || !primaryOrgID)
    throw ctx.fail.missingCredential(
      "Windsurf session needs devin_session_token, devin_auth1_token, devin_account_id, and devin_primary_org_id.",
    );
  return { sessionToken, auth1Token, accountID, primaryOrgID };
};
const resetDescription = (ctx: ProviderContext, value: unknown) => {
  const seconds = number(value);
  if (seconds === undefined) return undefined;
  const remainder =
    seconds > 10_000_000_000
      ? seconds - ctx.date.nowMillis()
      : seconds * 1_000 - ctx.date.nowMillis();
  if (remainder <= 0) return "Expired";
  const hours = Math.floor(remainder / 3_600_000);
  const minutes = Math.floor((remainder % 3_600_000) / 60_000);
  return hours >= 24
    ? `Resets in ${Math.floor(hours / 24)}d ${hours % 24}h`
    : hours > 0
      ? `Resets in ${hours}h ${minutes}m`
      : `Resets in ${minutes}m`;
};
const date = (ctx: ProviderContext, value: unknown) => {
  const parsed = number(value);
  return parsed === undefined
    ? undefined
    : parsed > 10_000_000_000
      ? ctx.date.unixMillis(parsed)
      : ctx.date.unixSeconds(parsed);
};
const planStatus = (root: Record<string, unknown>) =>
  object(root.planStatus) ?? object(root.plan_status) ?? root;
const definition: ProviderDefinition = {
  id: "windsurf",
  name: "Windsurf",
  endpoints: ["https://windsurf.com"],
  settings: [{ key: "WINDSURF_SESSION", title: "Session bundle", type: "secure" }],
  capabilities: ["browser-cookies"],
  cookieDomains: ["windsurf.com", "app.devin.ai"],
  fetchUsage: async (ctx) => {
    // IndexedDB/localStorage extraction belongs to BrowserSessionBroker. The domain consumes only an approved bundle.
    const raw =
      clean(ctx.settings.getSecret("WINDSURF_SESSION")) ??
      clean(ctx.settings.get("WINDSURF_SESSION")) ??
      clean(await ctx.browser.cookieHeader("windsurf.com"));
    if (!raw) throw ctx.fail.missingCredential("Windsurf session bundle is not configured.");
    const auth = session(ctx, raw);
    const response = await ctx.http.postJSON(
      "https://windsurf.com/_backend/exa.seat_management_pb.SeatManagementService/GetPlanStatus",
      {
        // The Electron adapter is responsible for the upstream protobuf envelope; JSON keeps this explicit contract testable.
        body: { authToken: auth.sessionToken, includeTopUpStatus: true },
        headers: {
          "Content-Type": "application/proto",
          "Connect-Protocol-Version": "1",
          Origin: "https://windsurf.com",
          Referer: "https://windsurf.com/profile",
          "x-auth-token": auth.sessionToken,
          "x-devin-session-token": auth.sessionToken,
          "x-devin-auth1-token": auth.auth1Token,
          "x-devin-account-id": auth.accountID,
          "x-devin-primary-org-id": auth.primaryOrgID,
        },
      },
    );
    status(ctx, "Windsurf", response);
    const root = object(response.json);
    if (!root) throw ctx.fail.parseFailure("Windsurf plan response must be an object.");
    const plan = planStatus(root);
    const planInfo = object(plan.planInfo) ?? object(plan.plan_info);
    const daily = number(plan.dailyQuotaRemainingPercent ?? plan.daily_quota_remaining_percent);
    const weekly = number(plan.weeklyQuotaRemainingPercent ?? plan.weekly_quota_remaining_percent);
    if (daily === undefined && weekly === undefined)
      throw ctx.fail.parseFailure("Windsurf plan response has no quota windows.");
    const dailyReset = plan.dailyQuotaResetAtUnix ?? plan.daily_quota_reset_at_unix;
    const weeklyReset = plan.weeklyQuotaResetAtUnix ?? plan.weekly_quota_reset_at_unix;
    const end = date(ctx, plan.planEnd ?? plan.plan_end);
    return {
      ...(daily === undefined
        ? {}
        : {
            primary: {
              usedPercent: Math.max(0, Math.min(100, 100 - daily)),
              ...(date(ctx, dailyReset) ? { resetsAt: date(ctx, dailyReset) } : {}),
              ...(resetDescription(ctx, dailyReset)
                ? { resetDescription: resetDescription(ctx, dailyReset) }
                : {}),
            },
          }),
      ...(weekly === undefined
        ? {}
        : {
            secondary: {
              usedPercent: Math.max(0, Math.min(100, 100 - weekly)),
              ...(date(ctx, weeklyReset) ? { resetsAt: date(ctx, weeklyReset) } : {}),
              ...(resetDescription(ctx, weeklyReset)
                ? { resetDescription: resetDescription(ctx, weeklyReset) }
                : {}),
            },
          }),
      identity: {
        ...(string(planInfo?.planName) ? { loginMethod: string(planInfo?.planName) } : {}),
        ...(end ? { accountOrganization: `Expires ${ctx.format.monthDay(new Date(end))}` } : {}),
      },
    };
  },
};
const strategy: ProviderStrategy = {
  id: "windsurf.web",
  kind: "web",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const windsurf: FirstPartyProvider = { ...strategy, descriptor };
