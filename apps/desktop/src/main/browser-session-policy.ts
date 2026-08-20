import type { ProviderId } from "@codexbar/contracts";

export interface BrowserLoginDescriptor {
  readonly startUrl: string;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly cookieDomains: readonly string[];
  readonly cookieNames: ReadonlySet<string>;
  /** At least one of these cookies must exist before a login is considered connected. */
  readonly completionCookieNames: ReadonlySet<string>;
}

export interface BrowserCookieValue {
  readonly name: string;
  readonly value: string;
}

const LOGIN_DESCRIPTORS: Readonly<Partial<Record<ProviderId, BrowserLoginDescriptor>>> = {
  t3chat: {
    startUrl: "https://t3.chat/settings/customization",
    allowedOrigins: new Set([
      "https://t3.chat",
      "https://accounts.google.com",
      "https://github.com",
    ]),
    cookieDomains: ["t3.chat", "www.t3.chat"],
    cookieNames: new Set(["__session", "__client_uat", "__clerk_db_jwt"]),
    completionCookieNames: new Set(["__session", "__clerk_db_jwt"]),
  },
};

export const browserLoginDescriptor = (provider: ProviderId): BrowserLoginDescriptor | undefined =>
  LOGIN_DESCRIPTORS[provider];

export function isAllowedBrowserLoginNavigation(
  descriptor: BrowserLoginDescriptor,
  rawUrl: string,
): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" && descriptor.allowedOrigins.has(url.origin);
  } catch {
    return false;
  }
}

/**
 * Produce the only credential material that may leave an isolated Electron
 * partition. Unknown cookies are discarded before the native keyring write.
 */
export function exportableCookieHeader(
  descriptor: BrowserLoginDescriptor,
  cookies: readonly BrowserCookieValue[],
): string | undefined {
  const selected = new Map<string, string>();
  let hasCompletionCookie = false;
  for (const cookie of cookies) {
    if (!descriptor.cookieNames.has(cookie.name) || cookie.value.length === 0) continue;
    selected.set(cookie.name, cookie.value);
    hasCompletionCookie ||= descriptor.completionCookieNames.has(cookie.name);
  }
  if (!hasCompletionCookie) return undefined;
  return [...selected.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}
