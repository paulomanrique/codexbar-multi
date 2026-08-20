/**
 * CLI reader for the desktop-exported plugin session payload. Keep this wire
 * format aligned with `apps/desktop/src/main/plugin-browser-session.ts`: the
 * CLI sees only one validated Cookie header, never an Electron cookie jar.
 */
const maximumCredentialBytes = 1_048_576;
const domainPattern =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const pluginIdPattern = /^[a-z0-9-]{1,64}$/;

const normalizeDomain = (raw: string): string => {
  const domain = raw.trim().toLowerCase();
  if (!domainPattern.test(domain)) throw new Error("plugin browser session domain is invalid");
  return domain;
};

export const pluginBrowserCredentialKey = (pluginId: string, domain: string): string => {
  if (!pluginIdPattern.test(pluginId)) throw new Error("plugin browser session id is invalid");
  return `plugin/${pluginId}/browser-session/${normalizeDomain(domain)}`;
};

/** Rejects cross-plugin, malformed, unbounded and plaintext keyring values. */
export const decodePluginBrowserCredential = (
  raw: string,
  pluginId: string,
  domain: string,
): string => {
  const normalizedDomain = normalizeDomain(domain);
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
  const value = parsed as Partial<{
    version: number;
    pluginId: string;
    domain: string;
    cookieHeader: string;
  }>;
  if (
    value.version !== 1 ||
    value.pluginId !== pluginId ||
    value.domain !== normalizedDomain ||
    typeof value.cookieHeader !== "string" ||
    value.cookieHeader.trim() === "" ||
    new TextEncoder().encode(value.cookieHeader).byteLength > maximumCredentialBytes
  )
    throw new Error("stored plugin browser session is invalid");
  return value.cookieHeader;
};
