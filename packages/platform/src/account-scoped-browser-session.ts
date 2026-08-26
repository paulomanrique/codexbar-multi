import type { ProviderId } from "@codexbar/contracts";

/**
 * Providers whose exported Electron session is keyed by the selected token-account ID.
 * All other providers remain on their host-selected default session and reject an
 * unexpected selected ID before any credential-store read.
 */
const accountScopedBrowserSessionProviders = new Set<ProviderId>(["codex", "grok"]);

export const usesAccountScopedBrowserSession = (providerId: ProviderId): boolean =>
  accountScopedBrowserSessionProviders.has(providerId);
