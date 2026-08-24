import type { ProviderId } from "@codexbar/contracts";
import {
  claudeSelectedTokenAccountPlanUtilizationAccountKey,
  type PersistedCodexBarConfig,
} from "@codexbar/core";
import {
  parseAntigravityOAuthCredentialValue,
  resolveAntigravityCredentialEmail,
} from "@codexbar/providers/providers/antigravity";
import { deriveClaudeOAuthHistoryOwnerIdentifier } from "./node-claude-credential.ts";
import type { FirstPartySelectedAccount } from "./first-party-runtime.ts";

const explicit = (value: string | undefined): string | null => value ?? null;

const cookieHeaderPatterns = [
  /-H\s*'Cookie:\s*([^']+)'/iu,
  /-H\s*"Cookie:\s*([^"]+)"/iu,
  /\bcookie:\s*'([^']+)'/iu,
  /\bcookie:\s*"([^"]+)"/iu,
  /\bcookie:\s*([^\r\n]+)/iu,
  /(?:^|\s)(?:--cookie|-b)\s*'([^']+)'/iu,
  /(?:^|\s)(?:--cookie|-b)\s*"([^"]+)"/iu,
  /(?:^|\s)-b([^\s=]+=[^\s]+)/iu,
  /(?:^|\s)(?:--cookie|-b)\s+([^\s]+)/iu,
] as const;

const stripWrappingQuotes = (raw: string): string => {
  if (
    raw.length >= 2 &&
    ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
  ) {
    return raw.slice(1, -1);
  }
  return raw;
};

const stripCookiePrefix = (raw: string): string => {
  const trimmed = raw.trim();
  return trimmed.toLowerCase().startsWith("cookie:")
    ? trimmed.slice("cookie:".length).trim()
    : trimmed;
};

const normalizeCookieHeader = (raw: string | undefined): string | undefined => {
  let value = raw?.trim() ?? "";
  if (value === "") return undefined;
  for (const pattern of cookieHeaderPatterns) {
    const match = pattern.exec(value);
    if (match?.[1]?.trim()) {
      value = match[1].trim();
      break;
    }
  }
  value = stripWrappingQuotes(stripCookiePrefix(value)).trim();
  return value === "" ? undefined : value;
};

type ClaudeCredentialRoute =
  | { readonly kind: "oauth"; readonly accessToken: string }
  | { readonly kind: "web"; readonly cookieHeader: string }
  | { readonly kind: "admin" };

type GrokCredentialRoute =
  | { readonly kind: "oauth"; readonly accessToken: string }
  | { readonly kind: "web"; readonly cookieHeader: string };

const normalizeClaudeOAuthToken = (raw: string | undefined): string | undefined => {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === "") return undefined;
  const lower = trimmed.toLowerCase();
  if (lower.includes("cookie:") || trimmed.includes("=")) return undefined;
  if (lower.startsWith("bearer ")) {
    const bearerTrimmed = trimmed.slice("bearer ".length).trim();
    return bearerTrimmed.toLowerCase().startsWith("sk-ant-oat") ? bearerTrimmed : undefined;
  }
  return lower.startsWith("sk-ant-oat") ? trimmed : undefined;
};

const normalizeClaudeAdminAPIKey = (raw: string | undefined): string | undefined => {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === "") return undefined;
  const lower = trimmed.toLowerCase();
  if (lower.includes("cookie:") || trimmed.includes("=")) return undefined;
  if (lower.startsWith("bearer ")) {
    const bearerTrimmed = trimmed.slice("bearer ".length).trim();
    return bearerTrimmed.toLowerCase().startsWith("sk-ant-admin") ? bearerTrimmed : undefined;
  }
  return lower.startsWith("sk-ant-admin") ? trimmed : undefined;
};

const normalizeClaudeWebCookie = (raw: string | undefined): string | undefined => {
  const normalized = normalizeCookieHeader(raw);
  if (normalized === undefined) return undefined;
  return normalized.includes("=") ? normalized : `sessionKey=${normalized}`;
};

const normalizeGrokOAuthToken = (raw: string | undefined): string | undefined => {
  let token = raw?.trim() ?? "";
  if (token.toLowerCase().startsWith("bearer ")) token = token.slice(7).trim();
  if (
    token === "" ||
    token.toLowerCase().startsWith("cookie:") ||
    token.toLowerCase().startsWith("xai-") ||
    token.includes("=")
  )
    return undefined;
  return token;
};

const normalizeGrokWebCookie = (raw: string | undefined): string | undefined => {
  const normalized = normalizeCookieHeader(raw);
  return normalized?.includes("=") === true ? normalized : undefined;
};

const resolveClaudeCredentialRoute = (raw: string): ClaudeCredentialRoute | undefined => {
  if (normalizeClaudeAdminAPIKey(raw) !== undefined) return { kind: "admin" };
  const accessToken = normalizeClaudeOAuthToken(raw);
  if (accessToken !== undefined) return { kind: "oauth", accessToken };
  const cookieHeader = normalizeClaudeWebCookie(raw);
  if (cookieHeader !== undefined) return { kind: "web", cookieHeader };
  return undefined;
};

const resolveGrokCredentialRoute = (raw: string): GrokCredentialRoute | undefined => {
  const accessToken = normalizeGrokOAuthToken(raw);
  if (accessToken !== undefined) return { kind: "oauth", accessToken };
  const cookieHeader = normalizeGrokWebCookie(raw);
  if (cookieHeader !== undefined) return { kind: "web", cookieHeader };
  return undefined;
};

const clearedClaudeAccount = (id: string): FirstPartySelectedAccount => ({
  id,
  secureSettings: {
    CLAUDE_OAUTH_ACCESS_TOKEN: null,
    CLAUDE_COOKIE_HEADER: null,
    CLAUDE_CLI_USAGE_JSON: null,
  },
});

/**
 * Resolves the active Swift-compatible token account without leaking its raw
 * JSON past the platform composition boundary. Unsupported providers remain
 * fail-closed until their own typed mapper is ported.
 */
export const selectedFirstPartyAccountFromConfig = (
  config: PersistedCodexBarConfig | undefined,
  providerId: ProviderId,
): FirstPartySelectedAccount | undefined => {
  const data = config?.providers.find((provider) => provider.id === providerId)?.tokenAccounts;
  if (data === undefined || data.accounts.length === 0) return undefined;
  const index = Math.min(Math.max(data.activeIndex, 0), data.accounts.length - 1);
  const account = data.accounts[index];
  if (account === undefined) return undefined;
  if (providerId === "claude") {
    const route = resolveClaudeCredentialRoute(account.token);
    if (route === undefined || route.kind === "admin") return clearedClaudeAccount(account.id);
    const tokenAccountKey = claudeSelectedTokenAccountPlanUtilizationAccountKey(
      providerId,
      account.id,
    );
    if (route.kind === "oauth") {
      const oauthHistoryOwnerIdentifier = deriveClaudeOAuthHistoryOwnerIdentifier({
        accessToken: route.accessToken,
      });
      return {
        id: account.id,
        secureSettings: {
          CLAUDE_OAUTH_ACCESS_TOKEN: route.accessToken,
          CLAUDE_COOKIE_HEADER: null,
          CLAUDE_CLI_USAGE_JSON: null,
        },
        ...(tokenAccountKey === undefined
          ? {}
          : {
              claudeHistoryBinding: {
                selectionKey: tokenAccountKey,
                ...(oauthHistoryOwnerIdentifier === undefined
                  ? {}
                  : { oauthHistoryOwnerIdentifier }),
                tokenAccountKey,
              },
            }),
      };
    }
    return {
      id: account.id,
      secureSettings: {
        CLAUDE_OAUTH_ACCESS_TOKEN: null,
        CLAUDE_COOKIE_HEADER: route.cookieHeader,
        CLAUDE_CLI_USAGE_JSON: null,
      },
      ...(tokenAccountKey === undefined
        ? {}
        : {
            claudeHistoryBinding: {
              selectionKey: tokenAccountKey,
              tokenAccountKey,
            },
          }),
    };
  }
  if (providerId === "grok") {
    const route = resolveGrokCredentialRoute(account.token);
    if (route === undefined) {
      return {
        id: account.id,
        secureSettings: { GROK_OAUTH_TOKEN: null },
      };
    }
    if (route.kind === "oauth") {
      return {
        id: account.id,
        secureSettings: { GROK_OAUTH_TOKEN: route.accessToken },
      };
    }
    return {
      id: account.id,
      secureSettings: {
        GROK_OAUTH_TOKEN: null,
        GROK_COOKIE_HEADER: route.cookieHeader,
      },
    };
  }
  if (providerId !== "antigravity") return undefined;
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

export const selectedClaudeHistoryBindingFromConfig = (
  config: PersistedCodexBarConfig | undefined,
): FirstPartySelectedAccount["claudeHistoryBinding"] | undefined =>
  selectedFirstPartyAccountFromConfig(config, "claude")?.claudeHistoryBinding;
