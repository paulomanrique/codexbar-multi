import type { ProviderSettingsDTO, SessionQuotaNotificationSettingsDTO } from "@codexbar/contracts";

export const isAvailableProviderSource = (
  value: string,
  availableSources: readonly ProviderSettingsDTO["source"][],
): value is ProviderSettingsDTO["source"] =>
  availableSources.includes(value as ProviderSettingsDTO["source"]);

/**
 * Keeps the renderer's global setting pessimistic while its persisted value is
 * loading or saving. Error state stays local to this one control so a failed
 * preference write cannot make provider settings look unsaved.
 */
export const sessionQuotaNotificationSettingsViewState = (
  settings: SessionQuotaNotificationSettingsDTO | undefined,
  pending: boolean,
  error: string | undefined,
) =>
  ({
    enabled: settings?.enabled ?? true,
    disabled: settings === undefined || pending,
    status:
      error === undefined
        ? settings === undefined
          ? "loading"
          : pending
            ? "pending"
            : "ready"
        : "error",
  }) as const;
