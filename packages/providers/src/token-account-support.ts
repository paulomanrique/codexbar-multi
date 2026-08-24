import type { ProviderId } from "@codexbar/contracts";

export interface ProviderTokenAccountSupport {
  readonly provider: ProviderId;
  readonly requiresManualCookieSource: boolean;
  /** True only after the selected credential has a complete, fail-closed runtime mapper. */
  readonly runtimeSelectionAvailable: boolean;
}

const providerTokenAccountSupportBase = [
  { provider: "abacus", requiresManualCookieSource: true },
  { provider: "antigravity", requiresManualCookieSource: false },
  { provider: "augment", requiresManualCookieSource: true },
  { provider: "claude", requiresManualCookieSource: true },
  { provider: "copilot", requiresManualCookieSource: false },
  { provider: "cursor", requiresManualCookieSource: true },
  { provider: "deepinfra", requiresManualCookieSource: false },
  { provider: "deepseek", requiresManualCookieSource: false },
  { provider: "elevenlabs", requiresManualCookieSource: false },
  { provider: "factory", requiresManualCookieSource: true },
  { provider: "grok", requiresManualCookieSource: false },
  { provider: "groq", requiresManualCookieSource: false },
  { provider: "ibmbob", requiresManualCookieSource: false },
  { provider: "litellm", requiresManualCookieSource: false },
  { provider: "llmproxy", requiresManualCookieSource: false },
  { provider: "manus", requiresManualCookieSource: true },
  { provider: "minimax", requiresManualCookieSource: true },
  { provider: "mistral", requiresManualCookieSource: true },
  { provider: "neuralwatt", requiresManualCookieSource: false },
  { provider: "ollama", requiresManualCookieSource: true },
  { provider: "openai", requiresManualCookieSource: false },
  { provider: "opencode", requiresManualCookieSource: true },
  { provider: "opencodego", requiresManualCookieSource: true },
  { provider: "openrouter", requiresManualCookieSource: false },
  { provider: "qoder", requiresManualCookieSource: true },
  { provider: "stepfun", requiresManualCookieSource: true },
  { provider: "sub2api", requiresManualCookieSource: false },
  { provider: "venice", requiresManualCookieSource: false },
  { provider: "zai", requiresManualCookieSource: false },
] as const satisfies readonly Omit<ProviderTokenAccountSupport, "runtimeSelectionAvailable">[];

const runtimeSelectableProviders = new Set<ProviderId>(["antigravity", "grok"]);

export const PROVIDER_TOKEN_ACCOUNT_SUPPORT: readonly ProviderTokenAccountSupport[] =
  providerTokenAccountSupportBase.map((support) => ({
    ...support,
    runtimeSelectionAvailable: runtimeSelectableProviders.has(support.provider),
  }));

export const PROVIDER_TOKEN_ACCOUNT_SUPPORT_BY_ID: ReadonlyMap<
  ProviderId,
  ProviderTokenAccountSupport
> = new Map(PROVIDER_TOKEN_ACCOUNT_SUPPORT.map((support) => [support.provider, support]));

export const tokenAccountSupportForProvider = (
  provider: ProviderId,
): ProviderTokenAccountSupport | undefined => PROVIDER_TOKEN_ACCOUNT_SUPPORT_BY_ID.get(provider);
