import type { ProviderContext, ProviderSnapshot } from "../types.ts";
import { object } from "./_http.ts";

export type CopilotQuotaSnapshot = {
  readonly entitlement: number;
  readonly remaining: number;
  readonly creditsUsed?: number;
  readonly percentRemaining: number;
  readonly quotaId: string;
  readonly hasPercentRemaining: boolean;
  readonly unlimited: boolean;
  readonly decodedEntitlement: boolean;
  readonly decodedRemaining: boolean;
};

export type CopilotUsageModel = {
  readonly premium?: CopilotQuotaSnapshot;
  readonly chat?: CopilotQuotaSnapshot;
  readonly copilotPlan: string;
  readonly tokenBasedBilling: boolean;
  readonly quotaResetDate?: string;
};

const decodeNumber = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

const isPlaceholder = (snapshot: CopilotQuotaSnapshot): boolean => {
  if (snapshot.unlimited) return false;
  if (
    snapshot.entitlement === 0 &&
    snapshot.remaining === 0 &&
    snapshot.percentRemaining === 0 &&
    !snapshot.hasPercentRemaining
  ) {
    return true;
  }
  return (
    snapshot.decodedEntitlement &&
    snapshot.decodedRemaining &&
    snapshot.entitlement === 0 &&
    snapshot.remaining === 0
  );
};

const usedPercent = (snapshot: CopilotQuotaSnapshot): number =>
  Math.max(0, 100 - snapshot.percentRemaining);

const withCreditsUsed = (
  snapshot: CopilotQuotaSnapshot,
  creditsUsed: number | undefined,
): CopilotQuotaSnapshot => (creditsUsed === undefined ? snapshot : { ...snapshot, creditsUsed });

const parseQuotaSnapshot = (value: unknown): CopilotQuotaSnapshot | undefined => {
  const root = object(value);
  if (!root) return undefined;
  const decodedEntitlement = decodeNumber(root.entitlement);
  const decodedRemaining = decodeNumber(root.remaining);
  const creditsUsed = decodeNumber(root.credits_used);
  const unlimited = root.unlimited === true;
  const decodedPercent = decodeNumber(root.percent_remaining);
  let percentRemaining = 0;
  let hasPercentRemaining = false;
  if (unlimited) {
    percentRemaining = 100;
    hasPercentRemaining = true;
  } else if (decodedPercent !== undefined) {
    percentRemaining = decodedPercent;
    hasPercentRemaining = true;
  } else if (
    decodedEntitlement !== undefined &&
    decodedEntitlement > 0 &&
    decodedRemaining !== undefined
  ) {
    percentRemaining = (decodedRemaining / decodedEntitlement) * 100;
    hasPercentRemaining = true;
  }
  return {
    entitlement: decodedEntitlement ?? 0,
    remaining: decodedRemaining ?? 0,
    ...(creditsUsed === undefined ? {} : { creditsUsed }),
    percentRemaining,
    quotaId: typeof root.quota_id === "string" ? root.quota_id : "",
    hasPercentRemaining,
    unlimited,
    decodedEntitlement: decodedEntitlement !== undefined,
    decodedRemaining: decodedRemaining !== undefined,
  };
};

const usableSnapshot = (
  snapshot: CopilotQuotaSnapshot | undefined,
): CopilotQuotaSnapshot | undefined => {
  if (!snapshot || isPlaceholder(snapshot) || !snapshot.hasPercentRemaining) return undefined;
  return snapshot;
};

const keepSnapshot = (
  snapshot: CopilotQuotaSnapshot | undefined,
): CopilotQuotaSnapshot | undefined => {
  if (!snapshot) return undefined;
  if (isPlaceholder(snapshot) && snapshot.creditsUsed === undefined) return undefined;
  return snapshot;
};

const parseQuotaSnapshots = (
  value: unknown,
): { premium?: CopilotQuotaSnapshot; chat?: CopilotQuotaSnapshot } => {
  const root = object(value);
  if (!root) return {};
  let premium = keepSnapshot(parseQuotaSnapshot(root.premium_interactions));
  let chat = keepSnapshot(parseQuotaSnapshot(root.chat));
  if (premium !== undefined && chat !== undefined) return { premium, chat };

  let fallbackPremium: CopilotQuotaSnapshot | undefined;
  let fallbackChat: CopilotQuotaSnapshot | undefined;
  let firstUsable: CopilotQuotaSnapshot | undefined;
  for (const [key, child] of Object.entries(root)) {
    const decoded = keepSnapshot(parseQuotaSnapshot(child));
    if (!decoded) continue;
    firstUsable ??= decoded;
    const name = key.toLowerCase();
    if (fallbackChat === undefined && name.includes("chat")) {
      fallbackChat = decoded;
      continue;
    }
    if (
      fallbackPremium === undefined &&
      (name.includes("premium") || name.includes("completion") || name.includes("code"))
    ) {
      fallbackPremium = decoded;
    }
  }
  premium ??= fallbackPremium;
  chat ??= fallbackChat;
  if (premium === undefined && chat === undefined && firstUsable !== undefined) {
    chat = firstUsable;
  }
  return {
    ...(premium === undefined ? {} : { premium }),
    ...(chat === undefined ? {} : { chat }),
  };
};

const parseQuotaCounts = (value: unknown): { chat?: number; completions?: number } => {
  const root = object(value);
  if (!root) return {};
  const chat = decodeNumber(root.chat);
  const completions = decodeNumber(root.completions);
  return {
    ...(chat === undefined ? {} : { chat }),
    ...(completions === undefined ? {} : { completions }),
  };
};

const monthlySnapshot = (
  monthly: number | undefined,
  limited: number | undefined,
  quotaId: string,
): CopilotQuotaSnapshot | undefined => {
  if (monthly === undefined || limited === undefined) return undefined;
  const entitlement = Math.max(0, monthly);
  if (entitlement <= 0) return undefined;
  const remaining = Math.max(0, limited);
  return {
    entitlement,
    remaining,
    percentRemaining: Math.max(0, Math.min(100, (remaining / entitlement) * 100)),
    quotaId,
    hasPercentRemaining: true,
    unlimited: false,
    decodedEntitlement: true,
    decodedRemaining: true,
  };
};

const preferredSnapshot = (
  direct: CopilotQuotaSnapshot | undefined,
  fallback: CopilotQuotaSnapshot | undefined,
): CopilotQuotaSnapshot | undefined => {
  if (direct?.unlimited === true) {
    const usableFallback = usableSnapshot(fallback);
    if (usableFallback) return withCreditsUsed(usableFallback, direct.creditsUsed);
  }
  const directWindow = usableSnapshot(direct);
  if (directWindow) return directWindow;
  const usableFallback = usableSnapshot(fallback);
  if (!usableFallback) return undefined;
  return direct?.creditsUsed === undefined
    ? usableFallback
    : withCreditsUsed(usableFallback, direct.creditsUsed);
};

const capitalized = (value: string): string =>
  value.replaceAll(
    /\p{L}+/gu,
    (word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1).toLowerCase()}`,
  );

export const parseQuotaResetDate = (ctx: ProviderContext, value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const raw = value.trim();
  if (!raw) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/u.test(raw)) return ctx.date.iso(`${raw}T00:00:00Z`);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(raw)) {
    return Number.isFinite(Date.parse(raw)) ? ctx.date.iso(raw) : undefined;
  }
  return undefined;
};

export const parseCopilotUsageModel = (value: unknown): CopilotUsageModel => {
  const root = object(value);
  if (!root) throw new Error("Copilot usage response must be an object.");
  const direct = parseQuotaSnapshots(root.quota_snapshots);
  const monthly = parseQuotaCounts(root.monthly_quotas);
  const limited = parseQuotaCounts(root.limited_user_quotas);
  const monthlyPremium = monthlySnapshot(monthly.completions, limited.completions, "completions");
  const monthlyChat = monthlySnapshot(monthly.chat, limited.chat, "chat");
  const premium = preferredSnapshot(direct.premium, monthlyPremium);
  const chat = preferredSnapshot(direct.chat, monthlyChat);
  const snapshots =
    premium !== undefined || chat !== undefined
      ? {
          ...(premium === undefined ? {} : { premium }),
          ...(chat === undefined ? {} : { chat }),
        }
      : direct;
  const plan = typeof root.copilot_plan === "string" ? root.copilot_plan : "unknown";
  const quotaResetDate =
    typeof root.quota_reset_date === "string" ? root.quota_reset_date : undefined;
  return {
    ...snapshots,
    copilotPlan: plan,
    tokenBasedBilling: root.token_based_billing === true,
    ...(quotaResetDate === undefined ? {} : { quotaResetDate }),
  };
};

export const makeRateWindow = (
  snapshot: CopilotQuotaSnapshot | undefined,
  resetsAt: string | undefined,
): { usedPercent: number; resetsAt?: string; resetDescription?: string } | undefined => {
  if (!snapshot || snapshot.unlimited || isPlaceholder(snapshot) || !snapshot.hasPercentRemaining) {
    return undefined;
  }
  const used = usedPercent(snapshot);
  return {
    usedPercent: used,
    ...(resetsAt ? { resetsAt } : {}),
    ...(used > 100 ? { resetDescription: `${Math.round(used)}% used` } : {}),
  };
};

export const mapCopilotUsage = (ctx: ProviderContext, value: unknown): ProviderSnapshot => {
  let model: CopilotUsageModel;
  try {
    model = parseCopilotUsageModel(value);
  } catch {
    throw ctx.fail.parseFailure("Copilot usage response must be an object.");
  }
  const resetsAt = parseQuotaResetDate(ctx, model.quotaResetDate);
  const premiumWindow = makeRateWindow(model.premium, resetsAt);
  const chatWindow = makeRateWindow(model.chat, resetsAt);
  const unlimited = model.premium?.unlimited === true || model.chat?.unlimited === true;
  if (!premiumWindow && !chatWindow && !model.tokenBasedBilling && !unlimited) {
    throw ctx.fail.parseFailure("Copilot response has no metered quota window.");
  }
  const creditsUsed = model.premium?.creditsUsed ?? model.chat?.creditsUsed;
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
                  value: ctx.format.number(creditsUsed, { maximumFractionDigits: 2 }),
                  ...(resetsAt ? { secondaryValue: "Quota reset" } : {}),
                },
              ],
            },
          ],
        }),
    identity: { loginMethod: capitalized(model.copilotPlan) },
  };
};
