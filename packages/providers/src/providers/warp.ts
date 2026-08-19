import type {
  FirstPartyProvider,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { date, get, json, number, object, status } from "./_http.ts";
const definition: ProviderDefinition = {
  id: "warp",
  name: "Warp",
  endpoints: ["https://app.warp.dev"],
  auth: { type: "bearer", secret: "WARP_API_KEY" },
  settings: [{ key: "WARP_API_KEY", title: "API key", type: "secure" }],
  fetchUsage: async (ctx) => {
    const key = ctx.settings.getSecret("WARP_API_KEY") || ctx.settings.get("WARP_API_KEY");
    if (!key) throw ctx.fail.missingCredential("Missing Warp API key.");
    const query = `query GetRequestLimitInfo { user(requestContext: { clientContext: {}, osContext: { category: "macOS", name: "macOS", version: "1.0" } }) { __typename ... on UserOutput { user { requestLimitInfo { isUnlimited nextRefreshTime requestLimit requestsUsedSinceLastRefresh } bonusGrants { requestCreditsGranted requestCreditsRemaining expiration } workspaces { bonusGrantsInfo { grants { requestCreditsGranted requestCreditsRemaining expiration } } } } } } }`;
    const response = await get(ctx, "https://app.warp.dev/graphql/v2?op=GetRequestLimitInfo", {
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "x-warp-client-id": "warp-app",
        "User-Agent": "Warp/1.0",
      },
      method: "POST",
      body: { query, operationName: "GetRequestLimitInfo", variables: {} },
    });
    status(ctx, "Warp", response);
    const root = object(json(ctx, "Warp", response));
    const data = object(root?.data);
    const user = object(data?.user);
    const inner = object(user?.user);
    const info = object(inner?.requestLimitInfo);
    if (!info) throw ctx.fail.parseFailure("Warp response is missing requestLimitInfo.");
    const limit = number(info.requestLimit) ?? 0;
    const used = number(info.requestsUsedSinceLastRefresh) ?? 0;
    const unlimited = info.isUnlimited === true;
    let granted = 0;
    let remaining = 0;
    let expiry: string | undefined;
    const grants = [
      ...(Array.isArray(inner?.bonusGrants) ? inner.bonusGrants : []),
      ...(Array.isArray(inner?.workspaces) ? inner.workspaces : []).flatMap((w) => {
        const wo = object(w);
        const bi = object(wo?.bonusGrantsInfo);
        return Array.isArray(bi?.grants) ? bi.grants : [];
      }),
    ];
    for (const raw of grants) {
      const g = object(raw);
      granted += number(g?.requestCreditsGranted) ?? 0;
      remaining += number(g?.requestCreditsRemaining) ?? 0;
      const d = date(g?.expiration, ctx);
      if (d && (!expiry || d < expiry)) expiry = d;
    }
    return {
      primary: {
        usedPercent: unlimited ? 0 : limit > 0 ? (used / limit) * 100 : 0,
        resetsAt: unlimited ? undefined : date(info.nextRefreshTime, ctx),
        resetDescription: unlimited ? "Unlimited" : `${used}/${limit} credits`,
      },
      ...(granted || remaining
        ? {
            secondary: {
              usedPercent: granted > 0 ? ((granted - remaining) / granted) * 100 : 0,
              resetDescription: expiry ? `${remaining} credits expires on ${expiry}` : undefined,
            },
          }
        : {}),
      identity: {},
    };
  },
};
const strategy: ProviderStrategy = {
  id: "warp.api",
  kind: "api",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const warp: FirstPartyProvider = { ...strategy, descriptor };
