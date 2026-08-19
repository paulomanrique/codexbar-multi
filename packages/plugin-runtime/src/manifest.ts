import { PluginRuntimeError } from "./errors.js";

export type PluginSettingKind = "plain" | "secure";
export type PluginEndpointPolicy =
  | "https"
  | "https-or-loopback-http"
  | "https-or-private-network-http";
export type PluginCapability = "browser-cookies" | "http-status";
export type PluginAuthKind = "bearer" | "x-api-key" | "header" | "authorization-scheme";

export interface PluginSetting {
  readonly key: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly type: PluginSettingKind;
}

export type PluginEndpoint =
  | { readonly kind: "fixed"; readonly origin: string }
  | { readonly kind: "setting"; readonly key: string; readonly policy: PluginEndpointPolicy };

export interface PluginManifest {
  readonly id: string;
  readonly name: string;
  readonly icon: { readonly monogram: string; readonly tint: string };
  readonly endpoints: readonly PluginEndpoint[];
  readonly auth?: {
    readonly type: PluginAuthKind;
    readonly header: string;
    readonly secret: string;
    readonly scheme?: string;
  };
  readonly settings: readonly PluginSetting[];
  readonly capabilities: readonly PluginCapability[];
  readonly cookieDomains: readonly string[];
}

const encoder = new TextEncoder();
const pluginId = /^[a-z0-9-]{1,64}$/;
const settingKey = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const headerName = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const tint = /^#[0-9A-Fa-f]{6}$/;
const privateHttpBundledProviders = new Set(["llmproxy", "litellm"]);

function invalid(message: string): never {
  throw new PluginRuntimeError("invalid-manifest", message);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    invalid(`'${field}' must be an object`);
  return value as Record<string, unknown>;
}

function requiredString(source: Record<string, unknown>, field: string): string {
  if (typeof source[field] !== "string") invalid(`'${field}' must be a string`);
  const value = source[field].trim();
  if (value.length === 0) invalid(`'${field}' must not be empty`);
  return value;
}

function boundedString(
  source: Record<string, unknown>,
  field: string,
  maximumBytes: number,
): string {
  const value = requiredString(source, field);
  if (encoder.encode(value).byteLength > maximumBytes)
    invalid(`'${field}' exceeds ${maximumBytes} UTF-8 bytes`);
  return value;
}

function optionalBoundedString(
  source: Record<string, unknown>,
  field: string,
  maximumBytes: number,
): string | undefined {
  if (source[field] === undefined || source[field] === null) return undefined;
  if (typeof source[field] !== "string") invalid(`'${field}' must be a string when present`);
  const value = source[field].trim();
  if (encoder.encode(value).byteLength > maximumBytes)
    invalid(`'${field}' exceeds ${maximumBytes} UTF-8 bytes`);
  return value.length === 0 ? undefined : value;
}

function formattedHost(host: string): string {
  return host.includes(":") && !(host.startsWith("[") && host.endsWith("]")) ? `[${host}]` : host;
}

export function normalizeHttpsOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    invalid(`endpoint '${raw}' must be an HTTPS origin`);
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    invalid(`endpoint '${raw}' must be an HTTPS origin`);
  }
  const port = url.port === "443" ? "" : url.port;
  return `https://${formattedHost(url.hostname.toLowerCase())}${port === "" ? "" : `:${port}`}`;
}

function unbracketedHost(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function ipv4Octets(host: string): readonly number[] | undefined {
  const parts = host.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^(?:0|[1-9][0-9]{0,2})$/.test(part)))
    return undefined;
  const octets = parts.map(Number);
  return octets.some((octet) => octet > 255) ? undefined : octets;
}

function isLoopback(host: string): boolean {
  const normalized = unbracketedHost(host);
  if (normalized === "localhost" || normalized === "::1") return true;
  return ipv4Octets(normalized)?.[0] === 127;
}

function isPrivateIPv4(host: string): boolean {
  const octets = ipv4Octets(host);
  if (octets === undefined) return false;
  const [a, b] = octets as [number, number, number, number];
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isPrivateIPv6(host: string): boolean {
  const normalized = unbracketedHost(host);
  if (!normalized.includes(":")) return false;
  const firstGroup = normalized.split(":", 1)[0];
  if (firstGroup === undefined || !/^[0-9a-f]{1,4}$/i.test(firstGroup)) return false;
  const firstValue = Number.parseInt(firstGroup, 16);
  return (firstValue & 0xfe00) === 0xfc00 || (firstValue & 0xffc0) === 0xfe80;
}

function isPrivateNetworkHost(host: string): boolean {
  const normalized = unbracketedHost(host);
  if (isLoopback(normalized)) return true;
  const withoutTrailingDot = normalized.endsWith(".") ? normalized.slice(0, -1) : normalized;
  return (
    (withoutTrailingDot.endsWith(".local") && withoutTrailingDot.length > ".local".length) ||
    isPrivateIPv4(normalized) ||
    isPrivateIPv6(normalized)
  );
}

export function normalizeConfiguredOrigin(raw: string, policy: PluginEndpointPolicy): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PluginRuntimeError(
      "network-policy",
      "URL does not satisfy the declared endpoint policy",
    );
  }
  if (url.username !== "" || url.password !== "" || url.hash !== "" || url.hostname === "") {
    throw new PluginRuntimeError(
      "network-policy",
      "URL does not satisfy the declared endpoint policy",
    );
  }
  const host = url.hostname.toLowerCase();
  const httpAllowed =
    url.protocol === "http:" &&
    (policy === "https-or-private-network-http"
      ? isPrivateNetworkHost(host)
      : policy === "https-or-loopback-http" && isLoopback(host));
  if (url.protocol !== "https:" && !httpAllowed) {
    throw new PluginRuntimeError(
      "network-policy",
      "URL does not satisfy the declared endpoint policy",
    );
  }
  const defaultPort = url.protocol === "https:" ? "443" : "80";
  const port = url.port === defaultPort ? "" : url.port;
  return `${url.protocol}//${formattedHost(host)}${port === "" ? "" : `:${port}`}`;
}

function normalizeCookieDomain(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (
    value.length === 0 ||
    encoder.encode(value).byteLength > 253 ||
    value.startsWith(".") ||
    value.endsWith(".") ||
    value.includes("/") ||
    value.includes(":")
  )
    invalid(`cookie domain '${raw}' is invalid`);
  const labels = value.split(".");
  if (
    labels.some(
      (label) =>
        label.length === 0 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    )
  ) {
    invalid(`cookie domain '${raw}' is invalid`);
  }
  return value;
}

export function parsePluginManifest(
  value: unknown,
  options: { readonly allowsDynamicId?: boolean } = {},
): PluginManifest {
  const definition = record(value, "defineProvider(...)");
  const id = requiredString(definition, "id");
  if (!pluginId.test(id))
    invalid("provider id must contain 1-64 lowercase ASCII letters, digits, or hyphens");
  const name = boundedString(definition, "name", 80);

  const iconValue = definition.icon;
  const fallbackMonogram = [...name][0]?.toUpperCase() ?? "?";
  const iconSource =
    iconValue === undefined || iconValue === null ? undefined : record(iconValue, "icon");
  const monogram =
    iconSource === undefined
      ? fallbackMonogram
      : (optionalBoundedString(iconSource, "monogram", 12) ?? fallbackMonogram);
  if ([...monogram].length < 1 || [...monogram].length > 3)
    invalid("icon monogram must contain 1-3 characters");
  const iconTint =
    iconSource === undefined
      ? "#6B7280"
      : (optionalBoundedString(iconSource, "tint", 7) ?? "#6B7280");
  if (!tint.test(iconTint)) invalid("icon tint must be a #RRGGBB color");

  if (
    !Array.isArray(definition.endpoints) ||
    definition.endpoints.length < 1 ||
    definition.endpoints.length > 16
  ) {
    invalid("'endpoints' must be a non-empty array of at most 16 origins");
  }
  const endpoints = definition.endpoints.map((rawEndpoint, index): PluginEndpoint => {
    if (typeof rawEndpoint === "string")
      return { kind: "fixed", origin: normalizeHttpsOrigin(rawEndpoint) };
    const endpoint = record(rawEndpoint, `endpoint at index ${index}`);
    const key = requiredString(endpoint, "setting");
    const policy = requiredString(endpoint, "policy") as PluginEndpointPolicy;
    if (!["https", "https-or-loopback-http", "https-or-private-network-http"].includes(policy)) {
      invalid(`unsupported endpoint policy '${policy}'`);
    }
    if (
      policy === "https-or-private-network-http" &&
      !options.allowsDynamicId &&
      !privateHttpBundledProviders.has(id)
    ) {
      invalid(`private-network HTTP is not allowed for bundled provider '${id}'`);
    }
    return { kind: "setting", key, policy };
  });

  if (!Array.isArray(definition.settings)) invalid("'settings' must be an array");
  if (definition.settings.length > 32) invalid("'settings' exceeds 32 entries");
  const seenSettings = new Set<string>();
  const settings = definition.settings.map((rawSetting, index): PluginSetting => {
    const source = record(rawSetting, `setting at index ${index}`);
    const key = requiredString(source, "key");
    if (!settingKey.test(key)) invalid(`setting key '${key}' is invalid`);
    if (seenSettings.has(key)) invalid(`duplicate setting key '${key}'`);
    seenSettings.add(key);
    const type = (source.type ?? "secure") as PluginSettingKind;
    if (type !== "plain" && type !== "secure")
      invalid(`unsupported setting type '${String(type)}'`);
    const subtitle = optionalBoundedString(source, "subtitle", 256);
    return {
      key,
      title: boundedString(source, "title", 80),
      ...(subtitle === undefined ? {} : { subtitle }),
      type,
    };
  });
  for (const endpoint of endpoints) {
    if (
      endpoint.kind === "setting" &&
      settings.find((setting) => setting.key === endpoint.key)?.type !== "plain"
    ) {
      invalid(`endpoint setting '${endpoint.key}' must be declared as a plain setting`);
    }
  }

  let auth: PluginManifest["auth"];
  if (definition.auth !== undefined && definition.auth !== null) {
    const source = record(definition.auth, "auth");
    const type = requiredString(source, "type") as PluginAuthKind;
    if (!["bearer", "x-api-key", "header", "authorization-scheme"].includes(type))
      invalid(`unsupported auth type '${type}'`);
    const secret = requiredString(source, "secret");
    const header =
      type === "bearer" || type === "authorization-scheme"
        ? "Authorization"
        : type === "x-api-key"
          ? "X-API-Key"
          : requiredString(source, "header");
    const scheme = type === "authorization-scheme" ? requiredString(source, "scheme") : undefined;
    if (!headerName.test(header)) invalid(`auth header '${header}' is invalid`);
    if (
      scheme !== undefined &&
      (encoder.encode(scheme).byteLength > 32 || !headerName.test(scheme))
    )
      invalid(`authorization scheme '${scheme}' is invalid`);
    if (settings.find((setting) => setting.key === secret)?.type !== "secure")
      invalid(`auth secret '${secret}' must be declared as a secure setting`);
    auth = { type, header, secret, ...(scheme === undefined ? {} : { scheme }) };
  }

  const capabilitiesRaw = definition.capabilities ?? [];
  if (!Array.isArray(capabilitiesRaw)) invalid("'capabilities' must be an array when present");
  const capabilities = [
    ...new Set(
      capabilitiesRaw.map((capability, index) => {
        if (capability !== "browser-cookies" && capability !== "http-status")
          invalid(`unsupported capability at index ${index}`);
        return capability;
      }),
    ),
  ] as PluginCapability[];

  const cookieDomainsRaw = definition.cookieDomains ?? [];
  if (!Array.isArray(cookieDomainsRaw)) invalid("'cookieDomains' must be an array");
  if (cookieDomainsRaw.length > 0 && !capabilities.includes("browser-cookies"))
    invalid("'cookieDomains' requires the browser-cookies capability");
  const cookieDomains = [
    ...new Set(
      cookieDomainsRaw.map((domain, index) => {
        if (typeof domain !== "string") invalid(`cookie domain at index ${index} must be a string`);
        return normalizeCookieDomain(domain);
      }),
    ),
  ];
  if (capabilities.includes("browser-cookies") && cookieDomains.length === 0)
    invalid("the browser-cookies capability requires at least one declared cookie domain");

  return {
    id,
    name,
    icon: { monogram, tint: iconTint.toUpperCase() },
    endpoints,
    ...(auth === undefined ? {} : { auth }),
    settings,
    capabilities,
    cookieDomains,
  };
}

export function endpointRequiresTypedConfirmation(origin: string): boolean {
  const host = unbracketedHost(new URL(origin).hostname.toLowerCase()).replace(/\.$/, "");
  return (
    host === "localhost" ||
    host.endsWith(".local") ||
    ipv4Octets(host) !== undefined ||
    host.includes(":")
  );
}
