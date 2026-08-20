import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { date, number, object, status, string } from "./_http.ts";

const GRAPHQL_QUERY = `query GetRequestLimitInfo($requestContext: RequestContext!) {
  user(requestContext: $requestContext) { __typename ... on UserOutput { user {
    requestLimitInfo { isUnlimited nextRefreshTime requestLimit requestsUsedSinceLastRefresh }
    bonusGrants { requestCreditsGranted requestCreditsRemaining expiration }
    workspaces { bonusGrantsInfo { grants { requestCreditsGranted requestCreditsRemaining expiration } } }
  } } }
}`;
const integer = (raw: unknown): number => Math.trunc(number(raw) ?? 0);
const bool = (raw: unknown): boolean => {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw !== 0;
  if (typeof raw === "string") return ["true", "1", "yes"].includes(raw.trim().toLowerCase());
  return false;
};
const graphQLError = (raw: unknown): string | undefined => {
  if (typeof raw === "string") return raw.trim() || undefined;
  const value = object(raw);
  return string(value?.message);
};

type Grant = { readonly granted: number; readonly remaining: number; readonly expiration?: string };
function parse(raw: unknown, ctx: ProviderContext): Record<string, unknown> {
  const root = object(raw);
  if (!root) throw ctx.fail.parseFailure("Warp response root must be an object.");
  if (Array.isArray(root.errors) && root.errors.length) {
    const message = root.errors
      .map(graphQLError)
      .filter((entry): entry is string => Boolean(entry))
      .slice(0, 3)
      .join(" | ");
    throw ctx.fail.apiFailure(message || "Warp GraphQL request failed.");
  }
  const data = object(root.data);
  const user = object(data?.user);
  const typeName = string(user?.__typename);
  if (typeName && typeName !== "UserOutput")
    throw ctx.fail.parseFailure(`Unexpected user type '${typeName}'.`);
  const inner = object(user?.user);
  const info = object(inner?.requestLimitInfo);
  if (!info) throw ctx.fail.parseFailure("Unable to extract requestLimitInfo from response.");
  const unlimited = bool(info.isUnlimited);
  const limit = integer(info.requestLimit);
  const used = integer(info.requestsUsedSinceLastRefresh);
  const grants: Grant[] = [];
  const collect = (rawGrant: unknown) => {
    const grant = object(rawGrant);
    if (!grant) return;
    const expiration = date(grant.expiration, ctx);
    grants.push({
      granted: integer(grant.requestCreditsGranted),
      remaining: integer(grant.requestCreditsRemaining),
      ...(expiration ? { expiration } : {}),
    });
  };
  if (Array.isArray(inner?.bonusGrants)) inner.bonusGrants.forEach(collect);
  if (Array.isArray(inner?.workspaces))
    for (const rawWorkspace of inner.workspaces) {
      const workspace = object(rawWorkspace);
      const infoObject = object(workspace?.bonusGrantsInfo);
      if (Array.isArray(infoObject?.grants)) infoObject.grants.forEach(collect);
    }
  const total = grants.reduce((sum, grant) => sum + grant.granted, 0);
  const remaining = grants.reduce((sum, grant) => sum + grant.remaining, 0);
  const expiring = grants
    .filter(
      (grant): grant is Grant & { expiration: string } =>
        grant.remaining > 0 && Boolean(grant.expiration),
    )
    .sort((a, b) => Date.parse(a.expiration) - Date.parse(b.expiration));
  const earliest = expiring[0]?.expiration;
  const earliestRemaining = earliest
    ? expiring
        .filter((grant) => grant.expiration === earliest)
        .reduce((sum, grant) => sum + grant.remaining, 0)
    : 0;
  const result: Record<string, unknown> = { identity: {} };
  result.primary = {
    usedPercent: unlimited ? 0 : limit > 0 ? Math.max(0, Math.min(100, (used / limit) * 100)) : 0,
    ...(unlimited
      ? {}
      : date(info.nextRefreshTime, ctx)
        ? { resetsAt: date(info.nextRefreshTime, ctx) }
        : {}),
    resetDescription: unlimited ? "Unlimited" : `${used}/${limit} credits`,
  };
  if (total > 0 || remaining > 0 || earliestRemaining > 0) {
    const detail =
      earliest && earliestRemaining > 0
        ? `${earliestRemaining} credits expires on ${earliest}`
        : undefined;
    result.secondary = {
      usedPercent:
        total > 0
          ? Math.max(0, Math.min(100, ((total - remaining) / total) * 100))
          : remaining > 0
            ? 0
            : 100,
      ...(detail ? { resetDescription: detail } : {}),
    };
  }
  return result;
}

const definition: ProviderDefinition = {
  id: "warp",
  name: "Warp",
  endpoints: ["https://app.warp.dev"],
  auth: { type: "bearer", secret: "WARP_API_KEY" },
  settings: [
    { key: "WARP_API_KEY", title: "API key", type: "secure" },
    { key: "WARP_TOKEN", title: "Legacy API token", type: "secure" },
  ],
  fetchUsage: async (ctx) => {
    const key =
      ctx.settings.getSecret("WARP_API_KEY") ||
      ctx.settings.getSecret("WARP_TOKEN") ||
      ctx.settings.get("WARP_API_KEY") ||
      ctx.settings.get("WARP_TOKEN");
    if (!key?.trim()) throw ctx.fail.missingCredential("Missing Warp API key.");
    const requestContext = {
      clientContext: {},
      osContext: { category: "desktop", name: "CodexBar Multi", version: "1.0" },
    };
    const response = await ctx.http.postJSON(
      "https://app.warp.dev/graphql/v2?op=GetRequestLimitInfo",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key.trim()}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "x-warp-client-id": "warp-app",
          "x-warp-os-category": "desktop",
          "x-warp-os-name": "CodexBar Multi",
          "x-warp-os-version": "1.0",
          "User-Agent": "Warp/1.0",
        },
        body: {
          query: GRAPHQL_QUERY,
          variables: { requestContext },
          operationName: "GetRequestLimitInfo",
        },
      },
    );
    status(ctx, "Warp", response);
    return parse(response.json, ctx);
  },
};
const strategy: ProviderStrategy = {
  id: "warp.api",
  kind: "api",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const warp: FirstPartyProvider = { ...strategy, descriptor };
