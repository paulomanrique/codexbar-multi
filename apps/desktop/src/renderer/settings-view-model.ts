import type {
  ProviderSettingsDTO,
  SessionQuotaNotificationSettingsDTO,
  TokenAccountMetadataDTO,
  TokenAccountRosterDTO,
} from "@codexbar/contracts";

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

export const tokenAccountLabel = (account: TokenAccountMetadataDTO, fallback: string): string =>
  account.label.trim() || account.externalIdentifier?.trim() || fallback;

export const tokenAccountDetail = (
  account: TokenAccountMetadataDTO | undefined,
): string | undefined => account?.usageScope?.trim() || account?.workspaceID?.trim() || undefined;

export const tokenAccountSelectionViewState = (
  roster: TokenAccountRosterDTO | undefined,
  loading: boolean,
  pending: boolean,
  error: string | undefined,
) => {
  const active = roster?.accounts[roster.activeIndex];
  return {
    active,
    activeId: active?.id ?? "",
    disabled:
      roster === undefined ||
      roster.accounts.length === 0 ||
      !roster.selectionAvailable ||
      loading ||
      pending,
    status:
      error !== undefined
        ? ("error" as const)
        : loading || roster === undefined
          ? ("loading" as const)
          : pending
            ? ("pending" as const)
            : roster.accounts.length === 0
              ? ("empty" as const)
              : ("ready" as const),
  };
};

/** Moves only the visible active row; the host-issued revision remains unchanged until IPC succeeds. */
export const optimisticTokenAccountRoster = (
  roster: TokenAccountRosterDTO,
  accountId: string,
): TokenAccountRosterDTO | undefined => {
  const activeIndex = roster.accounts.findIndex((account) => account.id === accountId);
  return activeIndex < 0 ? undefined : { ...roster, activeIndex };
};

/** Renames one metadata row only; account identity, active selection and revision stay host-owned. */
export const optimisticRenameTokenAccountRoster = (
  roster: TokenAccountRosterDTO,
  accountId: string,
  label: string,
): TokenAccountRosterDTO | undefined => {
  const trimmed = label.trim();
  if (trimmed.length === 0 || trimmed.length > 256) return undefined;
  if (/\p{Cc}/u.test(trimmed)) return undefined;
  const accountIndex = roster.accounts.findIndex((account) => account.id === accountId);
  if (accountIndex < 0) return undefined;
  return {
    ...roster,
    accounts: roster.accounts.map((account, index) =>
      index === accountIndex ? { ...account, label: trimmed } : account,
    ),
  };
};
