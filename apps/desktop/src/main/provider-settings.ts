import type {
  ProviderId,
  ProviderSettingsDTO,
  ProviderSourceMode,
  UpdateProviderSettingsRequestDTO,
} from "@codexbar/contracts";
import type { PersistedCodexBarConfig } from "@codexbar/core";

/**
 * Produces the small first-party settings projection permitted across IPC.
 * Plugin entries stay in the persisted document but can never be enumerated
 * or changed from the renderer through this surface.
 */
export interface ProviderSettingsCapability {
  readonly id: ProviderId;
  readonly availableSources: readonly ProviderSourceMode[];
}

export const providerSettingsSourcesForKind = (
  kind: "api" | "web" | "cli" | "local",
): readonly ProviderSourceMode[] =>
  kind === "api" ? ["auto", "api"] : kind === "web" ? ["auto", "web"] : ["auto", "cli"];

/**
 * A first-party provider may deliberately declare more than one host strategy.
 * Settings exposes only the union of those declared source modes; it never
 * infers a source from a renderer value.
 */
export const providerSettingsSourcesForStrategies = (
  strategies: readonly { readonly kind: "api" | "web" | "cli" | "local" }[],
): readonly ProviderSourceMode[] => {
  const sources = new Set<ProviderSourceMode>(["auto"]);
  for (const strategy of strategies) {
    for (const source of providerSettingsSourcesForKind(strategy.kind)) sources.add(source);
  }
  return [...sources];
};

export const providerSettingsProjection = (
  config: PersistedCodexBarConfig,
  capabilities: readonly ProviderSettingsCapability[],
): readonly ProviderSettingsDTO[] => {
  const configured = new Map(config.providers.map((provider) => [provider.id, provider]));
  return capabilities.map(({ id: provider, availableSources }) => {
    const entry = configured.get(provider);
    const source = entry?.source;
    return {
      provider,
      enabled: entry?.enabled ?? provider === "codex",
      source: source !== undefined && availableSources.includes(source) ? source : "auto",
      availableSources: [...availableSources],
    };
  });
};

export const providerSettingsFor = (
  config: PersistedCodexBarConfig,
  request: UpdateProviderSettingsRequestDTO,
  capabilities: readonly ProviderSettingsCapability[],
): ProviderSettingsDTO | undefined =>
  providerSettingsProjection(config, capabilities).find(
    (entry) => entry.provider === request.provider,
  );

export const supportsProviderSettingsRequest = (
  request: UpdateProviderSettingsRequestDTO,
  capabilities: readonly ProviderSettingsCapability[],
): boolean =>
  capabilities
    .find((capability) => capability.id === request.provider)
    ?.availableSources.includes(request.source) ?? false;

/**
 * Replaces only the two renderer-owned fields on one first-party entry.
 * The spread is deliberate: provider extensions, plugin settings and secrets
 * remain byte-for-byte in the logical config value until the repository
 * performs its normal atomic serialization.
 */
export const updateFirstPartyProviderSettings = (
  config: PersistedCodexBarConfig,
  request: UpdateProviderSettingsRequestDTO,
): PersistedCodexBarConfig => {
  const existingIndex = config.providers.findIndex((provider) => provider.id === request.provider);
  const nextProvider =
    existingIndex === -1
      ? { id: request.provider, enabled: request.enabled, source: request.source, extensions: {} }
      : {
          ...config.providers[existingIndex]!,
          enabled: request.enabled,
          source: request.source,
        };
  const providers =
    existingIndex === -1
      ? [...config.providers, nextProvider]
      : config.providers.map((provider, index) =>
          index === existingIndex ? nextProvider : provider,
        );
  return { ...config, providers };
};

/** Reject before creating a new config value so an unsupported source cannot be persisted. */
export const updateSupportedFirstPartyProviderSettings = (
  config: PersistedCodexBarConfig,
  request: UpdateProviderSettingsRequestDTO,
  capabilities: readonly ProviderSettingsCapability[],
): PersistedCodexBarConfig => {
  if (!supportsProviderSettingsRequest(request, capabilities)) {
    throw new Error("Provider source is not supported");
  }
  return updateFirstPartyProviderSettings(config, request);
};

/**
 * Serializes read-modify-write config changes. The current value advances only
 * after its atomic repository save succeeds, so failed writes cannot leak into
 * subsequent mutations or discard a concurrent plugin configuration change.
 */
export class DesktopConfigMutations {
  #tail: Promise<void> = Promise.resolve();

  run<Value>(mutation: () => Promise<Value>): Promise<Value> {
    const operation = this.#tail.then(mutation, mutation);
    this.#tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}
