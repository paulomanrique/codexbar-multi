import * as Schema from "effect/Schema";
import { ProviderInstanceId, ProviderSourceMode } from "./provider.ts";

/**
 * Wire contracts for the persisted CodexBar configuration.  This schema is a
 * transport contract only: desktop/CLI composition is responsible for keeping
 * secret-bearing values out of renderer DTOs.
 *
 * Provider-specific extension keys are decoded/encoded by @codexbar/core so
 * their flattened Swift wire representation is not accidentally discarded by
 * a generic struct decoder.
 */
export const ProviderCookieSource = Schema.Literals(["auto", "manual", "off"]);
export type ProviderCookieSource = Schema.Schema.Type<typeof ProviderCookieSource>;

export const ProviderTokenAccount = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  token: Schema.String,
  addedAt: Schema.Number,
  lastUsed: Schema.optional(Schema.Number),
  externalIdentifier: Schema.optional(Schema.String),
  usageScope: Schema.optional(Schema.String),
  organizationId: Schema.optional(Schema.String),
  workspaceID: Schema.optional(Schema.String),
});
export type ProviderTokenAccount = Schema.Schema.Type<typeof ProviderTokenAccount>;

export const ProviderTokenAccountData = Schema.Struct({
  version: Schema.Number,
  accounts: Schema.Array(ProviderTokenAccount),
  activeIndex: Schema.Number,
});
export type ProviderTokenAccountData = Schema.Schema.Type<typeof ProviderTokenAccountData>;

export const QuotaWarningWindowConfig = Schema.Struct({
  thresholds: Schema.optional(Schema.Array(Schema.Number)),
  enabled: Schema.optional(Schema.Boolean),
});
export type QuotaWarningWindowConfig = Schema.Schema.Type<typeof QuotaWarningWindowConfig>;

export const QuotaWarningConfig = Schema.Struct({
  session: Schema.optional(QuotaWarningWindowConfig),
  weekly: Schema.optional(QuotaWarningWindowConfig),
});
export type QuotaWarningConfig = Schema.Schema.Type<typeof QuotaWarningConfig>;

export const ProviderConfig = Schema.Struct({
  id: ProviderInstanceId,
  enabled: Schema.optional(Schema.Boolean),
  source: Schema.optional(ProviderSourceMode),
  extrasEnabled: Schema.optional(Schema.Boolean),
  apiKey: Schema.optional(Schema.String),
  secretKey: Schema.optional(Schema.String),
  cookieHeader: Schema.optional(Schema.String),
  cookieSource: Schema.optional(ProviderCookieSource),
  region: Schema.optional(Schema.String),
  workspaceID: Schema.optional(Schema.String),
  enterpriseHost: Schema.optional(Schema.String),
  tokenAccounts: Schema.optional(ProviderTokenAccountData),
  quotaWarnings: Schema.optional(QuotaWarningConfig),
  accentColor: Schema.optional(Schema.String),
  pluginSettings: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  pluginSecrets: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
export type ProviderConfig = Schema.Schema.Type<typeof ProviderConfig>;

export const HookEventType = Schema.Literals([
  "quota_low",
  "quota_reached",
  "quota_reset",
  "provider_unavailable",
  "provider_recovered",
  "refresh_failed",
]);
export type HookEventType = Schema.Schema.Type<typeof HookEventType>;

export const HookRule = Schema.Struct({
  id: Schema.String,
  enabled: Schema.Boolean,
  event: HookEventType,
  provider: Schema.optional(Schema.String),
  threshold: Schema.optional(Schema.Number),
  executable: Schema.String,
  arguments: Schema.Array(Schema.String),
  timeoutSeconds: Schema.Number,
});
export type HookRule = Schema.Schema.Type<typeof HookRule>;

export const HooksConfig = Schema.Struct({
  enabled: Schema.Boolean,
  events: Schema.Array(HookRule),
});
export type HooksConfig = Schema.Schema.Type<typeof HooksConfig>;

export const CodexBarConfig = Schema.Struct({
  version: Schema.Number,
  providers: Schema.Array(ProviderConfig),
  hooks: Schema.optional(HooksConfig),
  /** Matches Swift's persisted global session-notification preference. */
  sessionQuotaNotificationsEnabled: Schema.optional(Schema.Boolean),
});
export type CodexBarConfig = Schema.Schema.Type<typeof CodexBarConfig>;

export const ConfigProviderToggleDTO = Schema.Struct({
  id: ProviderInstanceId,
  enabled: Schema.Boolean,
});
export type ConfigProviderToggleDTO = Schema.Schema.Type<typeof ConfigProviderToggleDTO>;
