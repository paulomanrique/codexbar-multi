import type { PersistedCodexBarConfig } from "@codexbar/core";
import { CLAUDE_SWAP_SOURCE, type ClaudeSwapAccountSnapshot } from "@codexbar/providers";
import type { ClaudeSwapAccountSwitchResult } from "@codexbar/platform";

export interface CLIClaudeSwapAdapter {
  readonly list: (request: {
    readonly executablePath: string;
    readonly signal?: AbortSignal;
  }) => Promise<readonly ClaudeSwapAccountSnapshot[]>;
  /**
   * The caller must pass one currently listed, eligible source-owned account.
   * This prevents labels or arbitrary CLI arguments from becoming switch input.
   */
  readonly activate?: (request: {
    readonly executablePath: string;
    readonly account: ClaudeSwapAccountSnapshot;
  }) => Promise<ClaudeSwapAccountSwitchResult>;
}

export type ClaudeSwapCLISettings = {
  readonly enabled: boolean;
  readonly executablePath: string;
  readonly showSingleAccount: boolean;
};

const claudeSwapEnvironmentKeys = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  "TMPDIR",
] as const;

/** Prevents the opt-in helper process from inheriting provider tokens or API keys. */
export const claudeSwapProcessEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    claudeSwapEnvironmentKeys.flatMap((key) =>
      environment[key] === undefined ? [] : ([[key, environment[key]]] as const),
    ),
  );

const configuredString = (value: unknown): string => {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  )
    return trimmed.slice(1, -1).trim();
  return trimmed;
};

/** Mirrors `ProviderConfig`'s Claude-specific extension keys without widening the generic config schema. */
export const claudeSwapCLISettings = (config: PersistedCodexBarConfig): ClaudeSwapCLISettings => {
  const claude = config.providers.find((provider) => provider.id === "claude");
  return {
    enabled: claude?.extensions.claudeSwapEnabled === true,
    executablePath: configuredString(claude?.extensions.claudeSwapExecutablePath),
    showSingleAccount: claude?.extensions.claudeSwapShowSingleAccount === true,
  };
};

/** Claude Swap owns cards only for automatic, non-account-selected Claude fetches. */
export const isClaudeSwapCardsEligible = (request: {
  readonly providerId: string;
  readonly settings: ClaudeSwapCLISettings;
  readonly sourceMode: "auto" | "web" | "cli" | "oauth" | "api";
  readonly hasExplicitAccountSelection: boolean;
}): boolean =>
  request.providerId === "claude" &&
  request.settings.enabled &&
  !request.hasExplicitAccountSelection &&
  request.sourceMode === "auto";

export const shouldPresentClaudeSwapAccounts = (
  accounts: readonly ClaudeSwapAccountSnapshot[],
  showSingleAccount: boolean,
): boolean => accounts.length > 1 || (showSingleAccount && accounts.length === 1);

export const claudeSwapActivatableSlot = (account: ClaudeSwapAccountSnapshot): number => {
  if (account.id.source !== CLAUDE_SWAP_SOURCE || !account.canActivate)
    throw new Error("Claude Swap account is not eligible for activation.");
  if (!/^[1-9][0-9]*$/u.test(account.id.opaqueId))
    throw new Error("Claude Swap account has an invalid source-issued slot.");
  const slot = Number(account.id.opaqueId);
  if (!Number.isSafeInteger(slot)) throw new Error("Claude Swap account slot is too large.");
  return slot;
};

/** Enforces the user opt-in before handing a listed source slot to the host mutation capability. */
export const activateClaudeSwapAccount = async (
  adapter: CLIClaudeSwapAdapter | undefined,
  settings: ClaudeSwapCLISettings,
  account: ClaudeSwapAccountSnapshot,
): Promise<ClaudeSwapAccountSwitchResult> => {
  if (!settings.enabled || settings.executablePath === "")
    throw new Error("Claude Swap account activation is not enabled.");
  if (adapter?.activate === undefined)
    throw new Error("Claude Swap account activation is unavailable in this host.");
  // Validate before crossing the host boundary; Node repeats the conversion
  // immediately before constructing its fixed argument vector.
  claudeSwapActivatableSlot(account);
  return adapter.activate({ executablePath: settings.executablePath, account });
};

/** Bounded terminal-safe text, matching the Swift CLI's diagnostic policy. */
export const sanitizeClaudeSwapCLIText = (raw: string, scalarLimit: number): string => {
  type EscapeState = "plain" | "escape" | "csi" | "osc" | "osc-escape";
  let state: EscapeState = "plain";
  const result: string[] = [];
  for (const character of raw) {
    const code = character.codePointAt(0) ?? 0;
    if (state === "escape") {
      state =
        code === 0x5b
          ? "csi"
          : code === 0x5d
            ? "osc"
            : code >= 0x30 && code <= 0x7e
              ? "plain"
              : state;
      continue;
    }
    if (state === "csi") {
      if (code >= 0x40 && code <= 0x7e) state = "plain";
      continue;
    }
    if (state === "osc") {
      if (code === 0x07) state = "plain";
      else if (code === 0x1b) state = "osc-escape";
      continue;
    }
    if (state === "osc-escape") {
      state = code === 0x5c ? "plain" : "osc";
      continue;
    }
    if (code === 0x1b) {
      state = "escape";
    } else if (code === 0x9b) {
      state = "csi";
    } else if (code === 0x9d) {
      state = "osc";
    } else if (code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029) {
      result.push(" ");
    } else if (code < 0x20 || code === 0x7f || /\p{Cf}/u.test(character)) {
      continue;
    } else {
      result.push(character);
    }
    if (result.length >= scalarLimit) break;
  }
  return result.join("").trim();
};
