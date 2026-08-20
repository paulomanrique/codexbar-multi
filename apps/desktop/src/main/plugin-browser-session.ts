/**
 * Credential-store composition for user-plugin browser sessions. This module
 * intentionally owns no Electron Session: a plugin only receives the one
 * header for an already-approved, declared domain through the sandbox broker.
 */

const maximumCredentialBytes = 1_048_576;
const domainPattern =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const pluginIdPattern = /^[a-z0-9-]{1,64}$/;

export interface PluginBrowserCredentialStore {
  readonly read: (key: string) => Promise<string | undefined>;
  readonly remove: (key: string) => Promise<void>;
}

interface PluginBrowserCredentialPayload {
  readonly version: 1;
  readonly pluginId: string;
  readonly domain: string;
  readonly cookieHeader: string;
}

function normalizeDomain(rawDomain: string): string {
  const domain = rawDomain.trim().toLowerCase();
  if (!domainPattern.test(domain)) throw new Error("plugin browser session domain is invalid");
  return domain;
}

function assertPluginId(pluginId: string): void {
  if (!pluginIdPattern.test(pluginId)) throw new Error("plugin browser session id is invalid");
}

export const pluginBrowserCredentialKey = (pluginId: string, domain: string): string => {
  assertPluginId(pluginId);
  return `plugin/${pluginId}/browser-session/${normalizeDomain(domain)}`;
};

/** A bounded credential wire format, so stale/cross-plugin keyring values fail closed. */
export const pluginBrowserCredentialPayload = (
  pluginId: string,
  domain: string,
  cookieHeader: string,
): string => {
  const normalizedDomain = normalizeDomain(domain);
  assertPluginId(pluginId);
  if (
    cookieHeader.trim() === "" ||
    new TextEncoder().encode(cookieHeader).byteLength > maximumCredentialBytes
  )
    throw new Error("plugin browser session cookie header is invalid");
  return JSON.stringify({ version: 1, pluginId, domain: normalizedDomain, cookieHeader });
};

const decodePayload = (raw: string, pluginId: string, domain: string): string => {
  if (new TextEncoder().encode(raw).byteLength > maximumCredentialBytes)
    throw new Error("stored plugin browser session is invalid");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("stored plugin browser session is invalid");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("stored plugin browser session is invalid");
  const value = parsed as Partial<PluginBrowserCredentialPayload>;
  if (
    value.version !== 1 ||
    value.pluginId !== pluginId ||
    value.domain !== domain ||
    typeof value.cookieHeader !== "string" ||
    value.cookieHeader.trim() === "" ||
    new TextEncoder().encode(value.cookieHeader).byteLength > maximumCredentialBytes
  ) {
    throw new Error("stored plugin browser session is invalid");
  }
  return value.cookieHeader;
};

export const makePluginCredentialBrowserSessions = (store: PluginBrowserCredentialStore) => ({
  readCookie: async (pluginId: string, domain: string): Promise<string | undefined> => {
    const normalizedDomain = normalizeDomain(domain);
    const raw = await store.read(pluginBrowserCredentialKey(pluginId, normalizedDomain));
    return raw === undefined ? undefined : decodePayload(raw, pluginId, normalizedDomain);
  },
  remove: async (pluginId: string, domains: readonly string[]): Promise<void> => {
    const keys = [
      ...new Set(domains.map((domain) => pluginBrowserCredentialKey(pluginId, domain))),
    ];
    const outcomes = await Promise.allSettled(keys.map((key) => store.remove(key)));
    if (outcomes.some((outcome) => outcome.status === "rejected"))
      throw new Error("plugin browser session cleanup failed");
  },
});
