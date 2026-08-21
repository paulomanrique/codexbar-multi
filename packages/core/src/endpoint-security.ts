/**
 * Normalizes a configurable endpoint without accepting a credential-bearing or
 * delimiter-smuggling authority. HTTP is intentionally opt-in and restricted
 * to loopback/private addresses by the caller's policy.
 */
export type HttpHostPolicy = "https-only" | "loopback-http" | "private-network-http";

export interface EndpointPolicy {
  readonly transport?: HttpHostPolicy;
  readonly allowedHosts?: ReadonlySet<string>;
  readonly allowedDomainSuffixes?: ReadonlySet<string>;
}

export interface HttpRequestPolicy {
  readonly endpoint: EndpointPolicy;
  readonly allowedMethods?: ReadonlySet<string>;
  readonly maximumTimeoutMs?: number;
}

export interface HttpRequestLike {
  readonly url: string;
  readonly method?: string;
  readonly timeoutMs?: number;
}

const encodedAuthorityDelimiters = /%(?:2f|5c|3f|23|40|3a)/i;

export const normalizeEndpoint = (raw: string, policy: EndpointPolicy = {}): URL | undefined => {
  const value = raw.trim();
  const hasControlOrWhitespace = [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 || /\s/u.test(character);
  });
  if (value.length === 0 || hasControlOrWhitespace) return undefined;

  const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(value);
  const candidate = hasScheme ? value : `https://${value}`;
  let endpoint: URL;
  try {
    endpoint = new URL(candidate);
  } catch {
    return undefined;
  }

  const scheme = endpoint.protocol.toLowerCase();
  const host = endpoint.hostname.toLowerCase();
  const authority = candidate.match(/^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i)?.[1];
  if (
    endpoint.username ||
    endpoint.password ||
    !host ||
    endpoint.hostname.includes("%") ||
    !authority
  )
    return undefined;
  // Reject encoded authorities altogether. URL parsing can decode `%2e` or an
  // escaped host label before we inspect it, which would make allow-lists lie.
  if (authority.includes("%") || encodedAuthorityDelimiters.test(authority)) return undefined;

  const transport = policy.transport ?? "https-only";
  const permitsHttp =
    transport === "loopback-http"
      ? isLoopback(host)
      : transport === "private-network-http"
        ? isPrivateNetwork(host)
        : false;
  if (scheme !== "https:" && !(scheme === "http:" && permitsHttp)) return undefined;

  const normalizedAllowedHosts = new Set(
    [...(policy.allowedHosts ?? [])].map((allowed) => allowed.toLowerCase()),
  );
  const allowedSuffixes = [...(policy.allowedDomainSuffixes ?? [])].map((suffix) =>
    suffix.toLowerCase().replace(/^\./, ""),
  );
  if (normalizedAllowedHosts.size > 0 || allowedSuffixes.length > 0) {
    const allowed =
      normalizedAllowedHosts.has(host) ||
      allowedSuffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
    if (!allowed) return undefined;
  }
  return endpoint;
};

/** Applies endpoint and method policy before a host transport receives a request. */
export const normalizeHttpRequest = <Request extends HttpRequestLike>(
  request: Request,
  policy: HttpRequestPolicy,
): Request | undefined => {
  const endpoint = normalizeEndpoint(request.url, policy.endpoint);
  if (!endpoint) return undefined;
  const method = (request.method ?? "GET").toUpperCase();
  if (policy.allowedMethods && !policy.allowedMethods.has(method)) return undefined;
  if (
    request.timeoutMs !== undefined &&
    (!Number.isFinite(request.timeoutMs) ||
      request.timeoutMs < 0 ||
      (policy.maximumTimeoutMs !== undefined && request.timeoutMs > policy.maximumTimeoutMs))
  ) {
    return undefined;
  }
  return { ...request, url: endpoint.href };
};

const isLoopback = (host: string): boolean =>
  host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);

const isPrivateNetwork = (host: string): boolean => {
  if (isLoopback(host) || (host.endsWith(".local") && host.length > ".local".length)) return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (match) {
    const octets = match.slice(1).map(Number);
    if (octets.some((octet) => octet > 255)) return false;
    const [a, b] = octets as [number, number, number, number];
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  const firstGroup = host.split(":", 1)[0];
  if (!firstGroup || !/^[\da-f]{1,4}$/i.test(firstGroup)) return false;
  const first = Number.parseInt(firstGroup, 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
};
