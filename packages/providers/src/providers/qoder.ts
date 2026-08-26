import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderResponse,
  ProviderStrategy,
} from "../types.ts";

type QoderSite = "qoder.com" | "qoder.com.cn";

export interface QoderManualCredential {
  readonly cookieHeader: string;
  readonly site: QoderSite;
}

type ManualCookieRoute = QoderSite | "invalid";
type CurlHeaderHostInspection = QoderSite | "ignored" | "invalid";
type ShortCurlHeaderValue =
  | { readonly kind: "attached"; readonly value: string }
  | { readonly kind: "next-token" }
  | { readonly kind: "invalid" };

const maximumCookieBytes = 1024 * 1024;
const textEncoder = new TextEncoder();
const supportedHTTPMethods = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);
const unsupportedKnownHTTPMethods = new Set(["trace", "connect"]);
const safeBundledCurlHeaderFlags = new Set(["f", "s", "S", "L"]);
const unsafeCurlOptions = new Set([
  "--config",
  "--expand-config",
  "--expand-header",
  "--expand-url",
  "--location-trusted",
  "--next",
  "--parallel",
  "--parallel-immediate",
  "--parallel-max",
]);
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
];
const qoderUserAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

const byteLength = (value: string): number => textEncoder.encode(value).byteLength;
const trim = (value: string | undefined): string | undefined => {
  const cleaned = value?.trim();
  return cleaned ? cleaned : undefined;
};
const hasNul = (value: string): boolean => value.includes("\0");
const hasHeaderValueControl = (value: string): boolean =>
  Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });
const stripWrappingQuotes = (value: string): string =>
  value.length >= 2 &&
  ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ? value.slice(1, -1)
    : value;
const stripCookiePrefix = (value: string): string => {
  const cleaned = value.trim();
  return cleaned.toLowerCase().startsWith("cookie:")
    ? cleaned.slice("cookie:".length).trim()
    : cleaned;
};
const extractCookieHeader = (raw: string): string | undefined => {
  for (const pattern of cookieHeaderPatterns) {
    const match = pattern.exec(raw);
    const captured = match?.[1]?.trim();
    if (captured) return captured;
  }
  return undefined;
};
const normalizeCookieHeader = (raw: string): string | undefined => {
  let value = trim(raw);
  if (!value) return undefined;
  value = extractCookieHeader(value) ?? value;
  value = stripWrappingQuotes(stripCookiePrefix(value)).trim();
  if (!value || hasHeaderValueControl(value) || byteLength(value) > maximumCookieBytes) {
    return undefined;
  }
  return value;
};
const hostFromURLText = (text: string): string | undefined => {
  const value = stripWrappingQuotes(text.trim()).toLowerCase();
  if (!value.startsWith("https://") && !value.startsWith("http://")) return undefined;
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return undefined;
  }
};
const siteForHost = (host: string): QoderSite | undefined => {
  let normalized = stripWrappingQuotes(host.trim()).toLowerCase();
  while (normalized.startsWith(".")) normalized = normalized.slice(1);
  const portSeparator = normalized.lastIndexOf(":");
  if (portSeparator >= 0) {
    const port = normalized.slice(portSeparator + 1);
    const hostname = normalized.slice(0, portSeparator);
    const portNumber = Number(port);
    if (
      hostname.includes(":") ||
      !port ||
      !/^\d+$/u.test(port) ||
      !Number.isInteger(portNumber) ||
      portNumber < 1 ||
      portNumber > 65535
    ) {
      return undefined;
    }
    normalized = hostname;
  }
  if (normalized === "qoder.com" || normalized === "www.qoder.com") return "qoder.com";
  if (normalized === "qoder.com.cn" || normalized === "www.qoder.com.cn") return "qoder.com.cn";
  return undefined;
};
const siteForURLText = (text: string): QoderSite | undefined => {
  const host = hostFromURLText(text);
  return host ? siteForHost(host) : undefined;
};
const hostHeaderSites = (raw: string): readonly (QoderSite | undefined)[] => {
  const sites: (QoderSite | undefined)[] = [];
  for (const line of raw.split(/\r\n|\n|\r/u)) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    if (name === "host") sites.push(siteForHost(line.slice(separator + 1)));
  }
  return sites;
};
const isHTTPRequestMethodToken = (token: string): boolean => /^[A-Za-z]+$/u.test(token);
const httpRequestRoute = (raw: string): ManualCookieRoute | undefined => {
  let requestSite: QoderSite | undefined;
  let sawRequestLine = false;
  for (const line of raw.split(/\r\n|\n|\r/u)) {
    const parts = line
      .trim()
      .split(/[ \t]+/u)
      .filter(Boolean);
    if (parts.length < 2) continue;
    const method = parts[0]!.toLowerCase();
    const isHTTPVersionedLine = parts.length >= 3 && parts[2]!.toLowerCase().startsWith("http/");
    if (
      unsupportedKnownHTTPMethods.has(method) ||
      (isHTTPVersionedLine && isHTTPRequestMethodToken(parts[0]!))
    ) {
      if (!supportedHTTPMethods.has(method)) return "invalid";
    } else if (!supportedHTTPMethods.has(method)) {
      continue;
    }
    if (sawRequestLine) return "invalid";
    sawRequestLine = true;
    const target = parts[1]!;
    if (target.startsWith("/")) {
      requestSite = undefined;
    } else {
      const site = siteForURLText(target);
      if (!site) return "invalid";
      requestSite = site;
    }
  }
  if (!sawRequestLine) return undefined;
  const sites = hostHeaderSites(raw);
  if (sites.some((site) => site === undefined)) return "invalid";
  const concreteSites = sites.filter((site): site is QoderSite => site !== undefined);
  if (concreteSites.some((site) => site !== concreteSites[0])) return "invalid";
  const hostSite = concreteSites[0];
  if (requestSite) {
    if (hostSite && hostSite !== requestSite) return "invalid";
    return requestSite;
  }
  return hostSite ?? "invalid";
};
const isShellAssignment = (token: string): boolean => {
  if (token.includes(";")) return false;
  const equals = token.indexOf("=");
  if (equals <= 0) return false;
  const name = token.slice(0, equals);
  return /^[_A-Za-z][_A-Za-z0-9]*$/u.test(name);
};
const isCurlExecutableToken = (token: string): boolean => {
  if (token.includes("=") || token.includes("://")) return false;
  return (token.split("/").pop() ?? token).toLowerCase() === "curl";
};
const shellTokens = (text: string): readonly string[] => {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const character of text) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/u.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }
  if (escaped) current += "\\";
  if (current) tokens.push(current);
  return tokens;
};
const containsCurlExecutableText = (text: string): boolean =>
  shellTokens(text).some(isCurlExecutableToken) ||
  /(^|[\s;])(?:[^\s;=]+\/)?curl($|[\s;])/iu.test(text);
const isUnsupportedShellControlOperator = (character: string): boolean =>
  ";|&<>".includes(character);
const isSupportedEscapedShellLiteral = (character: string): boolean =>
  character === "'" || character === '"' || character === "\\";
const isShellScalarTextSafe = (character: string): boolean => {
  const code = character.codePointAt(0) ?? 0;
  return code >= 0x20 && code !== 0x7f;
};
const isUnsupportedShellDollarExpansion = (
  characters: readonly string[],
  index: number,
): boolean => {
  if (characters[index] !== "$") return false;
  const next = characters[index + 1];
  if (!next) return false;
  if (next === "'" || next === '"' || next === "(" || next === "{" || next === "[") return true;
  if (/[_A-Za-z0-9]/u.test(next)) return true;
  return "*@#?$!-".includes(next);
};
const isProcessSubstitution = (characters: readonly string[], index: number): boolean =>
  (characters[index] === "<" || characters[index] === ">") && characters[index + 1] === "(";
const preprocessedCurlShellText = (text: string): string | undefined => {
  const characters = Array.from(text);
  let output = "";
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < characters.length; ) {
    const character = characters[index]!;
    const next = characters[index + 1];
    if (character === "\\") {
      if (!quote) {
        if (next === "\n") {
          index += 2;
          continue;
        }
        if (next === "\r" && characters[index + 2] === "\n") {
          index += 3;
          continue;
        }
      }
      if (quote !== "'" && next && isSupportedEscapedShellLiteral(next)) {
        output += character + next;
        index += 2;
        continue;
      }
      if (quote === '"') return undefined;
    }
    if (!isShellScalarTextSafe(character)) return undefined;
    if (quote === "'") {
      if (character === "'") quote = undefined;
    } else if (quote === '"') {
      if (character === '"') quote = undefined;
      else if (character === "`" || isUnsupportedShellDollarExpansion(characters, index))
        return undefined;
    } else if (isUnsupportedShellControlOperator(character)) {
      return undefined;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (
      character === "`" ||
      isUnsupportedShellDollarExpansion(characters, index) ||
      isProcessSubstitution(characters, index)
    ) {
      return undefined;
    }
    output += character;
    index += 1;
  }
  return quote ? undefined : output;
};
const curlCommandIndex = (tokens: readonly string[]): number | undefined => {
  let index = 0;
  while (index < tokens.length && isShellAssignment(tokens[index]!)) index += 1;
  return index < tokens.length && isCurlExecutableToken(tokens[index]!) ? index : undefined;
};
const shortCurlOptionsContain = (token: string, option: string): boolean =>
  token.startsWith("-") && !token.startsWith("--") && token.slice(1).includes(option);
const shortCurlHeaderValue = (token: string): ShortCurlHeaderValue | undefined => {
  if (!token.startsWith("-") || token.startsWith("--")) return undefined;
  const options = token.slice(1);
  const headerOption = options.indexOf("H");
  if (headerOption < 0) return undefined;
  if (
    !Array.from(options.slice(0, headerOption)).every((flag) =>
      safeBundledCurlHeaderFlags.has(flag),
    )
  ) {
    return { kind: "invalid" };
  }
  const attached = options.slice(headerOption + 1);
  return attached ? { kind: "attached", value: attached } : { kind: "next-token" };
};
const explicitCurlURLTargets = (
  tokens: readonly string[],
  after: number,
): readonly { readonly index: number; readonly site: QoderSite }[] | undefined => {
  const targets: { index: number; site: QoderSite }[] = [];
  for (let index = after + 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const lower = token.toLowerCase();
    if (lower === "--url") {
      const valueIndex = index + 1;
      const site = valueIndex < tokens.length ? siteForURLText(tokens[valueIndex]!) : undefined;
      if (!site) return undefined;
      targets.push({ index: valueIndex, site });
      index = valueIndex;
    } else if (lower.startsWith("--url=")) {
      const site = siteForURLText(token.slice("--url=".length));
      if (!site) return undefined;
      targets.push({ index, site });
    }
  }
  return targets;
};
const urlTokenTargets = (
  tokens: readonly string[],
  after: number,
): readonly { readonly index: number; readonly site: QoderSite }[] | undefined => {
  const targets: { index: number; site: QoderSite }[] = [];
  for (let index = after + 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const site = siteForURLText(token);
    if (site) targets.push({ index, site });
    else if (hostFromURLText(token)) return undefined;
  }
  return targets;
};
const inspectCurlHeaderHost = (headerValue: string): CurlHeaderHostInspection => {
  const cleaned = headerValue.trim();
  if (!cleaned || cleaned.startsWith("@")) return "invalid";
  const separator = cleaned.indexOf(":");
  if (separator < 0) {
    const lower = cleaned.toLowerCase();
    return lower === "host" ||
      lower.startsWith("host ") ||
      lower.startsWith("host\t") ||
      lower === "host;" ||
      lower.startsWith("host;")
      ? "invalid"
      : "ignored";
  }
  const name = cleaned.slice(0, separator).trim().toLowerCase();
  if (name !== "host") return "ignored";
  return siteForHost(cleaned.slice(separator + 1)) ?? "invalid";
};
const isUnsafeCurlOption = (lowercased: string): boolean =>
  unsafeCurlOptions.has(lowercased) ||
  lowercased.startsWith("--config=") ||
  lowercased.startsWith("--expand-") ||
  shortCurlOptionsContain(lowercased, "K");
const curlHeaderHostSites = (
  tokens: readonly string[],
  after: number,
): readonly QoderSite[] | undefined => {
  const sites: QoderSite[] = [];
  for (let index = after + 1; index < tokens.length; ) {
    const token = tokens[index]!;
    const lower = token.toLowerCase();
    let headerValue: string | undefined;
    if (isUnsafeCurlOption(lower)) return undefined;
    if (lower === "--header" || lower === "--proxy-header") {
      const valueIndex = index + 1;
      if (valueIndex >= tokens.length) return undefined;
      headerValue = tokens[valueIndex];
      index = valueIndex + 1;
    } else if (lower.startsWith("--header=") || lower.startsWith("--proxy-header=")) {
      headerValue = token.slice(token.indexOf("=") + 1);
      index += 1;
    } else {
      const shortHeader = shortCurlHeaderValue(token);
      if (!shortHeader) {
        index += 1;
        continue;
      }
      if (shortHeader.kind === "invalid") return undefined;
      if (shortHeader.kind === "attached") {
        headerValue = shortHeader.value;
        index += 1;
      } else {
        const valueIndex = index + 1;
        if (valueIndex >= tokens.length) return undefined;
        headerValue = tokens[valueIndex];
        index = valueIndex + 1;
      }
    }
    if (!headerValue) continue;
    const inspected = inspectCurlHeaderHost(headerValue);
    if (inspected === "ignored") continue;
    if (inspected === "invalid") return undefined;
    sites.push(inspected);
  }
  return sites;
};
const curlRequestRoute = (raw: string): ManualCookieRoute | undefined => {
  const preprocessed = preprocessedCurlShellText(raw);
  if (!preprocessed) return containsCurlExecutableText(raw) ? "invalid" : undefined;
  const tokens = shellTokens(preprocessed);
  const curlIndex = curlCommandIndex(tokens);
  if (curlIndex === undefined) return tokens.some(isCurlExecutableToken) ? "invalid" : undefined;
  if (!tokens.every((token) => !hasHeaderValueControl(token))) return "invalid";
  const explicitTargets = explicitCurlURLTargets(tokens, curlIndex);
  const urlTargets = urlTokenTargets(tokens, curlIndex);
  if (!explicitTargets || !urlTargets) return "invalid";
  const targetIndices = new Set([...explicitTargets, ...urlTargets].map((target) => target.index));
  if (targetIndices.size !== 1) return "invalid";
  const targetIndex = [...targetIndices][0]!;
  const trustedIndex = curlIndex + 1;
  const explicitTarget = explicitTargets.find((target) => target.index === targetIndex);
  const trustedTarget = urlTargets.find((target) => target.index === trustedIndex);
  const targetSite =
    explicitTarget?.site ?? (targetIndex === trustedIndex ? trustedTarget?.site : undefined);
  if (!targetSite) return "invalid";
  const headerSites = curlHeaderHostSites(tokens, curlIndex);
  if (!headerSites || headerSites.some((site) => site !== targetSite)) return "invalid";
  return targetSite;
};
const explicitCookieDomainRoute = (raw: string): ManualCookieRoute | undefined => {
  let routedSite: QoderSite | undefined;
  for (const part of raw.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim().toLowerCase();
    if (name !== "domain") continue;
    const site = siteForHost(part.slice(separator + 1));
    if (!site || (routedSite && routedSite !== site)) return "invalid";
    routedSite = site;
  }
  return routedSite;
};
const plainCookieRoute = (raw: string): ManualCookieRoute =>
  explicitCookieDomainRoute(raw) ?? "qoder.com";
export const normalizeQoderManualCredential = (
  raw: string | undefined,
): QoderManualCredential | undefined => {
  const value = trim(raw);
  if (!value || hasNul(value) || byteLength(value) >= maximumCookieBytes) return undefined;
  const curlRoute = curlRequestRoute(value);
  if (curlRoute === "invalid") return undefined;
  const requestRoute = curlRoute === undefined ? httpRequestRoute(value) : undefined;
  if (requestRoute === "invalid") return undefined;
  const route = curlRoute ?? requestRoute ?? plainCookieRoute(value);
  if (route === "invalid") return undefined;
  const extractedCookieHeader = extractCookieHeader(value);
  if ((curlRoute !== undefined || requestRoute !== undefined) && !extractedCookieHeader) {
    return undefined;
  }
  const cookieHeader = normalizeCookieHeader(extractedCookieHeader ?? value);
  if (!cookieHeader) return undefined;
  const hasCookiePair = cookieHeader.split(";").some((part) => part.indexOf("=") > 0);
  if (!hasCookiePair) return undefined;
  const cookieDomainRoute = explicitCookieDomainRoute(cookieHeader);
  if (
    cookieDomainRoute === "invalid" ||
    (cookieDomainRoute !== undefined && cookieDomainRoute !== route)
  ) {
    return undefined;
  }
  if (!requestRoute && /^\s*cookie:/iu.test(value) && /[\r\n]/u.test(value)) {
    return undefined;
  }
  return { cookieHeader, site: route };
};

const siteFromSetting = (value: string | undefined): QoderSite | undefined => {
  const cleaned = trim(value)?.toLowerCase();
  if (!cleaned) return undefined;
  if (cleaned === "cn" || cleaned === "china" || cleaned === "qoder.com.cn") return "qoder.com.cn";
  if (
    cleaned === "com" ||
    cleaned === "global" ||
    cleaned === "international" ||
    cleaned === "intl" ||
    cleaned === "qoder.com"
  ) {
    return "qoder.com";
  }
  return siteForHost(cleaned);
};
const selectedManualCredential = (
  ctx: ProviderContext,
): { readonly present: boolean; readonly credential?: QoderManualCredential } => {
  const raw =
    ctx.settings.getSecret("QODER_COOKIE_HEADER") ??
    ctx.settings.get("QODER_COOKIE_HEADER") ??
    ctx.settings.getSecret("QODER_MANUAL_COOKIE") ??
    ctx.settings.get("QODER_MANUAL_COOKIE");
  if (!trim(raw)) return { present: false };
  const manual = normalizeQoderManualCredential(raw);
  if (!manual) return { present: true };
  const configuredSite = siteFromSetting(ctx.settings.get("QODER_SITE"));
  if (configuredSite && manual.site !== "qoder.com" && configuredSite !== manual.site) {
    return { present: true };
  }
  return {
    present: true,
    credential: configuredSite ? { ...manual, site: configuredSite } : manual,
  };
};
const requestHeaders = (cookieHeader: string, site: QoderSite) => {
  const origin = `https://${site}`;
  return {
    Cookie: cookieHeader,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent": qoderUserAgent,
    Origin: origin,
    Referer: `${origin}/account/usage`,
    "X-Requested-With": "XMLHttpRequest",
    "Bx-V": "2.5.35",
  };
};
const fetchQoderResponse = async (
  ctx: ProviderContext,
  site: QoderSite,
  cookieHeader: string,
): Promise<ProviderResponse> => {
  try {
    return await ctx.http.get(`https://${site}/api/v2/me/usages/big_model_credits`, {
      headers: requestHeaders(cookieHeader, site),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw ctx.fail.networkFailure(
      `Qoder network error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};
const parseQoderJSON = (ctx: ProviderContext, response: ProviderResponse): any => {
  try {
    return JSON.parse(response.bodyText) as any;
  } catch (error) {
    throw ctx.fail.parseFailure(
      `Could not parse Qoder usage JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};
const fetchQoderUsage = async (ctx: ProviderContext, site: QoderSite, cookieHeader: string) => {
  const response = await fetchQoderResponse(ctx, site, cookieHeader);
  if (response.status === 401 || response.status === 403) {
    throw ctx.fail.authenticationExpired("Qoder session is invalid or expired.");
  }
  if (response.status < 200 || response.status >= 300) {
    throw ctx.fail.apiFailure(`Qoder API returned HTTP ${response.status}.`);
  }
  return parseQoderJSON(ctx, response);
};
const cookieHeaderForSite = async (ctx: ProviderContext, site: QoderSite): Promise<string> =>
  (await ctx.browser.cookieHeader(site)).trim();

const quotaNumber = (
  ctx: ProviderContext,
  source: Record<string, unknown>,
  camel: string,
  snake: string,
  optional = false,
): number | undefined => {
  const raw = source[camel] ?? source[snake];
  if (raw === undefined && optional) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    throw ctx.fail.parseFailure(`Qoder quota field ${camel} must be a nonnegative number.`);
  }
  return raw;
};

const quotaValues = (ctx: ProviderContext, source: unknown) => {
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    throw ctx.fail.parseFailure("Qoder quota summary must be an object.");
  }
  const summary = source as Record<string, unknown>;
  const used = quotaNumber(ctx, summary, "usedValue", "used_value")!;
  const total = quotaNumber(ctx, summary, "limitValue", "limit_value")!;
  const remaining =
    quotaNumber(ctx, summary, "remainingValue", "remaining_value", true) ??
    Math.max(0, total - used);
  const providedPercentage = quotaNumber(ctx, summary, "usagePercentage", "usage_percentage", true);
  if (total === 0 && (used !== 0 || remaining !== 0)) {
    throw ctx.fail.parseFailure("Qoder zero total quota must have zero usage and remaining.");
  }
  return {
    used,
    total,
    remaining,
    percentage: providedPercentage ?? (total === 0 ? 100 : ctx.pct(used, total)),
  };
};

const definition: ProviderDefinition = {
  id: "qoder",
  name: "Qoder",
  endpoints: ["https://qoder.com", "https://qoder.com.cn"],
  settings: [
    { key: "QODER_COOKIE_HEADER", title: "Cookie header", type: "secure" },
    { key: "QODER_SITE", title: "Site", type: "plain" },
  ],
  capabilities: ["browser-cookies"],
  cookieDomains: ["qoder.com", "qoder.com.cn"],
  fetchUsage: async (ctx: ProviderContext) => {
    const manual = selectedManualCredential(ctx);
    let root: any;
    if (manual.present) {
      if (!manual.credential) {
        throw ctx.fail.missingCredential("Qoder manual cookie header is invalid.");
      }
      root = await fetchQoderUsage(ctx, manual.credential.site, manual.credential.cookieHeader);
    } else {
      let authFailure: Error | undefined;
      let apiFailure: Error | undefined;
      for (const site of ["qoder.com", "qoder.com.cn"] as const) {
        const cookieHeader = await cookieHeaderForSite(ctx, site);
        try {
          root = await fetchQoderUsage(ctx, site, cookieHeader);
          break;
        } catch (error) {
          if (error instanceof Error && error.message.startsWith("authentication-expired:")) {
            authFailure = error;
            continue;
          }
          apiFailure = error instanceof Error ? error : new Error(String(error));
          break;
        }
      }
      if (!root) {
        if (apiFailure) throw apiFailure;
        if (authFailure) throw authFailure;
        throw ctx.fail.missingCredential(
          "Qoder session cookie not found. Sign in to qoder.com or qoder.com.cn in Chrome, or paste a Cookie header.",
        );
      }
    }
    const container: any = root.totalQuota || root.total_quota;
    const sharedContainer: any = root.sharedQuota || root.shared_quota;
    const summary: any = container && (container.quotaSummary || container.quota_summary);
    const shared: any =
      sharedContainer && (sharedContainer.quotaSummary || sharedContainer.quota_summary);
    if (!summary) throw ctx.fail.parseFailure("Qoder response is missing quota summary");
    const baseQuota = quotaValues(ctx, summary);
    const sharedQuota = shared ? quotaValues(ctx, shared) : undefined;
    const used = baseQuota.used + (sharedQuota?.used ?? 0);
    const total = baseQuota.total + (sharedQuota?.total ?? 0);
    const remaining = baseQuota.remaining + (sharedQuota?.remaining ?? 0);
    if (total === 0 && (used !== 0 || remaining !== 0)) {
      throw ctx.fail.parseFailure("Qoder zero total quota must have zero usage and remaining.");
    }
    const percentage = sharedQuota
      ? total === 0
        ? 100
        : ctx.pct(used, total)
      : baseQuota.percentage;
    const reset: any = root.nextResetAt ?? root.next_reset_at;
    const resetDate: any =
      typeof reset === "number"
        ? reset > 10000000000
          ? ctx.date.unixMillis(reset)
          : ctx.date.unixSeconds(reset)
        : reset
          ? ctx.date.iso(reset)
          : undefined;
    const format: any = (value: any) =>
      ctx.format.number(value, { maximumFractionDigits: Number.isInteger(value) ? 0 : 2 });
    return {
      primary: {
        usedPercent: Math.max(0, Math.min(100, percentage)),
        resetsAt: resetDate,
        resetDescription: `${format(used)} / ${format(total)} credits`,
      },
    };
  },
};
const strategy: ProviderStrategy = {
  id: "qoder.web",
  kind: "web",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const qoder: FirstPartyProvider = { ...strategy, descriptor };
