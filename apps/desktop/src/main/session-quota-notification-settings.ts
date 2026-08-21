import type {
  SessionQuotaNotificationSettingsDTO,
  UpdateSessionQuotaNotificationSettingsRequestDTO,
} from "@codexbar/contracts";
import type { PersistedCodexBarConfig } from "@codexbar/core";

/**
 * The only global quota-notification data allowed across the renderer bridge.
 * Older Swift-compatible config documents omit this key; their behavior is
 * the upstream default (enabled) without forcing an unrelated rewrite.
 */
export const sessionQuotaNotificationSettingsProjection = (
  config: PersistedCodexBarConfig,
): SessionQuotaNotificationSettingsDTO => ({
  enabled: config.sessionQuotaNotificationsEnabled ?? true,
});

/**
 * Updates only the global preference. The outer spread deliberately retains
 * hooks, every provider (including user plugins), and provider extensions for
 * the repository's normal atomic save path.
 */
export const updateSessionQuotaNotificationSettings = (
  config: PersistedCodexBarConfig,
  request: UpdateSessionQuotaNotificationSettingsRequestDTO,
): PersistedCodexBarConfig => ({
  ...config,
  sessionQuotaNotificationsEnabled: request.enabled,
});
