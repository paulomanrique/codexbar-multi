import type { NotificationAdapter, SessionQuotaNotification } from "@codexbar/core";
import type { ProviderId } from "@codexbar/contracts";
import {
  resolveLocale,
  translateUpstream,
  type LocalePreference,
} from "../localization/catalog.js";

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
 * Copy comes from the generated 23-locale `Localizable.strings` catalog. A
 * provider display name is the only dynamic value; account identity is never
 * interpolated into this notification.
 */
export const sessionQuotaNotificationCopy = (
  notification: SessionQuotaNotification,
  providerName: string,
  localePreference: LocalePreference = "en",
): SessionQuotaNotificationCopy => {
  const locale = resolveLocale(localePreference);
  const [titleKey, bodyKey] =
    notification.transition === "depleted"
      ? ["session_depleted_notification_title", "session_depleted_notification_body"]
      : ["session_restored_notification_title", "session_restored_notification_body"];
  return {
    title: translateUpstream(locale, titleKey, { provider: providerName }),
    body: translateUpstream(locale, bodyKey),
  };
};

export const makeDesktopSessionQuotaNotificationAdapter = (input: {
  readonly nativeNotifications: NativeNotificationFactory;
  readonly providerName: (provider: ProviderId) => string;
  /** Main-process locale source (for Electron, `app.getLocale()`). */
  readonly locale: () => LocalePreference;
}): NotificationAdapter => ({
  notify: (notification) => {
    const copy = sessionQuotaNotificationCopy(
      notification,
      input.providerName(notification.provider),
      input.locale(),
    );
    input.nativeNotifications.create(copy).show();
  },
});
