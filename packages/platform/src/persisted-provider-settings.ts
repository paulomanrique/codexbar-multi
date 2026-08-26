import { Effect } from "effect";
import {
  cleanConfigString,
  extensionString,
  type PersistedCodexBarConfig,
  type PersistedProviderConfig,
} from "@codexbar/core";
import type { ProviderId } from "@codexbar/contracts";
import type { FirstPartySettings } from "./first-party-runtime.ts";

const providerConfig = (
  config: PersistedCodexBarConfig | undefined,
  providerId: ProviderId,
): PersistedProviderConfig | undefined =>
  config?.providers.find((entry) => entry.id === providerId);

const moonshotSetting = (config: PersistedProviderConfig, setting: string): string | undefined => {
  const region = cleanConfigString(config.region);
  const apiKey = cleanConfigString(config.apiKey);
  const apiKeyRegion = cleanConfigString(extensionString(config, "apiKeyRegion"));
  if (setting === "MOONSHOT_REGION") return region;
  // A persisted Moonshot key is usable only with its host-binding fence. Never project half
  // of the pair, even if a legacy or concurrently edited config contains only one field.
  if (apiKey === undefined || apiKeyRegion === undefined) return undefined;
  if (setting === "CODEXBAR_MOONSHOT_API_KEY") return apiKey;
  if (setting === "CODEXBAR_MOONSHOT_API_KEY_REGION") return apiKeyRegion;
  return undefined;
};

const fireworksSetting = (config: PersistedProviderConfig, setting: string): string | undefined => {
  if (setting === "CODEXBAR_FIREWORKS_API_KEY") return cleanConfigString(config.apiKey);
  if (setting === "CODEXBAR_FIREWORKS_ACCOUNT_SLUG") {
    return cleanConfigString(extensionString(config, "accountSlug"));
  }
  return undefined;
};

const projectedSetting = (
  config: PersistedCodexBarConfig | undefined,
  providerId: ProviderId,
  setting: string,
): string | undefined => {
  const entry = providerConfig(config, providerId);
  if (entry === undefined) return undefined;
  if (providerId === "moonshot") return moonshotSetting(entry, setting);
  if (providerId === "fireworks") return fireworksSetting(entry, setting);
  return undefined;
};

/**
 * Host-only compatibility projection for legacy provider fields still persisted in config.json.
 * The allowlist is deliberately closed: arbitrary extensions never become environment settings,
 * and callers must pass one immutable config snapshot for the entire provider fetch.
 */
export const makePersistedFirstPartySettings = (
  config: PersistedCodexBarConfig | undefined,
  providerId: ProviderId,
  fallback: FirstPartySettings,
): FirstPartySettings => {
  const projection = new Map<string, string>();
  const settings =
    providerId === "moonshot"
      ? ["MOONSHOT_REGION", "CODEXBAR_MOONSHOT_API_KEY", "CODEXBAR_MOONSHOT_API_KEY_REGION"]
      : providerId === "fireworks"
        ? ["CODEXBAR_FIREWORKS_API_KEY", "CODEXBAR_FIREWORKS_ACCOUNT_SLUG"]
        : [];
  for (const setting of settings) {
    const value = projectedSetting(config, providerId, setting);
    if (value !== undefined) projection.set(setting, value);
  }
  return {
    read: (requestedProviderId, setting) => {
      const persisted = requestedProviderId === providerId ? projection.get(setting) : undefined;
      return persisted === undefined
        ? fallback.read(requestedProviderId, setting)
        : Effect.succeed(persisted);
    },
  };
};
