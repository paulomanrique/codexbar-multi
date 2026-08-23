/**
 * Process-local Claude CLI background policy. Adaptive/background refresh
 * omits Claude until this process records a successful user-initiated
 * `claude.cli` result. There is no global in-flight toggle: user and
 * background refreshes must not race each other.
 */

let userInitiatedCliSuccess = false;

export const recordClaudeCliUserInitiatedSuccess = (): void => {
  userInitiatedCliSuccess = true;
};

export const hasClaudeCliUserInitiatedSuccess = (): boolean => userInitiatedCliSuccess;

export const resetClaudeCliPolicyForTesting = (): void => {
  userInitiatedCliSuccess = false;
};

/** User-initiated refresh always includes Claude; background waits for success. */
export const shouldIncludeClaudeInRefresh = (kind: "user" | "background"): boolean =>
  kind === "user" || userInitiatedCliSuccess;

export const filterProvidersForClaudeBackgroundPolicy = <
  T extends { readonly id: string; readonly enabled: boolean },
>(
  providers: readonly T[],
  kind: "user" | "background",
): readonly T[] =>
  providers.filter((provider) => {
    if (!provider.enabled) return false;
    if (provider.id !== "claude") return true;
    return shouldIncludeClaudeInRefresh(kind);
  });
