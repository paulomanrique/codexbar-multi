import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { number, object, status, string } from "./_http.ts";

type Auth = {
  readonly authorization: string;
  readonly cookie?: string;
  readonly preferredHost?: string;
  readonly email?: string;
};
const hosts = ["ai.zoom.us", "zoommate.zoom.us"] as const;
const clean = (value: string | undefined) => value?.trim() || undefined;
const captureHeader = (raw: string, name: string) =>
  new RegExp(`(?:-H|--header)\\s+['"]${name}\\s*:\\s*([^'"]+)`, "iu").exec(raw)?.[1]?.trim();
const manual = (raw: string): Auth | undefined => {
  const authorization =
    captureHeader(raw, "authorization") ?? (/^Bearer\s+/iu.test(raw) ? raw : undefined);
  if (!authorization) return undefined;
  const cookie = captureHeader(raw, "cookie");
  const url = /https:\/\/(ai\.zoom\.us|zoommate\.zoom\.us)\//iu.exec(raw)?.[1]?.toLowerCase();
  return {
    authorization,
    ...(cookie ? { cookie } : {}),
    ...(url ? { preferredHost: url } : {}),
  };
};
const cookie = async (ctx: ProviderContext) =>
  clean(ctx.settings.getSecret("ZOOMMATE_COOKIE")) ??
  clean(ctx.settings.get("ZOOMMATE_COOKIE")) ??
  clean(await ctx.browser.cookieHeader("zoommate.zoom.us"));
const mint = async (ctx: ProviderContext, header: string): Promise<Auth> => {
  let last: Error | undefined;
  for (const host of hosts) {
    try {
      const response = await ctx.http.getJSON(
        `https://${host}/ai-computer/api/v1/login/?continue=https%3A%2F%2Fzoommate.zoom.us%2F`,
        {
          headers: {
            Cookie: header,
            Origin: "https://zoommate.zoom.us",
            Referer: "https://zoommate.zoom.us",
          },
        },
      );
      status(ctx, "ZoomMate", response);
      const data = object(object(response.json)?.data);
      const token = string(data?.nak);
      if (!token) throw ctx.fail.parseFailure("ZoomMate login bootstrap is missing nak.");
      const email = string(object(data?.user_profile)?.email);
      return {
        authorization: /^Bearer\s+/iu.test(token) ? token : `Bearer ${token}`,
        cookie: header,
        preferredHost: host,
        ...(email ? { email } : {}),
      };
    } catch (error) {
      last = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw last ?? ctx.fail.providerUnavailable("No ZoomMate API host succeeded.");
};
const snapshot = (ctx: ProviderContext, payload: unknown, auth: Auth) => {
  const data = object(object(payload)?.data);
  const credit = object(data?.credit_status);
  if (!credit) throw ctx.fail.parseFailure("ZoomMate credits/status is missing credit_status.");
  const budget = number(credit.budget_cap) ?? 0;
  const used = number(credit.used_credit) ?? 0;
  const unlimited = credit.is_unlimited === true;
  const resetValue = number(credit.cycle_end_date);
  const reset = resetValue && resetValue > 0 ? ctx.date.unixMillis(resetValue) : undefined;
  return {
    primary: {
      usedPercent: unlimited || budget <= 0 ? 0 : Math.max(0, Math.min(100, ctx.pct(used, budget))),
      ...(reset ? { resetsAt: reset } : {}),
      resetDescription: "Credits",
    },
    identity: auth.email ? { accountEmail: auth.email, loginMethod: "Cookie" } : {},
  };
};
const definition: ProviderDefinition = {
  id: "zoommate",
  name: "ZoomMate",
  endpoints: ["https://ai.zoom.us", "https://zoommate.zoom.us"],
  settings: [
    { key: "ZOOMMATE_CAPTURE", title: "cURL capture or bearer token", type: "secure" },
    { key: "ZOOMMATE_COOKIE", title: "Cookie header", type: "secure" },
  ],
  capabilities: ["browser-cookies"],
  cookieDomains: ["ai.zoom.us", "zoommate.zoom.us", "zoom.us"],
  fetchUsage: async (ctx) => {
    const explicit =
      clean(ctx.settings.getSecret("ZOOMMATE_CAPTURE")) ??
      clean(ctx.settings.get("ZOOMMATE_CAPTURE"));
    const auth = explicit ? manual(explicit) : undefined;
    const resolved =
      auth ??
      (await mint(
        ctx,
        (await cookie(ctx)) ??
          (() => {
            throw ctx.fail.missingCredential(
              "ZoomMate cURL capture or browser session is not configured.",
            );
          })(),
      ));
    const order = resolved.preferredHost
      ? [resolved.preferredHost, ...hosts.filter((host) => host !== resolved.preferredHost)]
      : [...hosts];
    let last: Error | undefined;
    for (const host of order) {
      try {
        const response = await ctx.http.getJSON(
          `https://${host}/ai-computer/api/v1/credits/status`,
          {
            headers: {
              Authorization: resolved.authorization,
              ...(resolved.cookie && host === resolved.preferredHost
                ? { Cookie: resolved.cookie }
                : {}),
              Origin: "https://zoommate.zoom.us",
              Referer: "https://zoommate.zoom.us",
            },
          },
        );
        status(ctx, "ZoomMate", response);
        return snapshot(ctx, response.json as unknown, resolved);
      } catch (error) {
        last = error instanceof Error ? error : new Error(String(error));
        if (/authentication-expired|permission-denied|parse-failure/u.test(last.message))
          throw last;
      }
    }
    throw last ?? ctx.fail.providerUnavailable("No ZoomMate API host succeeded.");
  },
};
const strategy: ProviderStrategy = {
  id: "zoommate.web",
  kind: "web",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const zoommate: FirstPartyProvider = { ...strategy, descriptor };
