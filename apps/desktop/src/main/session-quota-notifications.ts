import type { NotificationAdapter, SessionQuotaNotification } from "@codexbar/core";
import type { ProviderId } from "@codexbar/contracts";

/** Minimal Electron-independent shape so the delivery policy is unit-testable. */
export interface NativeNotification {
  readonly show: () => void;
}

export interface NativeNotificationFactory {
  readonly create: (content: {
    readonly title: string;
    readonly body: string;
  }) => NativeNotification;
}

export interface SessionQuotaNotificationCopy {
  readonly title: string;
  readonly body: string;
}

/**
 * English source strings from `Localizable.strings`. Desktop-wide locale
 * selection will be connected separately; provider/account identity is never
 * interpolated into this notification.
 */
export const sessionQuotaNotificationCopy = (
  notification: SessionQuotaNotification,
  providerName: string,
): SessionQuotaNotificationCopy =>
  notification.transition === "depleted"
    ? {
        title: `${providerName} session depleted`,
        body: "0% left. Will notify when it's available again.",
      }
    : {
        title: `${providerName} session restored`,
        body: "Session quota is available again.",
      };

export const makeDesktopSessionQuotaNotificationAdapter = (input: {
  readonly nativeNotifications: NativeNotificationFactory;
  readonly providerName: (provider: ProviderId) => string;
}): NotificationAdapter => ({
  notify: (notification) => {
    const copy = sessionQuotaNotificationCopy(
      notification,
      input.providerName(notification.provider),
    );
    input.nativeNotifications.create(copy).show();
  },
});
