import type { ProviderId } from "@codexbar/contracts";
import { sha256Hex } from "@codexbar/core";

/**
 * Providers whose exported Electron session is keyed by the selected token-account ID.
 * All other providers remain on their host-selected default session and reject an
 * unexpected selected ID before any credential-store read.
 */
const accountScopedBrowserSessionProviders = new Set<ProviderId>(["codex", "grok"]);

export const usesAccountScopedBrowserSession = (providerId: ProviderId): boolean =>
  accountScopedBrowserSessionProviders.has(providerId);

const portableBrowserSessionAccountId = /^[A-Za-z0-9_-]{1,64}$/u;

/**
 * Keep existing portable account IDs readable while mapping legacy/Unicode IDs
 * to a bounded opaque storage component. The raw logical ID remains only in the
 * encrypted credential payload and metadata roster; it is never interpolated
 * into an Electron partition name or credential-store key.
 */
export const browserSessionStorageAccountId = (accountId: string): string =>
  portableBrowserSessionAccountId.test(accountId)
    ? accountId
    : `opaque-${sha256Hex(`browser-session-account:${accountId}`)}`;

export const browserSessionCredentialKey = (providerId: ProviderId, accountId: string): string =>
  `browser-session/${providerId}/${browserSessionStorageAccountId(accountId)}`;

/** Pre-opaque key used by earlier CodexBar Multi milestones; cleanup/read only. */
export const legacyBrowserSessionCredentialKey = (
  providerId: ProviderId,
  accountId: string,
): string | undefined =>
  browserSessionStorageAccountId(accountId) === accountId
    ? undefined
    : `browser-session/${providerId}/${accountId}`;

export const browserSessionCredentialKeys = (
  providerId: ProviderId,
  accountId: string,
): readonly string[] => {
  const primary = browserSessionCredentialKey(providerId, accountId);
  const legacy = legacyBrowserSessionCredentialKey(providerId, accountId);
  return legacy === undefined ? [primary] : [primary, legacy];
};
