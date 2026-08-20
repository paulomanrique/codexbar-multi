import type { ProviderSettingsDTO } from "@codexbar/contracts";

export const isAvailableProviderSource = (
  value: string,
  availableSources: readonly ProviderSettingsDTO["source"][],
): value is ProviderSettingsDTO["source"] =>
  availableSources.includes(value as ProviderSettingsDTO["source"]);
