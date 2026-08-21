import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { number, object, status, string } from "./_http.ts";

const baseURL = "https://cloudcode-pa.googleapis.com/v1internal:";
const clamp = (value: number) => Math.max(0, Math.min(1, value));
/** Upstream auto order. The first three entries require injected local adapters. */
export const antigravityAutoSourceOrder = ["app-local", "cli-https", "ide-local", "oauth"] as const;
type Quota = {
  readonly id: string;
  readonly label: string;
  readonly remaining: number;
  readonly reset?: string;
};

type QuotaSummaryBucket = {
  readonly id: string;
  readonly label: string;
  readonly remaining?: number;
  readonly reset?: string;
  readonly resetDescription?: string;
  readonly usageKnown: boolean;
  readonly windowMinutes?: number;
};

const sessionCadenceAliases = new Set(["session", "5h", "5-hour", "five hour", "five-hour"]);

export const antigravityQuotaWindowMinutes = (
  bucketId: string,
  displayName: string,
): number | undefined => {
  const candidates = new Set<string>();
  for (const rawValue of [bucketId, displayName]) {
    const normalized = rawValue.trim().toLowerCase().replaceAll("_", "-");
    if (normalized === "") continue;
    const normalizedCandidates = normalized.endsWith(" limit")
      ? [normalized, normalized.slice(0, -" limit".length)]
      : [normalized];
    for (const candidate of normalizedCandidates) {
      candidates.add(candidate);
      for (const alias of [...sessionCadenceAliases, "weekly"])
        if (candidate.endsWith(`-${alias}`)) candidates.add(alias);
    }
  }
  if ([...sessionCadenceAliases].some((alias) => candidates.has(alias))) return 300;
  return candidates.has("weekly") ? 10_080 : undefined;
};

const quotaGroupTitle = (displayName: string): string => {
  const normalized = displayName.trim();
  const lowercased = normalized.toLowerCase();
  if (lowercased.includes("gemini")) return "Gemini";
  if (lowercased.includes("claude") || lowercased.includes("gpt")) return "Claude/GPT";
  return normalized || "Quota";
};

const quotaBucketTitle = (displayName: string, windowMinutes: number | undefined): string =>
  windowMinutes === 300 ? "5-hour" : windowMinutes === 10_080 ? "weekly" : displayName;

const quotaGroupSortRank = (displayName: string): number => {
  const normalized = displayName.trim().toLowerCase();
  if (normalized.includes("gemini")) return 0;
  if (normalized.includes("claude") || normalized.includes("gpt")) return 1;
  return 2;
};

const quotaBucketSortRank = (windowMinutes: number | undefined): number =>
  windowMinutes === 300 ? 0 : windowMinutes === 10_080 ? 1 : 2;

const quotaSummaryRemaining = (bucket: Record<string, unknown>): number | undefined => {
  const remaining = object(bucket.remaining);
  return (
    number(bucket.remainingFraction) ??
    number(remaining?.remainingFraction) ??
    (string(remaining?.case) === "remainingFraction" ? number(remaining?.value) : undefined)
  );
};

const quota = (id: string, value: unknown): Quota | undefined => {
  const model = object(value);
  const info = object(model?.quotaInfo) ?? model;
  const remaining =
    number(info?.remainingFraction) ?? number(object(info?.remaining)?.remainingFraction);
  if (remaining === undefined) return undefined;
  const reset = string(info?.resetTime);
  return {
    id,
    label: string(model?.displayName) ?? string(model?.label) ?? id,
    remaining: clamp(remaining),
    ...(reset ? { reset } : {}),
  };
};

/** Port of the local RetrieveUserQuotaSummary shape. No socket/process discovery occurs here. */
export const parseAntigravityQuotaSummary = (payload: unknown, ctx: ProviderContext) => {
  const root = object(payload);
  const summary = object(root?.response) ?? object(root?.summary) ?? root;
  const groups = (Array.isArray(summary?.groups) ? summary.groups : [])
    .map(object)
    .filter((group): group is Record<string, unknown> => group !== undefined)
    .map((group, index) => ({ group, index }))
    .sort(
      (left, right) =>
        quotaGroupSortRank(string(left.group.displayName) ?? "") -
          quotaGroupSortRank(string(right.group.displayName) ?? "") || left.index - right.index,
    );
  const quotas = groups.flatMap(({ group }) => {
    const groupName = string(group.displayName)?.trim() || "Quota";
    const buckets = (Array.isArray(group.buckets) ? group.buckets : [])
      .map(object)
      .filter((bucket): bucket is Record<string, unknown> => bucket !== undefined)
      .flatMap((bucket, index) => {
        const id = string(bucket.bucketId)?.trim();
        if (!id) return [];
        const displayName = string(bucket.displayName)?.trim() || id;
        const windowMinutes = antigravityQuotaWindowMinutes(id, displayName);
        return [{ bucket, displayName, id, index, windowMinutes }];
      })
      .sort(
        (left, right) =>
          quotaBucketSortRank(left.windowMinutes) - quotaBucketSortRank(right.windowMinutes) ||
          left.index - right.index,
      );
    return buckets.map(({ bucket, displayName, id, windowMinutes }): QuotaSummaryBucket => {
      const remaining = quotaSummaryRemaining(bucket);
      const reset = string(bucket.resetTime);
      const resetDescription = string(bucket.description);
      const usageKnown = bucket.disabled !== true && remaining !== undefined;
      return {
        id,
        label: `${quotaGroupTitle(groupName)} ${quotaBucketTitle(displayName, windowMinutes)}`,
        ...(remaining === undefined ? {} : { remaining: clamp(remaining) }),
        ...(reset ? { reset } : {}),
        ...(resetDescription ? { resetDescription } : {}),
        usageKnown,
        ...(windowMinutes === undefined ? {} : { windowMinutes }),
      };
    });
  });
  if (!quotas.length)
    throw ctx.fail.parseFailure("Antigravity local quota response has no usable buckets.");
  return quotaSummarySnapshot(quotas, ctx);
};

const quotaSummarySnapshot = (quotas: readonly QuotaSummaryBucket[], ctx: ProviderContext) => {
  const windows = quotas.map((item) => ({
    id: `antigravity-quota-summary-${item.id}`,
    title: item.label,
    window: {
      usedPercent: item.remaining === undefined ? 0 : (1 - item.remaining) * 100,
      ...(item.windowMinutes === undefined ? {} : { windowMinutes: item.windowMinutes }),
      ...(item.reset ? { resetsAt: ctx.date.iso(item.reset) } : {}),
      ...(item.resetDescription ? { resetDescription: item.resetDescription } : {}),
    },
    ...(item.usageKnown ? {} : { usageKnown: false }),
  }));
  const representative = (predicate: (title: string) => boolean) =>
    windows
      .filter((item) => item.usageKnown !== false && predicate(item.title.toLowerCase()))
      .sort(
        (left, right) =>
          right.window.usedPercent - left.window.usedPercent ||
          left.title.localeCompare(right.title, undefined, { sensitivity: "base" }),
      )[0]?.window;
  const primary = representative((title) => title.includes("gemini"));
  const secondary = representative((title) => title.includes("claude") || title.includes("gpt"));
  return {
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    extraRateWindows: windows,
    identity: { providerId: "antigravity" },
  };
};

const snapshot = (
  quotas: readonly (Quota & { readonly windowMinutes?: number })[],
  ctx: ProviderContext,
  identity: Record<string, unknown> = {},
) => {
  const windows = quotas.map((item) => ({
    id: `antigravity-quota-summary-${item.id}`,
    title: item.label,
    window: {
      usedPercent: (1 - item.remaining) * 100,
      ...(item.windowMinutes === undefined ? {} : { windowMinutes: item.windowMinutes }),
      ...(item.reset ? { resetsAt: ctx.date.iso(item.reset), resetDescription: item.reset } : {}),
    },
  }));
  const constrained = [...windows].sort(
    (left, right) =>
      Number(object(right.window)?.usedPercent) - Number(object(left.window)?.usedPercent),
  )[0];
  return {
    ...(constrained ? { primary: constrained.window } : {}),
    extraRateWindows: windows,
    identity: { providerId: "antigravity", ...identity },
  };
};

const projectFrom = (payload: unknown): string | undefined => {
  const root = object(payload);
  const direct = string(root?.cloudaicompanionProject);
  return (
    direct ??
    string(object(root?.cloudaicompanionProject)?.value) ??
    string(object(root?.response)?.cloudaicompanionProject)
  );
};
const planFrom = (payload: unknown): string | undefined =>
  string(object(object(payload)?.currentTier)?.name) ??
  string(object(object(payload)?.currentTier)?.id);

const headers = (token: string) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
  "User-Agent": "antigravity",
});
const post = (
  ctx: ProviderContext,
  endpoint: string,
  token: string,
  body: Record<string, unknown>,
) => ctx.http.postJSON(`${baseURL}${endpoint}`, { headers: headers(token), body });

const remoteUsage = async (ctx: ProviderContext, token: string) => {
  const load = await post(ctx, "loadCodeAssist", token, {
    metadata: { ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" },
  });
  status(ctx, "Antigravity", load);
  const project = ctx.settings.get("ANTIGRAVITY_PROJECT_ID")?.trim() || projectFrom(load.json);
  const body = project ? { project } : {};
  const models = await post(ctx, "fetchAvailableModels", token, body);
  let quotas: Quota[] = [];
  if (models.status !== 403) {
    status(ctx, "Antigravity", models);
    const entries = object(models.json)?.models;
    if (object(entries))
      quotas = Object.entries(object(entries) ?? {}).flatMap(
        ([id, value]) => quota(id, value) ?? [],
      );
  }
  // Upstream uses retrieveUserQuota after a models permission denial, or to
  // verify the suspicious all-100%-remaining response from that endpoint.
  const needsVerification = quotas.length > 0 && quotas.every((item) => item.remaining >= 0.999);
  if (models.status === 403 || needsVerification) {
    const fallback = await post(ctx, "retrieveUserQuota", token, body);
    if (fallback.status !== 403) {
      status(ctx, "Antigravity", fallback);
      const candidateBuckets = object(fallback.json)?.buckets;
      const buckets: unknown[] = Array.isArray(candidateBuckets) ? candidateBuckets : [];
      const byID = new Map<string, Quota>();
      for (const raw of buckets) {
        const item = object(raw);
        const id = string(item?.modelId);
        const parsed = id ? quota(id, item) : undefined;
        if (
          parsed &&
          (!byID.has(parsed.id) || parsed.remaining < (byID.get(parsed.id)?.remaining ?? 1))
        )
          byID.set(parsed.id, parsed);
      }
      if (models.status === 403) {
        quotas = [...byID.values()];
      } else if (byID.size) {
        const originalByID = new Map(quotas.map((item) => [item.id, item]));
        quotas = quotas
          .flatMap((item) => {
            const verified = byID.get(item.id);
            return verified
              ? [
                  {
                    ...item,
                    remaining: verified.remaining,
                    ...(verified.reset ? { reset: verified.reset } : {}),
                  },
                ]
              : [];
          })
          .concat([...byID.values()].filter((item) => !originalByID.has(item.id)));
      } else {
        // A full-models answer which cannot be verified is intentionally not shown.
        quotas = [];
      }
    }
  }
  return snapshot(quotas, ctx, {
    ...(ctx.settings.get("ANTIGRAVITY_ACCOUNT_EMAIL")?.trim()
      ? { accountEmail: ctx.settings.get("ANTIGRAVITY_ACCOUNT_EMAIL")?.trim() }
      : {}),
    ...(ctx.settings.get("ANTIGRAVITY_ACCOUNT_PLAN")?.trim()
      ? { loginMethod: ctx.settings.get("ANTIGRAVITY_ACCOUNT_PLAN")?.trim() }
      : {}),
    ...(planFrom(load.json) ? { loginMethod: planFrom(load.json) } : {}),
  });
};

const definition: ProviderDefinition = {
  id: "antigravity",
  name: "Antigravity",
  endpoints: ["https://cloudcode-pa.googleapis.com"],
  settings: [
    { key: "ANTIGRAVITY_OAUTH_ACCESS_TOKEN", title: "Google OAuth access token", type: "secure" },
    { key: "ANTIGRAVITY_PROJECT_ID", title: "Google Cloud project", type: "plain" },
    { key: "ANTIGRAVITY_LOCAL_QUOTA_JSON", title: "Local quota JSON", type: "secure" },
  ],
  fetchUsage: async (ctx) => {
    const local = ctx.settings.getSecret("ANTIGRAVITY_LOCAL_QUOTA_JSON")?.trim();
    if (local) {
      try {
        return parseAntigravityQuotaSummary(JSON.parse(local) as unknown, ctx);
      } catch (error) {
        if (error instanceof SyntaxError)
          throw ctx.fail.parseFailure("Antigravity local quota output was not valid JSON.");
        throw error;
      }
    }
    const token = ctx.settings.getSecret("ANTIGRAVITY_OAUTH_ACCESS_TOKEN")?.trim();
    if (!token)
      throw ctx.fail.missingCredential(
        "Antigravity needs ProcessRunner/PrivateFileStore local data or an OAuth credential owned by CredentialStore.",
      );
    return remoteUsage(ctx, token);
  },
};
const strategy: ProviderStrategy = {
  id: "antigravity.oauth",
  kind: "api",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const antigravity: FirstPartyProvider = { ...strategy, descriptor };
