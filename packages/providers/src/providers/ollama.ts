import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
import { object, status } from "./_http.ts";

const clean = (value: string | undefined) => value?.trim() || undefined;
const cleanAPIKey = (value: string | undefined): string | undefined => {
  let normalized = clean(value);
  if (
    normalized !== undefined &&
    normalized.length >= 2 &&
    ((normalized.startsWith('"') && normalized.endsWith('"')) ||
      (normalized.startsWith("'") && normalized.endsWith("'")))
  ) {
    normalized = clean(normalized.slice(1, -1));
  }
  return normalized;
};
const defaultSessionCookieName = "__Secure-session";
const recognizedSessionCookieNames = new Set([
  "session",
  defaultSessionCookieName,
  "ollama_session",
  "__Host-ollama_session",
  "wos-session",
  "__Secure-next-auth.session-token",
  "next-auth.session-token",
]);
const cookiePairs = (
  header: string,
): readonly { readonly name: string; readonly value: string }[] =>
  header.split(";").flatMap((part) => {
    const trimmed = part.trim();
    const separator = trimmed.indexOf("=");
    if (separator < 0) return [];
    const name = trimmed.slice(0, separator).trim();
    if (!name) return [];
    return [{ name, value: trimmed.slice(separator + 1).trim() }];
  });
const isRecognizedSessionCookieName = (name: string): boolean =>
  recognizedSessionCookieNames.has(name) ||
  name.startsWith("__Secure-next-auth.session-token.") ||
  name.startsWith("next-auth.session-token.");
const cookieHasSession = (header: string): boolean =>
  cookiePairs(header).some(({ name }) => isRecognizedSessionCookieName(name));
const cookieCapturePatterns = [
  /-H\s*'Cookie:\s*([^']+)'/iu,
  /-H\s*"Cookie:\s*([^"]+)"/iu,
  /\bcookie:\s*'([^']+)'/iu,
  /\bcookie:\s*"([^"]+)"/iu,
  /\bcookie:\s*([^\r\n]+)/iu,
  /(?:^|\s)(?:--cookie|-b)\s*'([^']+)'/iu,
  /(?:^|\s)(?:--cookie|-b)\s*"([^"]+)"/iu,
  /(?:^|\s)-b'([^']+)'/iu,
  /(?:^|\s)-b"([^"]+)"/iu,
  /(?:^|\s)-b([^\s=]+=[^\s]+)/iu,
  /(?:^|\s)(?:--cookie|-b)\s+([^\s]+)/iu,
] as const;
const normalizedCookieCapture = (raw: string): string | undefined => {
  for (const pattern of cookieCapturePatterns) {
    const match = pattern.exec(raw);
    if (match?.[1]?.trim()) return match[1].trim();
  }
  if (raw.toLowerCase().startsWith("cookie:")) {
    const value = raw.slice("cookie:".length).trim();
    if (!value) return undefined;
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      return value.slice(1, -1).trim() || undefined;
    }
    return value;
  }
  return undefined;
};
const unquotedCurlCookie = (raw: string): string | undefined =>
  /(?:^|\s)-H\s*Cookie:\s*([^\s]+)/iu.exec(raw)?.[1]?.trim() || undefined;

/** Exact port of normalizedOllamaTokenAccountHeader from the Swift oracle. */
export const normalizeOllamaTokenAccountHeader = (raw: string | undefined): string | undefined => {
  const trimmed = raw?.trim();
  if (!trimmed || /[\r\n]/u.test(trimmed)) return undefined;
  const lower = trimmed.toLowerCase();
  let headerValue = trimmed;
  if (lower.startsWith("cookie:")) {
    const captured = normalizedCookieCapture(trimmed);
    if (!captured) return undefined;
    headerValue = captured;
  } else if (lower.startsWith("curl ")) {
    const captured = unquotedCurlCookie(trimmed) ?? normalizedCookieCapture(trimmed);
    if (!captured || captured === trimmed) return undefined;
    headerValue = captured;
  }
  const pairs = cookiePairs(headerValue);
  if (pairs.some(({ name }) => name.toLowerCase() === defaultSessionCookieName.toLowerCase())) {
    return pairs
      .map(
        ({ name, value }) =>
          `${name.toLowerCase() === defaultSessionCookieName.toLowerCase() ? defaultSessionCookieName : name}=${value}`,
      )
      .join("; ");
  }
  if (pairs.some(({ name }) => isRecognizedSessionCookieName(name))) return headerValue;
  if (headerValue.includes(";")) return headerValue;
  return `${defaultSessionCookieName}=${headerValue}`;
};
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
  cleanAPIKey(ctx.settings.getSecret("OLLAMA_API_KEY")) ??
  cleanAPIKey(ctx.settings.get("OLLAMA_API_KEY")) ??
  cleanAPIKey(ctx.settings.getSecret("OLLAMA_KEY"));
const web = async (ctx: ProviderContext, header: string) => {
  if (!cookieHasSession(header))
    throw ctx.fail.missingCredential("Ollama session cookie is missing.");
  const response = await ctx.http.get("https://ollama.com/settings", {
    __codexbarSuppressManagedAuth: true,
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
const webUsage = async (ctx: ProviderContext) => {
  const session = await cookie(ctx);
  if (!session) throw ctx.fail.missingCredential("Ollama session cookie is not configured.");
  return web(ctx, session);
};
const api = async (ctx: ProviderContext, key: string) => {
  // API-key validation is deliberate; /api/tags alone can be public on a local install.
  const post = ctx.http.post;
  if (post === undefined)
    throw ctx.fail.providerUnavailable("Ollama API validation requires raw HTTP POST support.");
  const validation = await post("https://ollama.com/api/web_search", {
    __codexbarSuppressManagedAuth: true,
    body: { query: "" },
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "CodexBar/1.0",
    },
    timeoutSeconds: 20,
  });
  if (validation.status === 401 || validation.status === 403)
    throw ctx.fail.authenticationExpired("Ollama API key is invalid or revoked.");
  if (validation.status !== 200 && validation.status !== 400)
    throw ctx.fail.networkFailure(`Ollama API validation returned HTTP ${validation.status}.`);
  const tags = await ctx.http.getJSON("https://ollama.com/api/tags", {
    __codexbarSuppressManagedAuth: true,
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      "User-Agent": "CodexBar/1.0",
    },
    timeoutSeconds: 20,
  });
  if (tags.status === 401 || tags.status === 403)
    throw ctx.fail.authenticationExpired("Ollama API key is invalid or revoked.");
  if (tags.status !== 200)
    throw ctx.fail.networkFailure(`Ollama tags API returned HTTP ${tags.status}.`);
  const models = object(tags.json)?.models;
  if (!Array.isArray(models)) throw ctx.fail.parseFailure("Ollama tags response is invalid.");
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
    { key: "OLLAMA_KEY", title: "Legacy API key", type: "secure" },
  ],
  capabilities: ["browser-cookies"],
  cookieDomains: ["ollama.com", "www.ollama.com", "signin.ollama.com"],
  fetchUsage: async (ctx) => {
    if (ctx.sourceMode === "api") {
      const key = apiKey(ctx);
      if (!key) throw ctx.fail.missingCredential("Ollama API key is not configured.");
      return api(ctx, key);
    }
    const session = await cookie(ctx);
    if (session) {
      try {
        return await web(ctx, session);
      } catch (error) {
        if (ctx.sourceMode === "web") throw error;
        const key = apiKey(ctx);
        if (!key) throw error;
        return api(ctx, key);
      }
    }
    if (ctx.sourceMode === "web")
      throw ctx.fail.missingCredential("Ollama session cookie is not configured.");
    const key = apiKey(ctx);
    if (!key)
      throw ctx.fail.missingCredential("Ollama session cookie or API key is not configured.");
    return api(ctx, key);
  },
};
const legacyStrategy: ProviderStrategy = {
  id: "ollama.web-api",
  kind: "web",
  fetchUsage: definition.fetchUsage,
};
const webStrategy: ProviderStrategy = {
  id: "ollama.web",
  kind: "web",
  fetchUsage: webUsage,
  fallbackOn: [
    "authentication-expired",
    "missing-credential",
    "permission-denied",
    "rate-limited",
    "provider-unavailable",
    "parse-failure",
    "network-failure",
    "api-failure",
  ],
};
const apiStrategy: ProviderStrategy = {
  id: "ollama.api",
  kind: "api",
  autoRequiresAnySecret: ["OLLAMA_API_KEY", "OLLAMA_KEY"],
  fetchUsage: async (ctx) => {
    const key = apiKey(ctx);
    if (!key) throw ctx.fail.missingCredential("Ollama API key is not configured.");
    return api(ctx, key);
  },
};
const strategies = [webStrategy, apiStrategy] as const;
export const descriptor: ProviderDescriptor = {
  ...definition,
  status: "partial",
  strategy: legacyStrategy,
  strategies,
};
export const ollama: FirstPartyProvider = { ...legacyStrategy, descriptor, strategies };
