import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { status } from "./_http.ts";

const clean = (value: string | undefined) => value?.trim() || undefined;
const cookieHasSession = (header: string) =>
  /(?:^|;\s*)(?:__Secure-session|ollama_session|__Host-ollama_session)=/iu.test(header);
const isSignedOut = (html: string) => {
  const text = html.toLowerCase();
  const form = text.includes("<form");
  const authRoute = /\/(?:api\/auth\/signin|auth\/signin|login|signin)/u.test(text);
  return (
    ((text.includes("sign in to ollama") || text.includes("log in to ollama")) && form) ||
    (form && authRoute) ||
    (form && /type=["'](?:email|password)["']/u.test(text))
  );
};
const capture = (text: string, expression: RegExp) =>
  expression.exec(text)?.[1]?.trim() || undefined;
const parseDate = (ctx: ProviderContext, raw: string | undefined) =>
  raw && Number.isFinite(Date.parse(raw)) ? ctx.date.iso(raw) : undefined;
const usageBlock = (ctx: ProviderContext, html: string, labels: readonly string[]) => {
  const allLabels = ["Session usage", "Hourly usage", "Weekly usage"];
  for (const label of labels) {
    const index = html.indexOf(label);
    if (index < 0) continue;
    const tail = html.slice(index + label.length);
    const boundary = allLabels
      .filter((next) => next !== label)
      .map((next) => tail.indexOf(next))
      .filter((next) => next >= 0);
    const block = tail.slice(0, boundary.length ? Math.min(...boundary) : 4_000);
    const used = Number(
      capture(block, /([0-9]+(?:\.[0-9]+)?)\s*%\s*used/iu) ??
        capture(block, /width:\s*([0-9]+(?:\.[0-9]+)?)%/iu),
    );
    if (!Number.isFinite(used)) continue;
    return {
      usedPercent: Math.max(0, Math.min(100, used)),
      ...(label === "Session usage" ? { windowMinutes: 300 } : {}),
      ...(parseDate(ctx, capture(block, /data-time=["']([^"']+)["']/iu))
        ? { resetsAt: parseDate(ctx, capture(block, /data-time=["']([^"']+)["']/iu)) }
        : {}),
    };
  }
  return undefined;
};
const parse = (ctx: ProviderContext, html: string) => {
  const primary = usageBlock(ctx, html, ["Session usage", "Hourly usage"]);
  const secondary = usageBlock(ctx, html, ["Weekly usage"]);
  if (!primary && !secondary) {
    if (isSignedOut(html)) throw ctx.fail.authenticationExpired("Ollama session is signed out.");
    throw ctx.fail.parseFailure("Missing Ollama usage data.");
  }
  const plan = capture(html, /Cloud Usage\s*<\/span>\s*<span[^>]*>([^<]+)/isu);
  const email = capture(html, /id=["']header-email["'][^>]*>([^<]+)</isu);
  return {
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary: { ...secondary, windowMinutes: 10_080 } } : {}),
    identity: {
      ...(plan ? { loginMethod: plan } : {}),
      ...(email?.includes("@") ? { accountEmail: email } : {}),
    },
  };
};
const cookie = async (ctx: ProviderContext) =>
  clean(ctx.settings.getSecret("OLLAMA_COOKIE")) ??
  clean(ctx.settings.get("OLLAMA_COOKIE")) ??
  clean(await ctx.browser.cookieHeader("ollama.com"));
const apiKey = (ctx: ProviderContext) =>
  clean(ctx.settings.getSecret("OLLAMA_API_KEY")) ??
  clean(ctx.settings.get("OLLAMA_API_KEY")) ??
  clean(ctx.settings.getSecret("OLLAMA_KEY"));
const web = async (ctx: ProviderContext, header: string) => {
  if (!cookieHasSession(header))
    throw ctx.fail.missingCredential("Ollama session cookie is missing.");
  const response = await ctx.http.get("https://ollama.com/settings", {
    headers: {
      Cookie: header,
      Accept: "text/html,application/xhtml+xml,*/*",
      Origin: "https://ollama.com",
      Referer: "https://ollama.com/settings",
    },
  });
  status(ctx, "Ollama", response);
  return parse(ctx, response.bodyText);
};
const api = async (ctx: ProviderContext, key: string) => {
  // API-key validation is deliberate; /api/tags alone can be public on a local install.
  const validation = await ctx.http.getJSON("https://ollama.com/api/web_search", {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
  });
  status(ctx, "Ollama", validation);
  const tags = await ctx.http.getJSON("https://ollama.com/api/tags", {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
  });
  status(ctx, "Ollama", tags);
  return { identity: { loginMethod: "API key" } };
};
const definition: ProviderDefinition = {
  id: "ollama",
  name: "Ollama",
  endpoints: ["https://ollama.com"],
  auth: { type: "provider-managed", secret: "OLLAMA_API_KEY" },
  settings: [
    { key: "OLLAMA_COOKIE", title: "Cookie header", type: "secure" },
    { key: "OLLAMA_API_KEY", title: "API key", type: "secure" },
  ],
  capabilities: ["browser-cookies"],
  cookieDomains: ["ollama.com", "www.ollama.com", "signin.ollama.com"],
  fetchUsage: async (ctx) => {
    const session = await cookie(ctx);
    const key = apiKey(ctx);
    if (session) {
      try {
        return await web(ctx, session);
      } catch (error) {
        if (!key) throw error;
      }
    }
    if (!key)
      throw ctx.fail.missingCredential("Ollama session cookie or API key is not configured.");
    return api(ctx, key);
  },
};
const strategy: ProviderStrategy = {
  id: "ollama.web-api",
  kind: "web",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const ollama: FirstPartyProvider = { ...strategy, descriptor };
