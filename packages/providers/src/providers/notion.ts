import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { number, object, status, string } from "./_http.ts";

type Workspace = { readonly id: string; readonly name?: string; readonly tier?: string };
const clean = (value: string | undefined) => value?.trim() || undefined;
const unwrap = (value: unknown): Record<string, unknown> | undefined => {
  const outer = object(value);
  const inner = object(outer?.value);
  return object(inner?.value) ?? inner ?? outer;
};
const cookie = async (ctx: ProviderContext) => {
  const raw =
    clean(ctx.settings.getSecret("NOTION_COOKIE")) ??
    clean(ctx.settings.get("NOTION_COOKIE")) ??
    clean(await ctx.browser.cookieHeader("app.notion.com"));
  if (!raw) return undefined;
  return /(?:^|;\s*)[^=]+=/.test(raw) ? raw : `token_v2=${raw}`;
};
const account = (ctx: ProviderContext, raw: unknown) => {
  const root = object(raw);
  if (!root) throw ctx.fail.parseFailure("getSpaces response is not a JSON object.");
  const candidates = Object.entries(root).filter(
    ([, value]) => object(value)?.notion_user !== undefined,
  );
  const identified = candidates.filter(
    ([id, value]) =>
      string(unwrap(object(value)?.notion_user && object(object(value)?.notion_user)?.[id])?.id) ===
      id,
  );
  const pair =
    identified.length === 1 ? identified[0] : candidates.length === 1 ? candidates[0] : undefined;
  if (!pair) throw ctx.fail.parseFailure("getSpaces response did not identify a single user.");
  const [userID, containerRaw] = pair;
  const container = object(containerRaw) as Record<string, unknown>;
  const users = object(container.notion_user);
  const user = unwrap(users?.[userID]);
  const spaces = object(container.space);
  const workspaces: Workspace[] = Object.entries(spaces ?? {}).map(([key, value]) => {
    const row = unwrap(value);
    const name = string(row?.name);
    const tier = string(row?.subscription_tier)?.toLowerCase();
    return {
      id: string(row?.id) ?? key,
      ...(name ? { name } : {}),
      ...(tier ? { tier } : {}),
    };
  });
  return { userID, email: string(user?.email), workspaces };
};
const minutes = (raw: string | undefined) => {
  const match = /^(\d+)([mhdw])$/iu.exec(raw?.trim() ?? "");
  if (!match) return undefined;
  const value = Number(match[1]);
  return match[2]?.toLowerCase() === "m"
    ? value
    : match[2]?.toLowerCase() === "h"
      ? value * 60
      : match[2]?.toLowerCase() === "d"
        ? value * 1_440
        : value * 10_080;
};
const post = async (
  ctx: ProviderContext,
  endpoint: string,
  body: Record<string, string>,
  header: string,
) => {
  const response = await ctx.http.postJSON(`https://app.notion.com/api/v3/${endpoint}`, {
    body,
    headers: {
      Cookie: header,
      "Content-Type": "application/json",
      Accept: "*/*",
      Origin: "https://app.notion.com",
      Referer: "https://app.notion.com/",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
    },
  });
  status(ctx, "Notion", response);
  return response.json as unknown;
};
const definition: ProviderDefinition = {
  id: "notion",
  name: "Notion",
  endpoints: ["https://app.notion.com"],
  settings: [
    { key: "NOTION_COOKIE", title: "Cookie header", type: "secure" },
    { key: "NOTION_WORKSPACE_ID", title: "Workspace ID", type: "plain" },
  ],
  capabilities: ["browser-cookies"],
  cookieDomains: ["app.notion.com", "www.notion.com", "notion.com", "notion.so"],
  fetchUsage: async (ctx) => {
    const header = await cookie(ctx);
    if (!header) throw ctx.fail.missingCredential("Notion cookie is not configured.");
    const profile = account(ctx, await post(ctx, "getSpaces", {}, header));
    const preferred = clean(ctx.settings.get("NOTION_WORKSPACE_ID"))
      ?.replaceAll("-", "")
      .toLowerCase();
    const workspace =
      profile.workspaces.find((row) => row.id.replaceAll("-", "").toLowerCase() === preferred) ??
      profile.workspaces.find((row) => row.tier === "business" || row.tier === "enterprise") ??
      profile.workspaces[0];
    if (!workspace) throw ctx.fail.apiFailure("No Notion workspace found for this account.");
    const rate = object(
      await post(ctx, "getCreditRateLimitStatus", { spaceId: workspace.id }, header),
    );
    if (!rate) throw ctx.fail.parseFailure("getCreditRateLimitStatus response is not an object.");
    if (string(rate.status)?.toLowerCase() === "not_applicable")
      throw ctx.fail.apiFailure(
        `Notion AI usage allowance is not tracked for ${workspace.name ?? "this workspace"}.`,
      );
    const rolling = object(rate.window);
    const billing = object(rate.billingPeriodWindow);
    if (!rolling && !billing)
      throw ctx.fail.parseFailure("getCreditRateLimitStatus returned no usage windows.");
    const rollingUsed = number(rolling?.used);
    const rollingLimit = number(rolling?.limit);
    const billingUsed = number(billing?.used);
    const billingLimit = number(billing?.limit);
    const resetSeconds = number(rate.resetsInSeconds);
    const rollingMinutes = minutes(string(rolling?.window));
    const primary =
      rollingUsed !== undefined && rollingLimit && rollingLimit > 0
        ? {
            usedPercent: Math.max(0, ctx.pct(rollingUsed, rollingLimit)),
            ...(rollingMinutes && rollingMinutes !== 43_200
              ? { windowMinutes: rollingMinutes }
              : {}),
            ...(resetSeconds !== undefined && resetSeconds >= 0
              ? { resetsAt: new Date(ctx.date.nowMillis() + resetSeconds * 1_000).toISOString() }
              : {}),
          }
        : undefined;
    const periodEnd = number(billing?.periodEndMs);
    const secondary =
      billingUsed !== undefined && billingLimit && billingLimit > 0
        ? {
            usedPercent: Math.max(0, ctx.pct(billingUsed, billingLimit)),
            windowMinutes: 43_200,
            ...(periodEnd && periodEnd > 0 ? { resetsAt: ctx.date.unixMillis(periodEnd) } : {}),
          }
        : undefined;
    return {
      ...(primary ? { primary } : {}),
      ...(secondary ? { secondary } : {}),
      identity: {
        ...(profile.email ? { accountEmail: profile.email } : {}),
        ...(workspace.name ? { accountOrganization: workspace.name } : {}),
        ...(workspace.tier
          ? { loginMethod: workspace.tier.replace(/^./u, (letter) => letter.toUpperCase()) }
          : {}),
        accountId: profile.userID,
      },
    };
  },
};
const strategy: ProviderStrategy = {
  id: "notion.web",
  kind: "web",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const notion: FirstPartyProvider = { ...strategy, descriptor };
