import type { PersistedCodexBarConfig, PersistedProviderConfig } from "./config.ts";

/**
 * Legacy import is deliberately opt-in.  The core only plans safe work from
 * metadata; discovering files and mutating SQLite are host responsibilities.
 */
export type LegacyImportKind = "config" | "history" | "cost" | "plugins";

export type LegacyImportCandidateState = "ready" | "missing" | "invalid" | "excluded";

export interface LegacyImportCandidate {
  readonly kind: LegacyImportKind;
  /** Stable logical identifier such as `legacy-history`, never a path or credential value. */
  readonly source: string;
  readonly state: LegacyImportCandidateState;
  readonly itemCount: number;
  readonly byteCount: number;
  readonly reason?: string;
}

export interface LegacyImportInspection {
  readonly candidates: readonly LegacyImportCandidate[];
  /** Product features intentionally outside CodexBar Multi's scope. */
  readonly excludedFeatures: readonly ("icloud" | "widgetkit" | "sparkle" | "approvals")[];
  /** This port rescans JSON/JSONL; it never assumes a legacy SQLite layout. */
  readonly sqliteCompatibility: "not-attempted";
}

export interface LegacyImportAction {
  readonly kind: LegacyImportKind;
  readonly source: string;
  readonly itemCount: number;
}

export interface LegacyImportPlan {
  readonly importId: string;
  readonly actions: readonly LegacyImportAction[];
  readonly inspection: LegacyImportInspection;
}

const importIdPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Produces a deterministic, data-free plan.  A report built from this object
 * can safely be surfaced to UI/CLI because it contains counts and names only.
 */
export const planLegacyImport = (
  importId: string,
  inspection: LegacyImportInspection,
): LegacyImportPlan => {
  if (!importIdPattern.test(importId)) {
    throw new TypeError("Legacy import ID must be 1-64 lowercase alphanumeric/dash characters.");
  }
  const sources = new Set<string>();
  const actions: LegacyImportAction[] = [];
  for (const candidate of inspection.candidates) {
    if (candidate.itemCount < 0 || !Number.isSafeInteger(candidate.itemCount)) {
      throw new TypeError(
        `Legacy import candidate '${candidate.source}' has an invalid item count.`,
      );
    }
    if (candidate.byteCount < 0 || !Number.isSafeInteger(candidate.byteCount)) {
      throw new TypeError(
        `Legacy import candidate '${candidate.source}' has an invalid byte count.`,
      );
    }
    if (candidate.state !== "ready") continue;
    if (sources.has(candidate.source)) {
      throw new TypeError(`Legacy import source '${candidate.source}' appears more than once.`);
    }
    sources.add(candidate.source);
    actions.push({
      kind: candidate.kind,
      source: candidate.source,
      itemCount: candidate.itemCount,
    });
  }
  return { importId, actions, inspection };
};

const scrubProvider = (provider: PersistedProviderConfig): PersistedProviderConfig => {
  const {
    apiKey: _apiKey,
    secretKey: _secretKey,
    cookieHeader: _cookieHeader,
    pluginSettings: _pluginSettings,
    pluginSecrets: _pluginSecrets,
    tokenAccounts: _tokenAccounts,
    ...safe
  } = provider;
  // Provider extensions and plugin settings are intentionally dropped rather
  // than guessed safe. Their schemas are provider/plugin-owned and arbitrary
  // keys such as `session` can hold credentials without naming them so.
  return { ...safe, extensions: {} };
};

/**
 * Credentials are a separate, user-approved migration.  This slice imports
 * only configuration/settings with an explicit shared schema. It removes
 * known secret fields and drops provider/plugin-owned arbitrary data entirely.
 */
export const stripLegacyCredentials = (
  config: PersistedCodexBarConfig,
): PersistedCodexBarConfig => ({
  ...config,
  providers: config.providers.map(scrubProvider),
  // Legacy hook executables are preserved for a user to inspect, but importing
  // settings must never grant them authority to start subprocesses.
  ...(config.hooks === undefined
    ? {}
    : {
        hooks: {
          ...config.hooks,
          enabled: false,
          events: config.hooks.events.map((event) => ({ ...event, enabled: false })),
        },
      }),
});
