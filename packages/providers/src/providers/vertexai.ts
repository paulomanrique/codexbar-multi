import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { object, status, string } from "./_http.ts";

const endpoint = "https://monitoring.googleapis.com/v3/projects";
const usageFilter =
  'metric.type="serviceruntime.googleapis.com/quota/allocation/usage" AND resource.type="consumer_quota" AND resource.label.service="aiplatform.googleapis.com"';
const limitFilter =
  'metric.type="serviceruntime.googleapis.com/quota/limit" AND resource.type="consumer_quota" AND resource.label.service="aiplatform.googleapis.com"';

type QuotaKey = `${string}\u0000${string}\u0000${string}`;

const secret = (ctx: ProviderContext, key: string): string | undefined =>
  ctx.settings.getSecret(key)?.trim() || ctx.settings.get(key)?.trim() || undefined;

const value = (raw: unknown): number | undefined => {
  const candidate = object(raw);
  const numeric = candidate?.doubleValue ?? candidate?.int64Value;
  const result =
    typeof numeric === "number" ? numeric : typeof numeric === "string" ? Number(numeric) : NaN;
  return Number.isFinite(result) ? result : undefined;
};

const aggregates = (series: readonly unknown[]): Map<QuotaKey, number> => {
  const result = new Map<QuotaKey, number>();
  for (const raw of series) {
    const entry = object(raw);
    const labels = object(object(entry?.metric)?.labels);
    const resource = object(entry?.resource);
    const resourceLabels = object(resource?.labels);
    const metric = string(labels?.quota_metric) || string(resourceLabels?.quota_id);
    if (!metric) continue;
    const limit = string(labels?.limit_name) ?? "";
    const location = string(resourceLabels?.location) ?? "global";
    const points = Array.isArray(entry?.points) ? entry.points : [];
    let maximum: number | undefined;
    for (const point of points) {
      const number = value(object(point)?.value);
      if (number !== undefined) maximum = Math.max(maximum ?? number, number);
    }
    if (maximum !== undefined) {
      const key: QuotaKey = `${metric}\u0000${limit}\u0000${location}`;
      result.set(key, Math.max(result.get(key) ?? maximum, maximum));
    }
  }
  return result;
};

const split = (key: QuotaKey): readonly [string, string, string] =>
  key.split("\u0000") as [string, string, string];

const usedPercent = (
  usage: Map<QuotaKey, number>,
  limits: Map<QuotaKey, number>,
): number | undefined => {
  let maximum: number | undefined;
  for (const [key, used] of usage) {
    let limit = limits.get(key);
    if (limit === undefined) {
      const [metric, namedLimit, location] = split(key);
      if (namedLimit === "") {
        const candidates = [...limits.entries()].filter(([candidate, candidateLimit]) => {
          const [candidateMetric, , candidateLocation] = split(candidate);
          return candidateLimit > 0 && candidateMetric === metric && candidateLocation === location;
        });
        if (candidates.length === 1) limit = candidates[0]?.[1];
      }
    }
    if (limit !== undefined && limit > 0) maximum = Math.max(maximum ?? 0, (used / limit) * 100);
  }
  return maximum;
};

const fetchSeries = async (
  ctx: ProviderContext,
  accessToken: string,
  project: string,
  filter: string,
): Promise<readonly unknown[]> => {
  const all: unknown[] = [];
  const end = ctx.date.now();
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1_000);
  let pageToken: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    const url = new URL(`${endpoint}/${encodeURIComponent(project)}/timeSeries`);
    url.searchParams.set("filter", filter);
    url.searchParams.set("interval.startTime", start.toISOString());
    url.searchParams.set("interval.endTime", end.toISOString());
    url.searchParams.set("aggregation.alignmentPeriod", "3600s");
    url.searchParams.set("aggregation.perSeriesAligner", "ALIGN_MAX");
    url.searchParams.set("view", "FULL");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await ctx.http.getJSON(url.href, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    status(ctx, "Vertex AI", response);
    const root = object(response.json);
    if (!root) throw ctx.fail.parseFailure("Vertex AI Monitoring response must be an object.");
    if (Array.isArray(root.timeSeries)) all.push(...root.timeSeries);
    pageToken = string(root.nextPageToken);
    if (!pageToken) return all;
  }
  throw ctx.fail.apiFailure("Vertex AI Monitoring pagination exceeded 100 pages.");
};

const definition: ProviderDefinition = {
  id: "vertexai",
  name: "Vertex AI",
  endpoints: ["https://monitoring.googleapis.com"],
  auth: { type: "bearer", secret: "VERTEX_AI_ACCESS_TOKEN" },
  settings: [
    { key: "VERTEX_AI_ACCESS_TOKEN", title: "OAuth access token", type: "secure" },
    { key: "VERTEX_AI_PROJECT_ID", title: "Google Cloud project", type: "plain" },
    { key: "VERTEX_AI_ACCOUNT_EMAIL", title: "Account email", type: "plain" },
  ],
  fetchUsage: async (ctx: ProviderContext) => {
    const accessToken = secret(ctx, "VERTEX_AI_ACCESS_TOKEN");
    if (!accessToken) {
      throw ctx.fail.missingCredential(
        "gcloud credentials not found. Run gcloud auth application-default login.",
      );
    }
    const project = ctx.settings.get("VERTEX_AI_PROJECT_ID")?.trim();
    if (!project)
      throw ctx.fail.apiFailure(
        "No Google Cloud project configured. Run gcloud config set project PROJECT_ID.",
      );
    const [usage, limits] = await Promise.all([
      fetchSeries(ctx, accessToken, project, usageFilter),
      fetchSeries(ctx, accessToken, project, limitFilter),
    ]);
    // Swift deliberately treats no Monitoring quota data as non-fatal: local Claude/Vertex token costs remain useful.
    void usedPercent(aggregates(usage), aggregates(limits));
    return {
      identity: {
        ...(ctx.settings.get("VERTEX_AI_ACCOUNT_EMAIL")?.trim()
          ? { email: ctx.settings.get("VERTEX_AI_ACCOUNT_EMAIL")?.trim() }
          : {}),
        organization: project,
        loginMethod: "gcloud",
      },
    };
  },
};

const strategy: ProviderStrategy = {
  id: "vertexai.oauth",
  kind: "api",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const vertexai: FirstPartyProvider = { ...strategy, descriptor };
