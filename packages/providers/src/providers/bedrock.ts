import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { number, object, status, string } from "./_http.ts";

type Credentials = {
  readonly accessKey: string;
  readonly secretKey: string;
  readonly sessionToken?: string;
};

const encoder = new TextEncoder();
const hex = (value: ArrayBuffer): string =>
  [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const digest = async (value: string): Promise<string> =>
  hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
const hmac = async (key: Uint8Array, value: string): Promise<Uint8Array> =>
  new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      await crypto.subtle.importKey(
        "raw",
        key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) as ArrayBuffer,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      ),
      encoder.encode(value),
    ),
  );
const hmacHex = async (key: Uint8Array, value: string): Promise<string> =>
  hex((await hmac(key, value)).buffer as ArrayBuffer);
const awsEncode = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
const awsDate = (value: Date) =>
  value
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d{3}/u, "");
const dateStamp = (value: Date) => awsDate(value).slice(0, 8);

const credentials = (ctx: ProviderContext): Credentials => {
  const accessKey =
    ctx.settings.getSecret("AWS_ACCESS_KEY_ID")?.trim() ||
    ctx.settings.get("AWS_ACCESS_KEY_ID")?.trim();
  const secretKey =
    ctx.settings.getSecret("AWS_SECRET_ACCESS_KEY")?.trim() ||
    ctx.settings.get("AWS_SECRET_ACCESS_KEY")?.trim();
  const sessionToken =
    ctx.settings.getSecret("AWS_SESSION_TOKEN")?.trim() ||
    ctx.settings.get("AWS_SESSION_TOKEN")?.trim();
  if (!accessKey || !secretKey) {
    throw ctx.fail.missingCredential(
      "AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are required for Bedrock.",
    );
  }
  return { accessKey, secretKey, ...(sessionToken ? { sessionToken } : {}) };
};

const sign = async (params: {
  readonly credentials: Credentials;
  readonly service: string;
  readonly region: string;
  readonly url: URL;
  readonly body: unknown;
  readonly now: Date;
  readonly target: string;
}): Promise<Record<string, string>> => {
  const body = JSON.stringify(params.body);
  const amzDate = awsDate(params.now);
  const stamp = dateStamp(params.now);
  const host = params.url.host;
  const headers: Record<string, string> = {
    "Content-Type": "application/x-amz-json-1.1",
    Host: host,
    "X-Amz-Date": amzDate,
    "X-Amz-Target": params.target,
    "x-amz-content-sha256": await digest(body),
  };
  if (params.credentials.sessionToken)
    headers["X-Amz-Security-Token"] = params.credentials.sessionToken;
  const canonicalHeaders = Object.entries(headers)
    .map(([key, value]) => [key.toLowerCase(), value.trim().replace(/\s+/gu, " ")] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  const signedHeaders = canonicalHeaders.map(([key]) => key).join(";");
  const canonicalQuery = [...params.url.searchParams.entries()]
    .map(([key, value]) => `${awsEncode(key)}=${awsEncode(value)}`)
    .sort()
    .join("&");
  const canonicalRequest = [
    "POST",
    params.url.pathname.split("/").map(awsEncode).join("/") || "/",
    canonicalQuery,
    `${canonicalHeaders.map(([key, value]) => `${key}:${value}`).join("\n")}\n`,
    signedHeaders,
    await digest(body),
  ].join("\n");
  const scope = `${stamp}/${params.region}/${params.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await digest(canonicalRequest)].join(
    "\n",
  );
  const kDate = await hmac(encoder.encode(`AWS4${params.credentials.secretKey}`), stamp);
  const kRegion = await hmac(kDate, params.region);
  const kService = await hmac(kRegion, params.service);
  const kSigning = await hmac(kService, "aws4_request");
  const signature = await hmacHex(kSigning, stringToSign);
  return {
    ...headers,
    Authorization: `AWS4-HMAC-SHA256 Credential=${params.credentials.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
};

const monthRange = (now: Date) => {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
    resetsAt: end.toISOString(),
  };
};
const money = (value: unknown) => number(object(value)?.Amount) ?? 0;
const isBedrock = (value: unknown) => string(value)?.toLowerCase().includes("bedrock") === true;
const cost = (root: Record<string, unknown>): number => {
  const rows = Array.isArray(root.ResultsByTime) ? root.ResultsByTime : [];
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

const definition: ProviderDefinition = {
  id: "bedrock",
  name: "AWS Bedrock",
  endpoints: ["https://ce.us-east-1.amazonaws.com"],
  auth: { type: "provider-managed", secret: "AWS_ACCESS_KEY_ID" },
  settings: [
    { key: "AWS_ACCESS_KEY_ID", title: "AWS access key ID", type: "secure" },
    { key: "AWS_SECRET_ACCESS_KEY", title: "AWS secret access key", type: "secure" },
    { key: "AWS_SESSION_TOKEN", title: "AWS session token", type: "secure" },
    { key: "AWS_REGION", title: "AWS region", type: "plain" },
    { key: "AWS_BEDROCK_MONTHLY_BUDGET", title: "Monthly budget (USD)", type: "plain" },
  ],
  fetchUsage: async (ctx: ProviderContext) => {
    const auth = credentials(ctx);
    const now = ctx.date.now();
    const range = monthRange(now);
    const body = {
      TimePeriod: { Start: range.start, End: range.end },
      Granularity: "MONTHLY",
      Metrics: ["UnblendedCost"],
      GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
    };
    const url = new URL("https://ce.us-east-1.amazonaws.com");
    const response = await ctx.http.postJSON(url.href, {
      headers: await sign({
        credentials: auth,
        service: "ce",
        region: "us-east-1",
        url,
        body,
        now,
        target: "AWSInsightsIndexService.GetCostAndUsage",
      }),
      body,
    });
    status(ctx, "AWS Cost Explorer", response);
    const root = object(response.json);
    if (!root) throw ctx.fail.parseFailure("AWS Cost Explorer response must be an object.");
    const used = cost(root);
    const budget = number(ctx.settings.get("AWS_BEDROCK_MONTHLY_BUDGET"));
    const login = [`Spend: $${used.toFixed(2)}`];
    if (budget !== undefined && budget > 0) login.push(`Budget: $${budget.toFixed(2)}`);
    return {
      ...(budget !== undefined && budget > 0
        ? {
            primary: {
              usedPercent: ctx.pct(used, budget),
              resetsAt: range.resetsAt,
              resetDescription: "Monthly budget",
            },
          }
        : {}),
      cost: {
        used,
        limit: budget && budget > 0 ? budget : 0,
        currency: "USD",
        period: "Monthly",
        resetsAt: range.resetsAt,
      },
      identity: { loginMethod: login.join(" - ") },
    };
  },
};

const strategy: ProviderStrategy = {
  id: "bedrock.api",
  kind: "api",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const bedrock: FirstPartyProvider = { ...strategy, descriptor };
