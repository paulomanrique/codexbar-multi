import type { ProviderId } from "@codexbar/contracts";
import type { PersistedCodexBarConfig } from "@codexbar/core";
import {
  parseAntigravityOAuthCredentialValue,
  resolveAntigravityCredentialEmail,
} from "@codexbar/providers/providers/antigravity";
import type { FirstPartySelectedAccount } from "./first-party-runtime.ts";

const explicit = (value: string | undefined): string | null => value ?? null;

/**
 * Resolves the active Swift-compatible token account without leaking its raw
 * JSON past the platform composition boundary. Unsupported providers remain
 * fail-closed until their own typed mapper is ported.
 */
export const selectedFirstPartyAccountFromConfig = (
  config: PersistedCodexBarConfig | undefined,
  providerId: ProviderId,
): FirstPartySelectedAccount | undefined => {
  if (providerId !== "antigravity") return undefined;
  const data = config?.providers.find((provider) => provider.id === providerId)?.tokenAccounts;
  if (data === undefined || data.accounts.length === 0) return undefined;
  const index = Math.min(Math.max(data.activeIndex, 0), data.accounts.length - 1);
  const account = data.accounts[index];
  if (account === undefined) return undefined;
  const credentials = parseAntigravityOAuthCredentialValue(account.token);
  const accountEmail = resolveAntigravityCredentialEmail(credentials);
  return {
    id: account.id,
    ...(accountEmail === undefined ? {} : { accountEmail }),
    secureSettings: {
      ANTIGRAVITY_OAUTH_ACCESS_TOKEN: explicit(credentials?.accessToken),
      ANTIGRAVITY_ID_TOKEN: explicit(credentials?.idToken),
    },
    plainSettings: {
      ANTIGRAVITY_ACCOUNT_EMAIL: explicit(credentials?.email),
      ANTIGRAVITY_PROJECT_ID: explicit(credentials?.projectID),
    },
  };
};
