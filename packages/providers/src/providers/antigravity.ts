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
  const groups = Array.isArray(summary?.groups) ? summary.groups.map(object).filter(Boolean) : [];
  const quotas = groups.flatMap((group) => {
    const groupName = string(group?.displayName) ?? "Quota";
    const buckets = Array.isArray(group?.buckets) ? group.buckets.map(object).filter(Boolean) : [];
    return buckets.flatMap((bucket) => {
      if (bucket?.disabled === true) return [];
      const id = string(bucket?.bucketId);
      const remaining =
        number(bucket?.remainingFraction) ?? number(object(bucket?.remaining)?.remainingFraction);
      if (!id || remaining === undefined) return [];
      const reset = string(bucket?.resetTime);
      return [
        {
          id,
          label: `${groupName}: ${string(bucket?.displayName) ?? id}`,
          remaining: clamp(remaining),
          ...(reset ? { reset } : {}),
        },
      ];
    });
  });
  if (!quotas.length)
    throw ctx.fail.parseFailure("Antigravity local quota response has no usable buckets.");
  return snapshot(quotas, ctx);
};

const snapshot = (
  quotas: readonly Quota[],
  ctx: ProviderContext,
  identity: Record<string, unknown> = {},
) => {
  const windows = quotas.map((item) => ({
    id: `antigravity-quota-summary-${item.id}`,
    title: item.label,
    window: {
      usedPercent: (1 - item.remaining) * 100,
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
