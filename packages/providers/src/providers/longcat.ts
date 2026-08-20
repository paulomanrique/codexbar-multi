import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderResponse,
  ProviderStrategy,
} from "../types.ts";
import { date, json, number, object, string } from "./_http.ts";

const clean = (raw: string | undefined): string | undefined => {
  const value = raw
    ?.trim()
    .replace(/^['"]|['"]$/gu, "")
    .trim();
  if (!value) return undefined;
  const header = /\bcookie:\s*['"]?([^'"\r\n]+)/iu.exec(value);
  return header?.[1]?.trim() ?? (value.includes("=") ? value : undefined);
};
const headers = (cookie: string) => ({
  Cookie: cookie,
  Accept: "application/json, text/plain, */*",
  Origin: "https://longcat.chat",
  Referer: "https://longcat.chat/platform/usage",
  "Accept-Language": "en-US,en;q=0.9",
});
const unwrap = (
  ctx: ProviderContext,
  response: ProviderResponse,
  required: boolean,
  label: string,
): Record<string, unknown> | undefined => {
  if (
    response.status === 401 ||
    response.status === 403 ||
    (response.status >= 300 && response.status < 400)
  )
    throw ctx.fail.authenticationExpired("LongCat session is invalid or expired.");
  if (response.status !== 200) {
    if (required) throw ctx.fail.apiFailure(`LongCat ${label} returned HTTP ${response.status}.`);
    return undefined;
  }
  const root = object(json(ctx, "LongCat", response));
  const code = number(root?.code);
  if (code === 401 || code === 403)
    throw ctx.fail.authenticationExpired("LongCat session is invalid or expired.");
  if (code !== undefined && code !== 0 && code !== 200) {
    if (required) throw ctx.fail.apiFailure(`LongCat ${label} failed (${code}).`);
    return undefined;
  }
  return object(root?.data) ?? root;
};
const definition: ProviderDefinition = {
  id: "longcat",
  name: "LongCat",
  endpoints: ["https://longcat.chat"],
  settings: [
    { key: "LONGCAT_MANUAL_COOKIE", title: "Cookie header", type: "secure" },
    { key: "LONGCAT_API_KEY", title: "API key", type: "secure" },
  ],
  capabilities: ["browser-cookies"],
  cookieDomains: ["longcat.chat"],
  fetchUsage: async (ctx) => {
    const cookie = clean(
      ctx.settings.getSecret("LONGCAT_MANUAL_COOKIE") ??
        ctx.settings.get("LONGCAT_MANUAL_COOKIE") ??
        (await ctx.browser.cookieHeader("longcat.chat")),
    );
    if (!cookie) throw ctx.fail.missingCredential("Missing LongCat session cookies.");
    const user = unwrap(
      ctx,
      await ctx.http.getJSON("https://longcat.chat/api/v1/user-current", {
        headers: headers(cookie),
      }),
      true,
      "user-current",
    );
    let packs: Record<string, unknown> | undefined;
    try {
      packs = unwrap(
        ctx,
        await ctx.http.postJSON("https://longcat.chat/api/pay/quota/metering/token-packs/summary", {
          body: {},
          headers: headers(cookie),
        }),
        false,
        "token-pack summary",
      );
    } catch {
      /* legacy usage remains valid */
    }
    const lot = object(packs?.currentLot);
    const active =
      string(lot?.status)?.toUpperCase() === "ACTIVE" && (number(lot?.totalToken) ?? 0) > 0;
    let usage: Record<string, unknown> | undefined;
    if (!active)
      usage = unwrap(
        ctx,
        await ctx.http.getJSON("https://longcat.chat/api/lc-platform/v1/tokenUsage", {
          headers: headers(cookie),
        }),
        true,
        "token usage",
      );
    let fuel: Record<string, unknown> | undefined;
    try {
      fuel = unwrap(
        ctx,
        await ctx.http.getJSON("https://longcat.chat/api/lc-platform/v1/pending-fuel-packages", {
          headers: headers(cookie),
        }),
        false,
        "fuel packages",
      );
    } catch {
      /* supplemental */
    }
    const canonical = object(usage?.usage) ?? usage;
    const total = active ? number(lot?.totalToken) : number(canonical?.totalToken);
    const used = active ? (number(lot?.consumedToken) ?? 0) : number(canonical?.usedToken);
    const remaining = active ? (total ?? 0) - (used ?? 0) : number(canonical?.availableToken);
    const totalFuel = number(fuel?.totalQuota);
    let fuelRemaining = 0;
    let nearest: string | undefined;
    const fuelEntries = fuel?.list;
    if (Array.isArray(fuelEntries))
      for (const raw of fuelEntries) {
        const entry = object(raw);
        fuelRemaining += number(entry?.availableToken) ?? 0;
        const expiry = date(entry?.expireTime, ctx);
        if (expiry && (!nearest || Date.parse(expiry) < Date.parse(nearest))) nearest = expiry;
      }
    return {
      ...(total !== undefined && total > 0
        ? {
            primary: {
              usedPercent: ctx.pct(used ?? Math.max(0, total - (remaining ?? total)), total),
              resetDescription: `${Math.trunc(used ?? Math.max(0, total - (remaining ?? total)))}/${Math.trunc(total)}`,
            },
          }
        : {}),
      ...(totalFuel !== undefined && totalFuel > 0
        ? {
            secondary: {
              usedPercent: ctx.pct(
                Math.max(0, totalFuel - (fuelRemaining || totalFuel)),
                totalFuel,
              ),
              ...(nearest ? { resetsAt: nearest } : {}),
              resetDescription: `Fuel pack: ${Math.trunc(fuelRemaining || totalFuel)}/${Math.trunc(totalFuel)}`,
            },
          }
        : {}),
      identity:
        (string(user?.name) ?? string(user?.nickName))
          ? { organization: string(user?.name) ?? string(user?.nickName) }
          : {},
    };
  },
};
const strategy: ProviderStrategy = {
  id: "longcat.web",
  kind: "web",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const longcat: FirstPartyProvider = { ...strategy, descriptor };
