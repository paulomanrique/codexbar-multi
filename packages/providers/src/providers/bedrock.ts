import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderSnapshot,
  ProviderStrategy,
} from "../types.ts";
import { number, object, status, string } from "./_http.ts";
import {
  BEDROCK_API_URL_KEY,
  BEDROCK_COST_EXPLORER_REGION,
  BEDROCK_COST_EXPLORER_URL,
  type BedrockAwsCredentials,
  bedrockBudget,
  cleanedBedrockSetting,
  resolveBedrockCredentials,
  signBedrockAwsRequest,
} from "./bedrock-aws.ts";
import {
  type BedrockClaudeActivity,
  bedrockCloudWatchOverride,
  fetchBedrockCloudWatchActivity,
} from "./bedrock-cloudwatch.ts";

export {
  BEDROCK_AWS_CLI_NOT_FOUND,
  BEDROCK_DEFAULT_REGION,
  BEDROCK_MISSING_CREDENTIALS,
  bedrockAuthMode,
  bedrockBudget,
  bedrockProfileSessionExpiredMessage,
  bedrockRegion,
  resolveBedrockCredentials,
  signBedrockAwsRequest,
} from "./bedrock-aws.ts";
export {
  BEDROCK_CLOUDWATCH_LOOKBACK_DAYS,
  BEDROCK_CLOUDWATCH_MAX_PAGES,
  BEDROCK_CLOUDWATCH_TARGET,
  bedrockCloudWatchEndpoint,
  bedrockCloudWatchPartitionSuffix,
  fetchBedrockCloudWatchActivity,
  parseBedrockCloudWatchPage,
} from "./bedrock-cloudwatch.ts";

const COST_EXPLORER_CONTENT_TYPE = "application/x-amz-json-1.1";
const COST_EXPLORER_TARGET = "AWSInsightsIndexService.GetCostAndUsage";
const COST_EXPLORER_TIMEOUT_SECONDS = 15;

const isLoopbackHost = (host: string): boolean =>
  host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/u.test(host);

const overrideUrl = (raw: string | undefined): string | undefined => {
  const value = cleanedBedrockSetting(raw);
  if (value === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.username !== "" || url.password !== "" || url.hostname.includes("%")) return undefined;
  if (url.protocol === "https:") return url.href;
  if (url.protocol === "http:" && isLoopbackHost(url.hostname.toLowerCase())) return url.href;
  return undefined;
};

const costExplorerUrl = (ctx: ProviderContext): string => {
  const raw = ctx.settings.get(BEDROCK_API_URL_KEY);
  if (raw === undefined) return BEDROCK_COST_EXPLORER_URL;
  const url = overrideUrl(raw);
  if (url === undefined) throw ctx.fail.parseFailure("invalid endpoint override");
  return url;
};

const monthRange = (now: Date) => {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
    resetsAt: reset.toISOString(),
  };
};

const money = (value: unknown) => number(object(value)?.Amount) ?? 0;
const isBedrock = (value: unknown) => string(value)?.toLowerCase().includes("bedrock") === true;
const cost = (ctx: ProviderContext, root: Record<string, unknown>): number => {
  if (!Array.isArray(root.ResultsByTime)) {
    throw ctx.fail.parseFailure("Missing ResultsByTime in Cost Explorer response");
  }
  const rows = root.ResultsByTime;
  return rows.reduce((total, raw) => {
    const row = object(raw);
    const groups = Array.isArray(row?.Groups) ? row.Groups : [];
    return (
      total +
      groups.reduce((subtotal, group) => {
        const item = object(group);
        const keys = Array.isArray(item?.Keys) ? item.Keys : [];
        return isBedrock(keys[0])
          ? subtotal + money(object(item?.Metrics)?.UnblendedCost)
          : subtotal;
      }, 0)
    );
  }, 0);
};

const costExplorerNextPageToken = (root: Record<string, unknown>): string | undefined =>
  typeof root.NextPageToken === "string" ? cleanedBedrockSetting(root.NextPageToken) : undefined;

const isCostExplorerDataUnavailable = (response: {
  readonly status: number;
  readonly json: unknown;
}): boolean => {
  if (response.status !== 400) return false;
  const root = object(response.json);
  if (root === undefined) return false;
  const nested = object(root.Error);
  const candidates = [root.__type, root.code, root.Code, nested?.Code];
  return candidates.some(
    (value) => typeof value === "string" && value.split("#").at(-1) === "DataUnavailableException",
  );
};

const cancelled = (error: unknown): boolean =>
  (error instanceof Error ||
    (typeof DOMException !== "undefined" && error instanceof DOMException)) &&
  (error.name === "AbortError" ||
    error.name === "CanceledError" ||
    /abort|cancel/iu.test(error.name));

const formattedTokenCount = (count: number): string => {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}K`;
  return `${count}`;
};

const snapshot = (params: {
  readonly ctx: ProviderContext;
  readonly used: number;
  readonly budget: number | undefined;
  readonly activity: BedrockClaudeActivity | undefined;
  readonly resetsAt: string;
}): ProviderSnapshot => {
  const login = [`Spend: $${params.used.toFixed(2)}`];
  if (params.budget !== undefined) login.push(`Budget: $${params.budget.toFixed(2)}`);
  if (params.activity !== undefined) {
    login.push(
      `Claude 14d: ${formattedTokenCount(params.activity.inputTokens + params.activity.outputTokens)} tokens`,
    );
    login.push(`Requests: ${formattedTokenCount(params.activity.requestCount)}`);
  }
  return {
    ...(params.budget !== undefined
      ? {
          primary: {
            usedPercent: params.ctx.pct(params.used, params.budget),
            resetsAt: params.resetsAt,
            resetDescription: "Monthly budget",
          },
        }
      : {}),
    cost: {
      used: params.used,
      limit: params.budget ?? 0,
      currency: "USD",
      period: "Monthly",
      resetsAt: params.resetsAt,
    },
    identity: { loginMethod: login.join(" - ") },
  };
};

const fetchMonthlyCost = async (
  ctx: ProviderContext,
  credentials: BedrockAwsCredentials,
  now: Date,
): Promise<number> => {
  const range = monthRange(now);
  const url = new URL(costExplorerUrl(ctx));
  const seenPageTokens = new Set<string>();
  let nextPageToken: string | undefined;
  let used = 0;
  do {
    const body = {
      TimePeriod: { Start: range.start, End: range.end },
      Granularity: "MONTHLY",
      Metrics: ["UnblendedCost"],
      GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
      ...(nextPageToken === undefined ? {} : { NextPageToken: nextPageToken }),
    };
    const response = await ctx.http.postJSON(url.href, {
      headers: await signBedrockAwsRequest({
        credentials,
        service: "ce",
        region: BEDROCK_COST_EXPLORER_REGION,
        url,
        body,
        now,
        target: COST_EXPLORER_TARGET,
        contentType: COST_EXPLORER_CONTENT_TYPE,
      }),
      body,
      timeoutSeconds: COST_EXPLORER_TIMEOUT_SECONDS,
    });
    if (isCostExplorerDataUnavailable(response)) return used;
    status(ctx, "AWS Cost Explorer", response);
    const root = object(response.json);
    if (!root) throw ctx.fail.parseFailure("AWS Cost Explorer response must be an object.");
    used += cost(ctx, root);
    nextPageToken = costExplorerNextPageToken(root);
    if (nextPageToken !== undefined) {
      if (seenPageTokens.has(nextPageToken)) {
        throw ctx.fail.parseFailure("Cost Explorer returned repeated NextPageToken");
      }
      seenPageTokens.add(nextPageToken);
    }
  } while (nextPageToken !== undefined);
  return used;
};

const shouldFetchCloudWatch = (ctx: ProviderContext): boolean =>
  ctx.settings.get(BEDROCK_API_URL_KEY) === undefined ||
  bedrockCloudWatchOverride(ctx) !== undefined;

const fetchClaudeActivity = async (params: {
  readonly ctx: ProviderContext;
  readonly credentials: BedrockAwsCredentials;
  readonly region: string;
  readonly now: Date;
}): Promise<BedrockClaudeActivity | undefined> => {
  if (!shouldFetchCloudWatch(params.ctx)) return undefined;
  try {
    const endpointOverride = bedrockCloudWatchOverride(params.ctx);
    return await fetchBedrockCloudWatchActivity({
      ctx: params.ctx,
      credentials: params.credentials,
      region: params.region,
      now: params.now,
      ...(endpointOverride === undefined ? {} : { endpointOverride }),
    });
  } catch (error) {
    if (cancelled(error)) throw error;
    return undefined;
  }
};

const definition: ProviderDefinition = {
  id: "bedrock",
  name: "AWS Bedrock",
  endpoints: [
    BEDROCK_COST_EXPLORER_URL,
    { setting: BEDROCK_API_URL_KEY, policy: "https-or-loopback-http" },
    { setting: "CODEXBAR_BEDROCK_CLOUDWATCH_API_URL", policy: "https-or-loopback-http" },
    { domainSuffix: "amazonaws.com", policy: "https" },
    { domainSuffix: "amazonaws.com.cn", policy: "https" },
    { domainSuffix: "amazonaws.eu", policy: "https" },
    { domainSuffix: "c2s.ic.gov", policy: "https" },
    { domainSuffix: "sc2s.sgov.gov", policy: "https" },
    { domainSuffix: "cloud.adc-e.uk", policy: "https" },
    { domainSuffix: "csp.hci.ic.gov", policy: "https" },
  ],
  auth: { type: "provider-managed", secret: "AWS_ACCESS_KEY_ID" },
  settings: [
    { key: "AWS_ACCESS_KEY_ID", title: "AWS access key ID", type: "secure" },
    { key: "AWS_SECRET_ACCESS_KEY", title: "AWS secret access key", type: "secure" },
    { key: "AWS_SESSION_TOKEN", title: "AWS session token", type: "secure" },
    { key: "AWS_PROFILE", title: "AWS profile", type: "plain" },
    { key: "CODEXBAR_BEDROCK_AUTH_MODE", title: "AWS auth mode", type: "plain" },
    { key: "AWS_REGION", title: "AWS region", type: "plain" },
    { key: "AWS_DEFAULT_REGION", title: "AWS default region", type: "plain" },
    { key: "CODEXBAR_BEDROCK_BUDGET", title: "Monthly budget (USD)", type: "plain" },
    { key: "AWS_BEDROCK_MONTHLY_BUDGET", title: "Monthly budget (USD)", type: "plain" },
    { key: "CODEXBAR_BEDROCK_API_URL", title: "Cost Explorer endpoint override", type: "plain" },
    {
      key: "CODEXBAR_BEDROCK_CLOUDWATCH_API_URL",
      title: "CloudWatch endpoint override",
      type: "plain",
    },
  ],
  fetchUsage: async (ctx: ProviderContext) => {
    const resolved = await resolveBedrockCredentials(ctx);
    const now = ctx.date.now();
    const used = await fetchMonthlyCost(ctx, resolved.credentials, now);
    const activity = await fetchClaudeActivity({
      ctx,
      credentials: resolved.credentials,
      region: resolved.region,
      now,
    });
    return snapshot({
      ctx,
      used,
      budget: bedrockBudget(ctx),
      activity,
      resetsAt: monthRange(now).resetsAt,
    });
  },
};

const strategy: ProviderStrategy = {
  id: "bedrock.api",
  kind: "api",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const bedrock: FirstPartyProvider = { ...strategy, descriptor };
