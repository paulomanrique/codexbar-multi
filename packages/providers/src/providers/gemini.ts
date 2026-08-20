import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { object, status, string } from "./_http.ts";

const codeAssistURL = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
const quotaURL = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota";
const projectsURL = "https://cloudresourcemanager.googleapis.com/v1/projects";

type Tier = "free-tier" | "legacy-tier" | "standard-tier" | undefined;
type ModelQuota = { readonly model: string; readonly remaining: number; readonly reset?: string };

const secret = (ctx: ProviderContext, key: string): string | undefined =>
  ctx.settings.getSecret(key)?.trim() || ctx.settings.get(key)?.trim() || undefined;

const claims = (
  token: string | undefined,
): { readonly email?: string; readonly hostedDomain?: string } => {
  if (!token) return {};
  const payload = token.split(".")[1];
  if (!payload) return {};
  try {
    const decoded = atob(
      payload
        .replace(/-/gu, "+")
        .replace(/_/gu, "/")
        .padEnd(Math.ceil(payload.length / 4) * 4, "="),
    );
    const root = JSON.parse(decoded) as unknown;
    const value = object(root);
    const email = string(value?.email);
    const hostedDomain = string(value?.hd);
    return {
      ...(email ? { email } : {}),
      ...(hostedDomain ? { hostedDomain } : {}),
    };
  } catch {
    return {};
  }
};

const isConsumerTierDeprecation = (body: string): boolean => {
  const text = body.toLowerCase();
  return (
    text.includes("unsupported_client") ||
    text.includes("ineligibletiererror") ||
    (text.includes("no longer supported") && text.includes("gemini code assist")) ||
    (text.includes("migrate") && text.includes("antigravity") && text.includes("gemini"))
  );
};

const resetDescription = (ctx: ProviderContext, reset: string | undefined): string | undefined => {
  if (!reset) return undefined;
  const timestamp = Date.parse(reset);
  if (!Number.isFinite(timestamp) || timestamp <= ctx.date.nowMillis()) return "Resets soon";
  const seconds = Math.floor((timestamp - ctx.date.nowMillis()) / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return hours > 0 ? `Resets in ${hours}h ${minutes}m` : `Resets in ${minutes}m`;
};

const projectFromResponse = (value: unknown): string | undefined => {
  const root = object(value);
  const candidate = root?.cloudaicompanionProject;
  return string(candidate) || string(object(candidate)?.id) || string(object(candidate)?.projectId);
};

const paidTier = (value: unknown): string | undefined =>
  string(object(object(value)?.paidTier)?.name);

const accountPlan = (tier: Tier, hostedDomain: string | undefined, paid: string | undefined) => {
  if (paid) return paid;
  if (tier === "standard-tier") return "Paid";
  if (tier === "free-tier") return hostedDomain ? "Workspace" : "Free";
  if (tier === "legacy-tier") return "Legacy";
  return undefined;
};

const quotas = (ctx: ProviderContext, value: unknown): readonly ModelQuota[] => {
  const root = object(value);
  if (!root || !Array.isArray(root.buckets) || root.buckets.length === 0) {
    throw ctx.fail.parseFailure("Gemini quota response has no quota buckets.");
  }
  const lowest = new Map<string, ModelQuota>();
  for (const raw of root.buckets) {
    const bucket = object(raw);
    const model = string(bucket?.modelId);
    const remaining = bucket?.remainingFraction;
    if (!model || typeof remaining !== "number" || !Number.isFinite(remaining)) continue;
    const current = lowest.get(model);
    if (!current || remaining < current.remaining) {
      const reset = string(bucket?.resetTime);
      lowest.set(model, { model, remaining, ...(reset ? { reset } : {}) });
    }
  }
  return [...lowest.values()].sort((left, right) => left.model.localeCompare(right.model));
};

const windowFor = (ctx: ProviderContext, rows: readonly ModelQuota[]) => {
  const lowest = rows.reduce<ModelQuota | undefined>(
    (result, row) => (!result || row.remaining < result.remaining ? row : result),
    undefined,
  );
  if (!lowest) return undefined;
  return {
    usedPercent: 100 - lowest.remaining * 100,
    windowMinutes: 1_440,
    ...(lowest.reset ? { resetsAt: ctx.date.iso(lowest.reset) } : {}),
    ...(resetDescription(ctx, lowest.reset)
      ? { resetDescription: resetDescription(ctx, lowest.reset) }
      : {}),
  };
};

const definition: ProviderDefinition = {
  id: "gemini",
  name: "Gemini",
  endpoints: ["https://cloudcode-pa.googleapis.com", "https://cloudresourcemanager.googleapis.com"],
  auth: { type: "bearer", secret: "GEMINI_ACCESS_TOKEN" },
  settings: [
    { key: "GEMINI_ACCESS_TOKEN", title: "OAuth access token", type: "secure" },
    { key: "GEMINI_ID_TOKEN", title: "OAuth ID token", type: "secure" },
    { key: "GEMINI_PROJECT_ID", title: "Google Cloud project", type: "plain" },
  ],
  fetchUsage: async (ctx: ProviderContext) => {
    const accessToken = secret(ctx, "GEMINI_ACCESS_TOKEN");
    if (!accessToken) throw ctx.fail.missingCredential("Not logged in to Gemini.");
    const identityClaims = claims(secret(ctx, "GEMINI_ID_TOKEN"));
    let tier: Tier;
    let project = ctx.settings.get("GEMINI_PROJECT_ID")?.trim() || undefined;
    let paid: string | undefined;

    // loadCodeAssist is advisory upstream, except for the explicit migration signal.
    try {
      const assist = await ctx.http.postJSON(codeAssistURL, {
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: { metadata: { ideType: "GEMINI_CLI", pluginType: "GEMINI" } },
      });
      if (assist.status >= 200 && assist.status < 300) {
        const root = object(assist.json);
        const tierID = string(object(root?.currentTier)?.id);
        tier =
          tierID === "free-tier" || tierID === "legacy-tier" || tierID === "standard-tier"
            ? tierID
            : undefined;
        project ??= projectFromResponse(root);
        paid = paidTier(root);
      } else if (isConsumerTierDeprecation(assist.bodyText)) {
        throw ctx.fail.apiFailure(
          "Gemini CLI consumer tier is no longer supported; migrate to Antigravity.",
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("consumer tier is no longer supported"))
        throw error;
    }

    if (!project) {
      try {
        const projects = await ctx.http.getJSON(projectsURL, {
          headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
        });
        if (projects.status >= 200 && projects.status < 300) {
          const rows = object(projects.json)?.projects;
          if (Array.isArray(rows)) {
            for (const raw of rows) {
              const candidate = object(raw);
              const projectID = string(candidate?.projectId);
              const labels = object(candidate?.labels);
              if (
                projectID &&
                (projectID.startsWith("gen-lang-client") ||
                  labels?.["generative-language"] !== undefined)
              ) {
                project = projectID;
                break;
              }
            }
          }
        }
      } catch {
        // Project discovery is best-effort upstream; retrieveUserQuota accepts an empty object.
      }
    }

    const response = await ctx.http.postJSON(quotaURL, {
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: project ? { project } : {},
    });
    if (isConsumerTierDeprecation(response.bodyText)) {
      throw ctx.fail.apiFailure(
        "Gemini CLI consumer tier is no longer supported; migrate to Antigravity.",
      );
    }
    status(ctx, "Gemini", response);
    const parsed = quotas(ctx, response.json);
    const pro = windowFor(
      ctx,
      parsed.filter((row) => row.model.toLowerCase().includes("pro")),
    );
    const flashLite = windowFor(
      ctx,
      parsed.filter((row) => row.model.toLowerCase().includes("flash-lite")),
    );
    const flash = windowFor(
      ctx,
      parsed.filter((row) => {
        const name = row.model.toLowerCase();
        return name.includes("flash") && !name.includes("flash-lite");
      }),
    );
    return {
      ...(pro ? { primary: pro } : {}),
      ...(flash ? { secondary: flash } : {}),
      ...(flashLite ? { tertiary: flashLite } : {}),
      identity: {
        ...(identityClaims.email ? { email: identityClaims.email } : {}),
        ...(accountPlan(tier, identityClaims.hostedDomain, paid)
          ? { loginMethod: accountPlan(tier, identityClaims.hostedDomain, paid) }
          : {}),
      },
    };
  },
};

const strategy: ProviderStrategy = {
  id: "gemini.api",
  kind: "api",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const gemini: FirstPartyProvider = { ...strategy, descriptor };
