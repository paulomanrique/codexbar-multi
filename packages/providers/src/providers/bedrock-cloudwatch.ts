import type { ProviderContext, ProviderJSONResponse } from "../types.ts";
import { object } from "./_http.ts";
import {
  type BedrockAwsCredentials,
  BEDROCK_CLOUDWATCH_API_URL_KEY,
  cleanedBedrockSetting,
  signBedrockAwsRequest,
} from "./bedrock-aws.ts";

export const BEDROCK_CLOUDWATCH_LOOKBACK_DAYS = 14;
export const BEDROCK_CLOUDWATCH_MAX_PAGES = 20;
export const BEDROCK_CLOUDWATCH_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const BEDROCK_CLOUDWATCH_TIMEOUT_SECONDS = 15;
export const BEDROCK_CLOUDWATCH_TARGET = "GraniteServiceVersion20100801.GetMetricData";
export const BEDROCK_CLOUDWATCH_CONTENT_TYPE = "application/x-amz-json-1.0";
export const BEDROCK_CLOUDWATCH_REGION_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)+-[0-9]+$/u;

export type BedrockClaudeActivity = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly requestCount: number;
};

type CloudWatchMetric = "inputTokens" | "outputTokens" | "requests";

const METRICS: readonly { readonly id: CloudWatchMetric; readonly cloudWatchName: string }[] = [
  { id: "inputTokens", cloudWatchName: "InputTokenCount" },
  { id: "outputTokens", cloudWatchName: "OutputTokenCount" },
  { id: "requests", cloudWatchName: "Invocations" },
];

const isLoopbackHost = (host: string): boolean =>
  host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/u.test(host);

export const bedrockCloudWatchPartitionSuffix = (region: string): string => {
  if (region.startsWith("cn-")) return "amazonaws.com.cn";
  if (region.startsWith("eusc-")) return "amazonaws.eu";
  if (region.startsWith("us-iso-")) return "c2s.ic.gov";
  if (region.startsWith("us-isob-")) return "sc2s.sgov.gov";
  if (region.startsWith("eu-isoe-")) return "cloud.adc-e.uk";
  if (region.startsWith("us-isof-")) return "csp.hci.ic.gov";
  return "amazonaws.com";
};

const overrideUrl = (raw: string): string | undefined => {
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

export const bedrockCloudWatchEndpoint = (region: string, override?: string): string => {
  if (override !== undefined) {
    const url = overrideUrl(override);
    if (url === undefined) throw new Error("invalid endpoint override");
    return url;
  }
  if (!BEDROCK_CLOUDWATCH_REGION_PATTERN.test(region)) throw new Error("invalid region endpoint");
  return `https://monitoring.${region}.${bedrockCloudWatchPartitionSuffix(region)}`;
};

const metricId = (value: unknown): CloudWatchMetric | undefined =>
  value === "inputTokens" || value === "outputTokens" || value === "requests" ? value : undefined;

const parseMetricValue = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new Error(
      typeof value === "number" ? "metric value was invalid" : "metric value was not numeric",
    );
  return value;
};

export const parseBedrockCloudWatchPage = (
  json: unknown,
): { readonly totals: Readonly<Record<CloudWatchMetric, number>>; readonly nextToken?: string } => {
  const root = object(json);
  if (root === undefined) throw new Error("invalid JSON response");
  if (Array.isArray(root.Messages) && root.Messages.length > 0)
    throw new Error("CloudWatch reported incomplete results");
  const results = Array.isArray(root.MetricDataResults) ? root.MetricDataResults : [];
  const totals: Record<CloudWatchMetric, number> = {
    inputTokens: 0,
    outputTokens: 0,
    requests: 0,
  };
  for (const raw of results) {
    const result = object(raw);
    if (result === undefined) throw new Error("metric result had an unknown ID");
    const id = metricId(result.Id);
    if (id === undefined) throw new Error("metric result had an unknown ID");
    if (result.StatusCode !== "Complete") throw new Error("metric result was incomplete");
    if (!Array.isArray(result.Values)) continue;
    for (const value of result.Values) totals[id] += parseMetricValue(value);
  }
  const nextToken = cleanedBedrockSetting(
    typeof root.NextToken === "string" ? root.NextToken : undefined,
  );
  return nextToken === undefined ? { totals } : { totals, nextToken };
};

const convertTotals = (
  totals: Readonly<Record<CloudWatchMetric, number>>,
): BedrockClaudeActivity => {
  const convert = (total: number): number => {
    if (!Number.isFinite(total) || total < 0 || total > Number.MAX_SAFE_INTEGER)
      throw new Error("invalid metric total");
    const rounded = Math.round(total);
    if (!Number.isSafeInteger(rounded) || rounded < 0) throw new Error("invalid metric total");
    return rounded;
  };
  return {
    inputTokens: convert(totals.inputTokens),
    outputTokens: convert(totals.outputTokens),
    requestCount: convert(totals.requests),
  };
};

const metricQueries = (): readonly Record<string, unknown>[] =>
  METRICS.map((metric) => ({
    Id: metric.id,
    Expression: `SUM(SEARCH('{AWS/Bedrock,ModelId} MetricName="${metric.cloudWatchName}" claude', 'Sum', 86400))`,
    ReturnData: true,
  }));

export const fetchBedrockCloudWatchActivity = async (params: {
  readonly ctx: ProviderContext;
  readonly credentials: BedrockAwsCredentials;
  readonly region: string;
  readonly now: Date;
  readonly endpointOverride?: string;
}): Promise<BedrockClaudeActivity> => {
  const endpoint = bedrockCloudWatchEndpoint(params.region, params.endpointOverride);
  const url = new URL(endpoint);
  const start = params.now.getTime() / 1000 - BEDROCK_CLOUDWATCH_LOOKBACK_DAYS * 24 * 60 * 60;
  const end = params.now.getTime() / 1000;
  const totals: Record<CloudWatchMetric, number> = {
    inputTokens: 0,
    outputTokens: 0,
    requests: 0,
  };
  let nextToken: string | undefined;
  const seenTokens = new Set<string>();
  let pageCount = 0;
  do {
    pageCount += 1;
    if (pageCount > BEDROCK_CLOUDWATCH_MAX_PAGES) throw new Error("too many response pages");
    const body: Record<string, unknown> = {
      StartTime: start,
      EndTime: end,
      ScanBy: "TimestampAscending",
      MetricDataQueries: metricQueries(),
      ...(nextToken === undefined ? {} : { NextToken: nextToken }),
    };
    const response: ProviderJSONResponse = await params.ctx.http.postJSON(url.href, {
      headers: await signBedrockAwsRequest({
        credentials: params.credentials,
        service: "monitoring",
        region: params.region,
        url,
        body,
        now: params.now,
        target: BEDROCK_CLOUDWATCH_TARGET,
        contentType: BEDROCK_CLOUDWATCH_CONTENT_TYPE,
      }),
      body,
      timeoutSeconds: BEDROCK_CLOUDWATCH_TIMEOUT_SECONDS,
    });
    if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
    if (response.bodyText.length > BEDROCK_CLOUDWATCH_MAX_RESPONSE_BYTES)
      throw new Error("response exceeds 4 MiB");
    const page = parseBedrockCloudWatchPage(response.json);
    totals.inputTokens += page.totals.inputTokens;
    totals.outputTokens += page.totals.outputTokens;
    totals.requests += page.totals.requests;
    nextToken = page.nextToken;
    if (nextToken !== undefined) {
      if (seenTokens.has(nextToken)) throw new Error("repeated NextToken");
      seenTokens.add(nextToken);
    }
  } while (nextToken !== undefined);
  return convertTotals(totals);
};

export const bedrockCloudWatchOverride = (ctx: ProviderContext): string | undefined =>
  ctx.settings.get(BEDROCK_CLOUDWATCH_API_URL_KEY);
