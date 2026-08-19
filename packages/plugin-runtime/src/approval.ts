import { PluginRuntimeError } from "./errors.js";
import {
  endpointRequiresTypedConfirmation,
  normalizeConfiguredOrigin,
  type PluginManifest,
} from "./manifest.js";

export interface PluginApprovalBinding {
  readonly instanceId: string;
  readonly origins: readonly string[];
  readonly authMode: string;
  readonly authHeader?: string;
  readonly authSecret?: string;
  readonly authScheme?: string;
  readonly secretNames: readonly string[];
  readonly capabilities: readonly string[];
  readonly cookieDomains: readonly string[];
}

export function createApprovalBinding(
  manifest: PluginManifest,
  settings: Readonly<Record<string, string>>,
): PluginApprovalBinding {
  const origins = new Set<string>();
  const authenticatedHttpOrigins = new Set<string>();
  for (const endpoint of manifest.endpoints) {
    if (endpoint.kind === "fixed") {
      origins.add(endpoint.origin);
      continue;
    }
    const configured = settings[endpoint.key]?.trim();
    if (configured === undefined || configured === "") {
      throw new PluginRuntimeError(
        "invalid-manifest",
        `endpoint setting '${endpoint.key}' must contain a valid URL before approval`,
      );
    }
    const origin = normalizeConfiguredOrigin(configured, endpoint.policy);
    origins.add(origin);
    if (endpoint.policy === "https-or-private-network-http" && origin.startsWith("http://"))
      authenticatedHttpOrigins.add(origin);
  }
  if (
    manifest.auth !== undefined &&
    [...origins].some(
      (origin) => origin.startsWith("http://") && !authenticatedHttpOrigins.has(origin),
    )
  ) {
    throw new PluginRuntimeError(
      "network-policy",
      "authenticated HTTP requires the private-network endpoint policy and typed approval",
    );
  }
  return {
    instanceId: manifest.id,
    origins: [...origins].sort(),
    authMode: manifest.auth?.type ?? "none",
    ...(manifest.auth === undefined ? {} : { authHeader: manifest.auth.header }),
    ...(manifest.auth === undefined ? {} : { authSecret: manifest.auth.secret }),
    ...(manifest.auth?.scheme === undefined ? {} : { authScheme: manifest.auth.scheme }),
    secretNames: manifest.settings
      .filter((setting) => setting.type === "secure")
      .map((setting) => setting.key)
      .sort(),
    capabilities: [...manifest.capabilities].sort(),
    cookieDomains: [...manifest.cookieDomains].sort(),
  };
}

export function typedConfirmationOrigins(binding: PluginApprovalBinding): readonly string[] {
  return binding.origins.filter(endpointRequiresTypedConfirmation);
}

export function approvalMatches(
  left: PluginApprovalBinding,
  right: PluginApprovalBinding,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
