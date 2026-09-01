import type { ProviderBedrockAwsCredentials, ProviderContext } from "../types.ts";
import { number } from "./_http.ts";

export const BEDROCK_DEFAULT_REGION = "us-east-1";
export const BEDROCK_COST_EXPLORER_REGION = "us-east-1";
export const BEDROCK_COST_EXPLORER_URL = "https://ce.us-east-1.amazonaws.com";
export const BEDROCK_AUTH_MODE_KEY = "CODEXBAR_BEDROCK_AUTH_MODE";
export const BEDROCK_PROFILE_KEY = "AWS_PROFILE";
export const BEDROCK_ACCESS_KEY_ID_KEY = "AWS_ACCESS_KEY_ID";
export const BEDROCK_SECRET_ACCESS_KEY_KEY = "AWS_SECRET_ACCESS_KEY";
export const BEDROCK_SESSION_TOKEN_KEY = "AWS_SESSION_TOKEN";
export const BEDROCK_REGION_KEYS = ["AWS_REGION", "AWS_DEFAULT_REGION"] as const;
export const BEDROCK_BUDGET_KEYS = [
  "CODEXBAR_BEDROCK_BUDGET",
  "AWS_BEDROCK_MONTHLY_BUDGET",
] as const;
export const BEDROCK_API_URL_KEY = "CODEXBAR_BEDROCK_API_URL";
export const BEDROCK_CLOUDWATCH_API_URL_KEY = "CODEXBAR_BEDROCK_CLOUDWATCH_API_URL";
export const BEDROCK_MISSING_CREDENTIALS =
  "AWS credentials not configured. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY or configure Bedrock in Settings.";
export const BEDROCK_AWS_CLI_NOT_FOUND =
  "AWS CLI not found. Install the AWS CLI (v2) or set AWS_CLI_PATH to its location.";

export type BedrockAuthMode = "keys" | "profile";
export type BedrockAwsCredentials = {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
};
export type BedrockResolvedAuth = {
  readonly credentials: BedrockAwsCredentials;
  readonly region: string;
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

export const cleanedBedrockSetting = (raw: string | undefined): string | undefined => {
  if (raw === undefined) return undefined;
  let value = raw.trim();
  if (value.length === 0) return undefined;
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    value = value.slice(1, -1).trim();
  }
  return value.length === 0 ? undefined : value;
};

export const bedrockSetting = (ctx: ProviderContext, key: string): string | undefined =>
  cleanedBedrockSetting(ctx.settings.getSecret(key)) ??
  cleanedBedrockSetting(ctx.settings.get(key));

export const bedrockHasStaticKeys = (ctx: ProviderContext): boolean =>
  bedrockSetting(ctx, BEDROCK_ACCESS_KEY_ID_KEY) !== undefined &&
  bedrockSetting(ctx, BEDROCK_SECRET_ACCESS_KEY_KEY) !== undefined;

export const bedrockAuthMode = (ctx: ProviderContext): BedrockAuthMode => {
  const raw = bedrockSetting(ctx, BEDROCK_AUTH_MODE_KEY)?.toLowerCase();
  if (raw === "keys" || raw === "profile") return raw;
  if (bedrockSetting(ctx, BEDROCK_PROFILE_KEY) !== undefined && !bedrockHasStaticKeys(ctx))
    return "profile";
  return "keys";
};

export const bedrockExplicitRegion = (ctx: ProviderContext): string | undefined => {
  for (const key of BEDROCK_REGION_KEYS) {
    const value = bedrockSetting(ctx, key);
    if (value !== undefined) return value;
  }
  return undefined;
};

export const bedrockRegion = (ctx: ProviderContext): string =>
  bedrockExplicitRegion(ctx) ?? BEDROCK_DEFAULT_REGION;

export const bedrockBudget = (ctx: ProviderContext): number | undefined => {
  for (const key of BEDROCK_BUDGET_KEYS) {
    const value = number(bedrockSetting(ctx, key));
    if (value !== undefined && value > 0) return value;
  }
  return undefined;
};

export const bedrockProfileSessionExpiredMessage = (profile: string): string =>
  `AWS profile session expired. Run \`aws sso login --profile ${profile}\` and try again.`;

/** Reusable AWS Signature Version 4 request signer for Bedrock's AWS APIs. */
export const signBedrockAwsRequest = async (params: {
  readonly credentials: BedrockAwsCredentials;
  readonly service: string;
  readonly region: string;
  readonly url: URL;
  readonly body: unknown;
  readonly now: Date;
  readonly target: string;
  readonly contentType: string;
}): Promise<Record<string, string>> => {
  const body = JSON.stringify(params.body);
  const amzDate = awsDate(params.now);
  const stamp = dateStamp(params.now);
  const headers: Record<string, string> = {
    "Content-Type": params.contentType,
    Host: params.url.host,
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
  const path = params.url.pathname.split("/").map(awsEncode).join("/") || "/";
  const canonicalRequest = [
    "POST",
    path,
    canonicalQuery,
    `${canonicalHeaders.map(([key, value]) => `${key}:${value}`).join("\n")}\n`,
    signedHeaders,
    await digest(body),
  ].join("\n");
  const scope = `${stamp}/${params.region}/${params.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await digest(canonicalRequest)].join(
    "\n",
  );
  const kDate = await hmac(encoder.encode(`AWS4${params.credentials.secretAccessKey}`), stamp);
  const kRegion = await hmac(kDate, params.region);
  const kService = await hmac(kRegion, params.service);
  const kSigning = await hmac(kService, "aws4_request");
  const signature = await hmacHex(kSigning, stringToSign);
  return {
    ...headers,
    Authorization: `AWS4-HMAC-SHA256 Credential=${params.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
};

export const fromHostBedrockCredentials = (
  value: ProviderBedrockAwsCredentials,
): BedrockAwsCredentials => ({
  accessKeyId: value.accessKeyId,
  secretAccessKey: value.secretAccessKey,
  ...(value.sessionToken ? { sessionToken: value.sessionToken } : {}),
});

export const resolveBedrockCredentials = async (
  ctx: ProviderContext,
): Promise<BedrockResolvedAuth> => {
  switch (bedrockAuthMode(ctx)) {
    case "keys": {
      const accessKeyId = bedrockSetting(ctx, BEDROCK_ACCESS_KEY_ID_KEY);
      const secretAccessKey = bedrockSetting(ctx, BEDROCK_SECRET_ACCESS_KEY_KEY);
      if (accessKeyId === undefined || secretAccessKey === undefined)
        throw ctx.fail.missingCredential(BEDROCK_MISSING_CREDENTIALS);
      const sessionToken = bedrockSetting(ctx, BEDROCK_SESSION_TOKEN_KEY);
      return {
        credentials: {
          accessKeyId,
          secretAccessKey,
          ...(sessionToken === undefined ? {} : { sessionToken }),
        },
        region: bedrockRegion(ctx),
      };
    }
    case "profile": {
      const profile = bedrockSetting(ctx, BEDROCK_PROFILE_KEY);
      if (profile === undefined) throw ctx.fail.missingCredential(BEDROCK_MISSING_CREDENTIALS);
      if (ctx.local?.fetchBedrockAwsCredentials === undefined)
        throw ctx.fail.providerUnavailable(BEDROCK_AWS_CLI_NOT_FOUND);
      const accessKeyId = bedrockSetting(ctx, BEDROCK_ACCESS_KEY_ID_KEY);
      const secretAccessKey = bedrockSetting(ctx, BEDROCK_SECRET_ACCESS_KEY_KEY);
      const sessionToken = bedrockSetting(ctx, BEDROCK_SESSION_TOKEN_KEY);
      const region = bedrockSetting(ctx, "AWS_REGION");
      const defaultRegion = bedrockSetting(ctx, "AWS_DEFAULT_REGION");
      const sourceEnvironment = {
        ...(accessKeyId === undefined ? {} : { accessKeyId }),
        ...(secretAccessKey === undefined ? {} : { secretAccessKey }),
        ...(sessionToken === undefined ? {} : { sessionToken }),
        ...(region === undefined ? {} : { region }),
        ...(defaultRegion === undefined ? {} : { defaultRegion }),
      };
      const resolved = await ctx.local.fetchBedrockAwsCredentials({
        profile,
        ...(Object.keys(sourceEnvironment).length === 0 ? {} : { sourceEnvironment }),
      });
      return {
        credentials: fromHostBedrockCredentials(resolved),
        region:
          bedrockExplicitRegion(ctx) ??
          cleanedBedrockSetting(resolved.region) ??
          BEDROCK_DEFAULT_REGION,
      };
    }
  }
};
