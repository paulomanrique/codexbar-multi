import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { number, object, string } from "./_http.ts";

const expectedCreditsKeys = new Set([
  "totalCredits",
  "freeCredits",
  "periodicCredits",
  "addonCredits",
  "refreshCredits",
  "maxRefreshCredits",
  "proMonthlyCredits",
  "eventCredits",
]);
const userAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";
const cookieHeaderPatterns = [
  /-H\s*'Cookie:\s*([^']+)'/iu,
  /-H\s*"Cookie:\s*([^"]+)"/iu,
  /\bcookie:\s*'([^']+)'/iu,
  /\bcookie:\s*"([^"]+)"/iu,
  /\bcookie:\s*([^\r\n]+)/iu,
  /(?:^|\s)(?:--cookie|-b)\s*'([^']+)'/iu,
  /(?:^|\s)(?:--cookie|-b)\s*"([^"]+)"/iu,
  /(?:^|\s)-b([^\s=]+=[^\s]+)/iu,
  /(?:^|\s)(?:--cookie|-b)\s+([^\s]+)/iu,
] as const;

const normalizeManusCookieMaterial = (raw: string | undefined): string | undefined => {
  let value = raw?.trim() ?? "";
  if (!value) return undefined;
  for (const pattern of cookieHeaderPatterns) {
    const match = pattern.exec(value);
    if (match?.[1]?.trim()) {
      value = match[1].trim();
      break;
    }
  }
  if (value.toLowerCase().startsWith("cookie:")) value = value.slice("cookie:".length).trim();
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1).trim();
  }
  return value || undefined;
};

export const manusSessionToken = (raw: string | undefined): string | undefined => {
  const normalized = normalizeManusCookieMaterial(raw);
  if (!normalized) return undefined;
  if (!normalized.includes("=") && !normalized.includes(";")) return normalized;
  for (const pair of normalized.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (name.toLowerCase() === "session_id" && value) return value;
  }
  return undefined;
};

const definition: ProviderDefinition = {
  id: "manus",
  name: "Manus",
  endpoints: ["https://api.manus.im"],
  settings: [{ key: "MANUS_COOKIE_HEADER", title: "Session cookie", type: "secure" }],
  capabilities: ["browser-cookies"],
  cookieDomains: ["manus.im"],
  fetchUsage: async (ctx: ProviderContext) => {
    const manual =
      ctx.settings.getSecret("MANUS_COOKIE_HEADER") ?? ctx.settings.get("MANUS_COOKIE_HEADER");
    const material = manual ?? (await ctx.browser.cookieHeader("manus.im"));
    const sessionToken = manusSessionToken(material);
    if (!sessionToken)
      throw ctx.fail.missingCredential("Manus session_id cookie is missing or invalid.");
    const response = await ctx.http.postJSON(
      "https://api.manus.im/user.v1.UserService/GetAvailableCredits",
      {
        body: {},
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionToken}`,
          Origin: "https://manus.im",
          Referer: "https://manus.im/",
          "Connect-Protocol-Version": "1",
          "User-Agent": userAgent,
        },
      },
    );
    if (response.status === 401 || response.status === 403)
      throw ctx.fail.authenticationExpired("Manus session is invalid or expired.");
    if (response.status === 429) throw ctx.fail.rateLimited("Manus API returned HTTP 429.");
    if (response.status >= 500)
      throw ctx.fail.providerUnavailable(`Manus API returned HTTP ${response.status}.`);
    if (response.status !== 200)
      throw ctx.fail.apiFailure(`Manus API returned HTTP ${response.status}.`);
    const root = object(response.json);
    if (!root) throw ctx.fail.parseFailure("Manus response was not a JSON object.");
    const envelope =
      object(root.data) ??
      object(root.result) ??
      object(root.response) ??
      object(root.availableCredits);
    if (envelope === undefined && !Object.keys(root).some((key) => expectedCreditsKeys.has(key))) {
      throw ctx.fail.parseFailure("Manus response is missing expected credits fields.");
    }
    const data = envelope ?? root;
    const total = number(data.totalCredits) ?? 0;
    const free = number(data.freeCredits) ?? 0;
    const monthly = number(data.proMonthlyCredits) ?? 0;
    const periodic = number(data.periodicCredits) ?? 0;
    const refresh = number(data.refreshCredits) ?? 0;
    const maxRefresh = number(data.maxRefreshCredits) ?? 0;
    const format = (value: number) =>
      ctx.format.number(Math.round(value), { maximumFractionDigits: 0 });
    return {
      primary:
        monthly > 0
          ? {
              usedPercent: ctx.pct(monthly - periodic, monthly),
              resetDescription: `Total ${format(total)} • Free ${format(free)}`,
            }
          : undefined,
      secondary:
        maxRefresh > 0
          ? {
              usedPercent: ctx.pct(maxRefresh - refresh, maxRefresh),
              resetsAt: string(data.nextRefreshTime)
                ? ctx.date.iso(string(data.nextRefreshTime) as string)
                : undefined,
              resetDescription: string(data.refreshInterval)
                ? `${(string(data.refreshInterval) as string).replace(/^./, (value) => value.toUpperCase())}: ${format(refresh)} / ${format(maxRefresh)}`
                : `${format(refresh)} / ${format(maxRefresh)}`,
            }
          : undefined,
      identity: { loginMethod: `Balance: ${format(total)} credits` },
    };
  },
};
const strategy: ProviderStrategy = {
  id: "manus.web",
  kind: "web",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const manus: FirstPartyProvider = { ...strategy, descriptor };
