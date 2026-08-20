import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderResponse,
  ProviderStrategy,
} from "../types.ts";
import { date, get, json, number, object, status, string } from "./_http.ts";

type Dict = Record<string, unknown>;
const normalized = (key: string): string => key.replace(/[^a-z0-9]/gi, "").toLowerCase();
const value = (dict: Dict, keys: readonly string[]): unknown => {
  for (const key of keys) {
    const found = Object.entries(dict).find(
      ([candidate]) => normalized(candidate) === normalized(key),
    );
    if (found) return found[1];
  }
  return undefined;
};
const bool = (raw: unknown): boolean | undefined => {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw !== 0;
  if (typeof raw !== "string") return undefined;
  switch (raw.trim().toLowerCase()) {
    case "true":
    case "1":
    case "yes":
    case "active":
      return true;
    case "false":
    case "0":
    case "no":
    case "inactive":
      return false;
    default:
      return undefined;
  }
};
const boundedPercent = (raw: unknown): number | undefined => {
  const parsed = number(raw);
  if (parsed === undefined) return undefined;
  return Math.max(0, Math.min(100, Math.abs(parsed) < 1 ? parsed * 100 : parsed));
};

type Quota = {
  readonly label?: string;
  readonly used?: number;
  readonly limit?: number;
  readonly remaining?: number;
  readonly percent?: number;
  readonly windowMinutes?: number;
  readonly resetsAt?: string;
  readonly unit?: string;
};

function parseWindow(
  raw: unknown,
  ctx: ProviderContext,
  defaultMinutes?: number,
  defaultLabel?: string,
): Quota | undefined {
  const source = object(raw);
  if (!source) return undefined;
  const used = number(
    value(source, [
      "used",
      "usage",
      "used_amount",
      "usedAmount",
      "consumed",
      "consumed_amount",
      "consumedAmount",
      "current",
      "current_usage",
      "currentUsage",
      "requests",
      "request_count",
      "requestCount",
      "tokens",
      "token_usage",
      "tokenUsage",
      "monthly_usage",
      "monthlyUsage",
    ]),
  );
  const limit = number(
    value(source, [
      "limit",
      "cap",
      "max",
      "maximum",
      "quota",
      "quota_limit",
      "quotaLimit",
      "monthly_cap",
      "monthlyCap",
      "monthly_limit",
      "monthlyLimit",
      "request_limit",
      "requestLimit",
      "token_limit",
      "tokenLimit",
      "hard_limit",
      "hardLimit",
      "total",
    ]),
  );
  const remaining = number(
    value(source, [
      "remaining",
      "available",
      "balance",
      "left",
      "remaining_amount",
      "remainingAmount",
      "available_amount",
      "availableAmount",
    ]),
  );
  let percent = boundedPercent(
    value(source, [
      "percent_used",
      "percentUsed",
      "usage_percent",
      "usagePercent",
      "used_percent",
      "usedPercent",
      "utilization",
      "utilization_percent",
      "utilizationPercent",
    ]),
  );
  const remainingPercent = boundedPercent(
    value(source, [
      "percent_remaining",
      "percentRemaining",
      "remaining_percent",
      "remainingPercent",
    ]),
  );
  if (percent === undefined && remainingPercent !== undefined) percent = 100 - remainingPercent;
  if (percent === undefined && used !== undefined && limit !== undefined && limit > 0)
    percent = (used / limit) * 100;
  if (percent === undefined) return undefined;
  const rawWindow = number(
    value(source, [
      "window_minutes",
      "windowMinutes",
      "period_minutes",
      "periodMinutes",
      "duration_minutes",
      "durationMinutes",
    ]),
  );
  const hours = number(
    value(source, [
      "window_hours",
      "windowHours",
      "period_hours",
      "periodHours",
      "duration_hours",
      "durationHours",
    ]),
  );
  const days = number(
    value(source, [
      "window_days",
      "windowDays",
      "period_days",
      "periodDays",
      "duration_days",
      "durationDays",
    ]),
  );
  const seconds = number(
    value(source, [
      "window_seconds",
      "windowSeconds",
      "period_seconds",
      "periodSeconds",
      "duration_seconds",
      "durationSeconds",
    ]),
  );
  const durationText = string(value(source, ["window", "period", "interval", "duration"]));
  const durationMinutes = durationText ? parseDurationMinutes(durationText) : undefined;
  const label =
    string(
      value(source, [
        "label",
        "name",
        "title",
        "type",
        "quota_type",
        "quotaType",
        "period",
        "window",
        "window_name",
        "windowName",
        "chute_id",
        "chuteId",
      ]),
    ) || defaultLabel;
  const windowMinutes =
    rawWindow ??
    (hours === undefined ? undefined : hours * 60) ??
    (days === undefined ? undefined : days * 1440) ??
    (seconds === undefined ? undefined : seconds / 60) ??
    durationMinutes ??
    defaultMinutes;
  const resetsAt = date(
    value(source, [
      "reset_at",
      "resets_at",
      "reset_time",
      "resetTime",
      "next_reset_at",
      "nextResetAt",
      "renews_at",
      "renewsAt",
      "renewal_at",
      "renewalAt",
      "period_end",
      "periodEnd",
      "current_period_end",
      "currentPeriodEnd",
      "expires_at",
      "expiresAt",
      "window_end",
      "windowEnd",
      "end_time",
      "endTime",
    ]),
    ctx,
  );
  return {
    ...(label ? { label } : {}),
    ...(used === undefined ? {} : { used }),
    ...(limit === undefined ? {} : { limit }),
    ...(remaining === undefined ? {} : { remaining }),
    percent: Math.max(0, Math.min(100, percent)),
    ...(windowMinutes === undefined ? {} : { windowMinutes }),
    ...(resetsAt ? { resetsAt } : {}),
    unit:
      string(value(source, ["unit", "units", "currency", "quota_unit", "quotaUnit"])) || "credits",
  };
}
function parseDurationMinutes(raw: string): number | undefined {
  const match = raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .match(/^([0-9]+(?:\.[0-9]+)?)(min|m|hour|hr|h|day|d|month|mo)$/);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = match[2];
  if (!unit) return undefined;
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  if (unit === "min" || unit === "m") return Math.round(amount);
  if (["hour", "hr", "h"].includes(unit)) return Math.round(amount * 60);
  if (["day", "d"].includes(unit)) return Math.round(amount * 1440);
  return Math.round(amount * 30 * 1440);
}
function usageDescription(window: Quota): string | undefined {
  if (window.limit === undefined || window.limit <= 0) return undefined;
  const used =
    window.used ??
    (window.remaining === undefined ? undefined : Math.max(0, window.limit - window.remaining));
  if (used === undefined) return undefined;
  const amount = (n: number): string =>
    Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return `${amount(used)}/${amount(window.limit)} ${window.unit || "credits"}`;
}
function kind(window: Quota): "rolling" | "monthly" | undefined {
  const text = `${window.label || ""} ${window.unit || ""}`.toLowerCase();
  if (
    text.includes("rolling") ||
    text.includes("4h") ||
    text.includes("4-hour") ||
    window.windowMinutes === 240
  )
    return "rolling";
  if (
    text.includes("month") ||
    text.includes("billing") ||
    text.includes("subscription") ||
    (window.windowMinutes ?? 0) >= 28 * 24 * 60
  )
    return "monthly";
  return undefined;
}
function walkQuotaObjects(valueToWalk: unknown): Dict[] {
  if (Array.isArray(valueToWalk)) return valueToWalk.flatMap(walkQuotaObjects);
  const dict = object(valueToWalk);
  if (!dict) return [];
  const isQuota = [
    "limit",
    "cap",
    "max",
    "maximum",
    "quota",
    "quota_limit",
    "monthly_cap",
    "request_limit",
    "token_limit",
    "hard_limit",
    "total",
    "used",
    "usage",
    "used_amount",
    "consumed",
    "current",
    "remaining",
    "available",
    "balance",
    "left",
    "percent_used",
    "usage_percent",
    "used_percent",
    "utilization",
    "percent_remaining",
  ].some((key) => value(dict, [key]) !== undefined);
  return [...(isQuota ? [dict] : []), ...Object.values(dict).flatMap(walkQuotaObjects)];
}
function parseSnapshot(
  raw: unknown,
  ctx: ProviderContext,
): {
  readonly rolling?: Quota;
  readonly monthly?: Quota;
  readonly fallback: readonly Quota[];
  readonly active?: boolean;
  readonly plan?: string;
  readonly renewsAt?: string;
} {
  const root = Array.isArray(raw) ? { quotas: raw } : object(raw) || {};
  const data = object(value(root, ["data", "result"])) || root;
  const subscription =
    object(
      value(root, [
        "subscription",
        "subscription_usage",
        "subscriptionUsage",
        "current_subscription",
        "currentSubscription",
        "billing_period",
        "billingPeriod",
        "plan",
      ]),
    ) ||
    object(
      value(data, [
        "subscription",
        "subscription_usage",
        "subscriptionUsage",
        "current_subscription",
        "currentSubscription",
        "billing_period",
        "billingPeriod",
        "plan",
      ]),
    );
  const explicitRolling =
    parseWindow(
      value(root, [
        "rolling",
        "rolling_window",
        "rollingWindow",
        "rolling_4h",
        "rolling4h",
        "four_hour",
        "fourHour",
        "four_hour_usage",
        "fourHourUsage",
        "window_4h",
        "window4h",
      ]),
      ctx,
      240,
      "4-hour quota",
    ) ||
    parseWindow(
      value(data, [
        "rolling",
        "rolling_window",
        "rollingWindow",
        "rolling_4h",
        "rolling4h",
        "four_hour",
        "fourHour",
        "four_hour_usage",
        "fourHourUsage",
        "window_4h",
        "window4h",
      ]),
      ctx,
      240,
      "4-hour quota",
    );
  const explicitMonthly =
    parseWindow(
      value(root, [
        "monthly",
        "monthly_usage",
        "monthlyUsage",
        "subscription",
        "subscription_usage",
        "subscriptionUsage",
        "billing_period",
        "billingPeriod",
      ]),
      ctx,
      30 * 24 * 60,
      "Monthly quota",
    ) ||
    parseWindow(
      value(data, [
        "monthly",
        "monthly_usage",
        "monthlyUsage",
        "subscription",
        "subscription_usage",
        "subscriptionUsage",
        "billing_period",
        "billingPeriod",
      ]),
      ctx,
      30 * 24 * 60,
      "Monthly quota",
    );
  const candidates = [
    ...walkQuotaObjects(
      value(root, [
        "quotas",
        "quota",
        "quota_usage",
        "quotaUsage",
        "limits",
        "usage",
        "entries",
        "subscription_usage",
        "subscriptionUsage",
      ]),
    ),
    ...walkQuotaObjects(
      value(data, [
        "quotas",
        "quota",
        "quota_usage",
        "quotaUsage",
        "limits",
        "usage",
        "entries",
        "subscription_usage",
        "subscriptionUsage",
      ]),
    ),
    ...walkQuotaObjects(data),
    ...walkQuotaObjects(root),
  ];
  const seen = new Set<string>();
  const quotaWindows = candidates.flatMap((candidate) => {
    const parsed = parseWindow(candidate, ctx);
    if (!parsed) return [];
    const key = JSON.stringify([
      parsed.label,
      parsed.used,
      parsed.limit,
      parsed.remaining,
      parsed.percent,
      parsed.windowMinutes,
      parsed.resetsAt,
    ]);
    if (seen.has(key)) return [];
    seen.add(key);
    return [parsed];
  });
  const rolling = explicitRolling || quotaWindows.find((entry) => kind(entry) === "rolling");
  const monthly = explicitMonthly || quotaWindows.find((entry) => kind(entry) === "monthly");
  const fallback = quotaWindows.filter((entry) => entry !== rolling && entry !== monthly);
  const activeKeys = [
    "active",
    "is_active",
    "isActive",
    "subscription_active",
    "subscriptionActive",
    "has_subscription",
    "hasSubscription",
  ];
  const statusKeys = ["status", "state", "subscription_status", "subscriptionStatus"];
  const planKeys = [
    "plan_name",
    "planName",
    "plan",
    "tier",
    "subscription_plan",
    "subscriptionPlan",
    "subscription_tier",
    "subscriptionTier",
  ];
  const active =
    bool(value(root, activeKeys)) ??
    bool(value(data, activeKeys)) ??
    bool(subscription && value(subscription, activeKeys));
  const rawStatus =
    string(value(root, statusKeys)) ||
    string(value(data, statusKeys)) ||
    string(subscription && value(subscription, statusKeys));
  const statusActive =
    rawStatus?.toLowerCase().includes("active") && !rawStatus.toLowerCase().includes("inactive");
  const statusInactive = rawStatus ? /free|inactive|cancel|none|expired/i.test(rawStatus) : false;
  const resolvedActive =
    active ?? (rawStatus ? (statusInactive ? false : statusActive ? true : undefined) : undefined);
  const plan =
    string(value(root, planKeys)) ||
    string(value(data, planKeys)) ||
    string(subscription && value(subscription, planKeys));
  const renewsAt =
    date(
      value(root, ["current_period_end", "period_end", "billing_period_end", "reset_at"]),
      ctx,
    ) ||
    date(
      value(data, ["current_period_end", "period_end", "billing_period_end", "reset_at"]),
      ctx,
    ) ||
    date(
      subscription &&
        value(subscription, ["current_period_end", "period_end", "billing_period_end", "reset_at"]),
      ctx,
    );
  return {
    ...(rolling ? { rolling } : {}),
    ...(monthly ? { monthly } : {}),
    fallback,
    ...(resolvedActive === undefined ? {} : { active: resolvedActive }),
    ...(plan ? { plan } : {}),
    ...(renewsAt ? { renewsAt } : {}),
  };
}
function snapshotResult(parsed: ReturnType<typeof parseSnapshot>): Record<string, unknown> {
  const primary = parsed.rolling || (!parsed.monthly ? parsed.fallback[0] : undefined);
  const secondary = parsed.monthly || (parsed.rolling ? parsed.fallback[0] : parsed.fallback[1]);
  const result: Record<string, unknown> = {
    identity: {
      loginMethod:
        parsed.plan ||
        (parsed.active === false
          ? "No active subscription"
          : primary || secondary
            ? undefined
            : "No usage data"),
    },
  };
  const encode = (window: Quota | undefined): Record<string, unknown> | undefined =>
    window?.percent === undefined
      ? undefined
      : {
          usedPercent: window.percent,
          ...(window.windowMinutes ? { windowMinutes: window.windowMinutes } : {}),
          ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}),
          ...(usageDescription(window) ? { resetDescription: usageDescription(window) } : {}),
        };
  const primaryOutput = encode(primary);
  if (primaryOutput) result.primary = primaryOutput;
  const secondaryOutput = encode(secondary);
  if (secondaryOutput) result.secondary = secondaryOutput;
  if (parsed.renewsAt) result.subscriptionRenewsAt = parsed.renewsAt;
  return result;
}

const definition: ProviderDefinition = {
  id: "chutes",
  name: "Chutes",
  endpoints: ["https://api.chutes.ai", { setting: "CHUTES_API_URL", policy: "https" }],
  auth: { type: "bearer", secret: "CHUTES_API_KEY" },
  settings: [
    { key: "CHUTES_API_KEY", title: "API key", type: "secure" },
    { key: "CHUTES_API_URL", title: "API URL", type: "plain" },
  ],
  fetchUsage: async (ctx) => {
    const key = ctx.settings.getSecret("CHUTES_API_KEY") || ctx.settings.get("CHUTES_API_KEY");
    if (!key?.trim()) throw ctx.fail.missingCredential("Missing Chutes API key.");
    const configured = ctx.settings.get("CHUTES_API_URL")?.trim();
    let rootURL = "https://api.chutes.ai";
    if (configured) {
      try {
        const url = new URL(configured);
        if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
          throw new Error("invalid");
        rootURL = configured.replace(/\/+$/, "");
      } catch {
        throw ctx.fail.apiFailure(
          "CHUTES_API_URL must be an HTTPS URL without credentials or query parameters.",
        );
      }
    }
    const headers = { Authorization: `Bearer ${key.trim()}`, Accept: "application/json" };
    const first = await get(ctx, `${rootURL}/users/me/subscription_usage`, { headers });
    status(ctx, "Chutes", first);
    const subscription = parseSnapshot(json(ctx, "Chutes", first), ctx);
    if (subscription.rolling && subscription.monthly) return snapshotResult(subscription);
    let quotasResponse: ProviderResponse;
    try {
      quotasResponse = await get(ctx, `${rootURL}/users/me/quotas`, { headers });
      status(ctx, "Chutes", quotasResponse);
    } catch (error) {
      if (error instanceof Error && /authentication-expired|permission-denied/.test(error.message))
        throw error;
      return snapshotResult(subscription);
    }
    const quotasBody = json(ctx, "Chutes", quotasResponse);
    const quotaContainer = object(quotasBody);
    const definitionsRaw = Array.isArray(quotasBody)
      ? quotasBody
      : quotaContainer?.data || quotaContainer?.quotas || [];
    const definitions = Array.isArray(definitionsRaw) ? definitionsRaw : [];
    const enriched: unknown[] = [];
    for (const raw of definitions) {
      const def = object(raw);
      if (!def) continue;
      const id = string(value(def, ["chute_id", "chuteId", "id"]));
      if (!id) {
        enriched.push(def);
        continue;
      }
      try {
        const usage = await get(ctx, `${rootURL}/users/me/quota_usage/${encodeURIComponent(id)}`, {
          headers,
        });
        status(ctx, "Chutes", usage);
        const usageBody = object(json(ctx, "Chutes", usage));
        enriched.push(
          usageBody
            ? { ...def, ...(object(usageBody.data) || object(usageBody.result) || usageBody) }
            : def,
        );
      } catch (error) {
        if (
          error instanceof Error &&
          /authentication-expired|permission-denied/.test(error.message)
        )
          throw error;
        enriched.push(def);
      }
    }
    const fallback = parseSnapshot({ quotas: enriched }, ctx);
    const merged: {
      readonly fallback: readonly Quota[];
      rolling?: Quota;
      monthly?: Quota;
      active?: boolean;
      plan?: string;
      renewsAt?: string;
    } = { fallback: [...fallback.fallback, ...subscription.fallback] };
    const mergedRolling = subscription.rolling || fallback.rolling;
    const mergedMonthly = subscription.monthly || fallback.monthly;
    if (mergedRolling) merged.rolling = mergedRolling;
    if (mergedMonthly) merged.monthly = mergedMonthly;
    if (subscription.active !== undefined) merged.active = subscription.active;
    if (subscription.plan) merged.plan = subscription.plan;
    const renewsAt = subscription.renewsAt || fallback.monthly?.resetsAt;
    if (renewsAt) merged.renewsAt = renewsAt;
    return snapshotResult(merged);
  },
};
const strategy: ProviderStrategy = {
  id: "chutes.api",
  kind: "api",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const chutes: FirstPartyProvider = { ...strategy, descriptor };
