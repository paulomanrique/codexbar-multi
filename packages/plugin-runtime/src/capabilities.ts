import { approvalMatches, createApprovalBinding, type PluginApprovalBinding } from "./approval.js";
import { PluginRuntimeError } from "./errors.js";
import type { PluginSandboxCapabilities } from "./isolate-protocol.js";
import type { PluginManifest } from "./manifest.js";

export interface PluginSandboxCapabilityHost {
  /** Plain endpoint settings used to recalculate the approval surface on every call. */
  readonly endpointSettings: Readonly<Record<string, string>>;
  readonly approvedBinding: PluginApprovalBinding;
  readonly readSetting: (
    key: string,
    secure: boolean,
  ) => Promise<string | undefined> | string | undefined;
  readonly readCookie: (domain: string) => Promise<string | undefined> | string | undefined;
  readonly log: (message: string) => void | Promise<void>;
}

function denied(message: string): never {
  throw new PluginRuntimeError("secret-access", message);
}

function normalizedCookieDomain(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > 253 ||
    value.startsWith(".") ||
    value.endsWith(".") ||
    value.includes("/") ||
    value.includes(":") ||
    value
      .split(".")
      .some(
        (label) =>
          label.length === 0 ||
          label.length > 63 ||
          !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
      )
  ) {
    throw new PluginRuntimeError("network-policy", "plugin cookie domain is invalid");
  }
  return value;
}

/**
 * Creates the only capability callbacks permitted to serve the untrusted utility
 * process. The host retains store ownership; every access rechecks approval drift.
 */
export function makeApprovedPluginSandboxCapabilities(
  manifest: PluginManifest,
  host: PluginSandboxCapabilityHost,
): PluginSandboxCapabilities {
  const resolvedValues = new Set<string>();
  const assertApproval = (): void => {
    let current: PluginApprovalBinding;
    try {
      current = createApprovalBinding(manifest, host.endpointSettings);
    } catch {
      throw new PluginRuntimeError(
        "approval-drift",
        "plugin approval no longer matches its declared security surface",
      );
    }
    if (!approvalMatches(host.approvedBinding, current))
      throw new PluginRuntimeError(
        "approval-drift",
        "plugin approval no longer matches its declared security surface",
      );
  };
  const remember = (value: string | undefined): string | undefined => {
    if (value !== undefined && value.length > 0) resolvedValues.add(value);
    return value;
  };
  const redact = (message: string): string => {
    let output = message;
    for (const value of resolvedValues) output = output.split(value).join("[REDACTED]");
    return output;
  };
  return {
    async getSetting(key, secure) {
      assertApproval();
      const setting = manifest.settings.find((candidate) => candidate.key === key);
      if (setting === undefined) denied(`plugin setting '${key}' is not declared`);
      if ((setting.type === "secure") !== secure)
        denied(`plugin setting '${key}' was requested with the wrong security type`);
      return remember(await host.readSetting(key, secure));
    },
    async getCookie(rawDomain) {
      assertApproval();
      const domain = normalizedCookieDomain(rawDomain);
      if (
        !manifest.capabilities.includes("browser-cookies") ||
        !manifest.cookieDomains.includes(domain)
      )
        denied(`plugin cookie domain '${domain}' is not declared`);
      return remember(await host.readCookie(domain));
    },
    async log(message) {
      await host.log(redact(message));
    },
  };
}
