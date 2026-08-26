import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { number, object, string } from "./_http.ts";

const clean = (value: string | undefined): string | undefined =>
  value
    ?.trim()
    .replace(/^['"]|['"]$/gu, "")
    .trim() || undefined;
export const normalizeStepFunToken = (raw: string | undefined): string | undefined => {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  const marker = "Oasis-Token=";
  const markerIndex = trimmed.indexOf(marker);
  if (markerIndex < 0) return trimmed;
  return (
    trimmed
      .slice(markerIndex + marker.length)
      .split(";", 1)[0]
      ?.trim() || undefined
  );
};
const deviceID = (token: string): string | undefined => {
  for (const part of token.split("...").reverse()) {
    const payload = part.split(".")[1];
    if (!payload) continue;
    try {
      const base64 = payload
        .replace(/-/gu, "+")
        .replace(/_/gu, "/")
        .padEnd(Math.ceil(payload.length / 4) * 4, "=");
      const value = object(JSON.parse(atob(base64)) as unknown);
      const id = string(value?.device_id);
      if (id) return id;
    } catch {
      /* next half */
    }
  }
  return undefined;
};
const at = (ctx: ProviderContext, raw: unknown): string | undefined => {
  const value = number(raw);
  return value && value > 0
    ? ctx.date.unixSeconds(value > 10_000_000_000 ? value / 1000 : value)
    : undefined;
};
const definition: ProviderDefinition = {
  id: "stepfun",
  name: "StepFun",
  endpoints: ["https://platform.stepfun.com"],
  settings: [{ key: "STEPFUN_TOKEN", title: "Oasis token", type: "secure" }],
  capabilities: ["browser-cookies"],
  cookieDomains: ["platform.stepfun.com"],
  fetchUsage: async (ctx) => {
    const token = normalizeStepFunToken(
      clean(
        ctx.settings.getSecret("STEPFUN_TOKEN") ??
          ctx.settings.get("STEPFUN_TOKEN") ??
          ctx.settings.getSecret("STEPFUN_MANUAL_TOKEN") ??
          ctx.settings.get("STEPFUN_MANUAL_TOKEN"),
      ),
    );
    if (!token) throw ctx.fail.missingCredential("Missing StepFun authentication token.");
    const webid = deviceID(token) ?? "c8a1002d2c457e758785a9979832217c7c0b884c";
    const headers = {
      "content-type": "application/json",
      "oasis-appid": "10300",
      "oasis-platform": "web",
      "oasis-webid": webid,
      "Oasis-Token": token,
      Cookie: `Oasis-Token=${token}; Oasis-Webid=${webid}`,
    };
    const result = await ctx.http.postJSON(
      "https://platform.stepfun.com/api/step.openapi.devcenter.Dashboard/QueryStepPlanRateLimit",
      { body: {}, headers },
    );
    if (result.status === 401 || result.status === 403)
      throw ctx.fail.authenticationExpired("StepFun token is invalid or expired.");
    if (result.status !== 200)
      throw ctx.fail.apiFailure(`StepFun API returned HTTP ${result.status}.`);
    const root = object(result.json);
    if (!root || !(root.status === 1 || root.status === "1" || root.success === true))
      throw ctx.fail.apiFailure(
        `StepFun API error: ${string(root?.message) ?? string(root?.desc) ?? "unknown"}.`,
      );
    let plan: string | undefined;
    try {
      const status = await ctx.http.postJSON(
        "https://platform.stepfun.com/api/step.openapi.devcenter.Dashboard/GetStepPlanStatus",
        { body: {}, headers, timeoutSeconds: ctx.__codexbarOptionalRequestTimeoutSeconds ?? 4 },
      );
      if (status.status === 200) plan = string(object(object(status.json)?.subscription)?.name);
    } catch {
      /* optional */
    }
    const credit = object(root.plan_credit_rate_limit);
    const buckets = Array.isArray(credit?.credit_buckets) ? credit.credit_buckets.map(object) : [];
    const balances = buckets.map((bucket) => ({
      total: number(bucket?.credit_total),
      residual: number(bucket?.credit_residual),
    }));
    const bucketRate =
      balances.length > 0 &&
      balances.every(
        ({ total, residual }) =>
          total !== undefined &&
          residual !== undefined &&
          Number.isFinite(total) &&
          Number.isFinite(residual) &&
          total > 0 &&
          residual >= 0 &&
          residual <= total,
      )
        ? balances.reduce((sum, entry) => sum + (entry.residual as number), 0) /
          balances.reduce((sum, entry) => sum + (entry.total as number), 0)
        : undefined;
    const creditRate =
      bucketRate ??
      number(credit?.subscription_credit_left_rate) ??
      number(credit?.topup_credit_left_rate);
    const creditReset = at(ctx, credit?.subscription_credit_reset_time);
    const fiveLeft = number(root.five_hour_usage_left_rate);
    const weeklyLeft = number(root.weekly_usage_left_rate);
    const fiveReset = at(ctx, root.five_hour_usage_reset_time);
    const weeklyReset = at(ctx, root.weekly_usage_reset_time);
    const hasLiveWindow = fiveReset !== undefined || weeklyReset !== undefined;
    const hasCreditPool =
      creditRate !== undefined ||
      number(credit?.subscription_credit_left_rate) !== undefined ||
      number(credit?.topup_credit_left_rate) !== undefined ||
      buckets.length > 0;
    const creditPlan =
      !hasLiveWindow && (hasCreditPool || (number(root.plan_family) === 2 && credit !== undefined));
    if (creditPlan && creditRate !== undefined)
      return {
        primary: {
          usedPercent: Math.max(0, Math.min(100, (1 - creditRate) * 100)),
          windowMinutes: creditReset ? 43200 : undefined,
          ...(creditReset ? { resetsAt: creditReset } : {}),
        },
        identity: { loginMethod: plan ?? "password" },
      };
    if (fiveLeft === undefined || weeklyLeft === undefined || !fiveReset || !weeklyReset)
      throw ctx.fail.parseFailure("Missing StepFun usage rate or reset time fields.");
    return {
      primary: {
        usedPercent: Math.max(0, Math.min(100, (1 - fiveLeft) * 100)),
        windowMinutes: 300,
        resetsAt: fiveReset,
      },
      secondary: {
        usedPercent: Math.max(0, Math.min(100, (1 - weeklyLeft) * 100)),
        windowMinutes: 10080,
        resetsAt: weeklyReset,
      },
      identity: { loginMethod: plan ?? "password" },
    };
  },
};
const strategy: ProviderStrategy = {
  id: "stepfun.web",
  kind: "web",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const stepfun: FirstPartyProvider = { ...strategy, descriptor };
