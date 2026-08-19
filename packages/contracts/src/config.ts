import * as Schema from "effect/Schema";
import { ProviderInstanceId, ProviderSourceMode } from "./provider.ts";

/** Safe persisted settings shared with the renderer. Secrets and cookies are deliberately not fields here. */
export const ProviderConfig = Schema.Struct({
  id: ProviderInstanceId,
  enabled: Schema.optional(Schema.Boolean),
  source: Schema.optional(ProviderSourceMode),
  extrasEnabled: Schema.optional(Schema.Boolean),
  region: Schema.optional(Schema.String),
  workspaceId: Schema.optional(Schema.String),
  enterpriseHost: Schema.optional(Schema.String),
  accentColor: Schema.optional(Schema.String),
});
export type ProviderConfig = Schema.Schema.Type<typeof ProviderConfig>;

export const HooksConfig = Schema.Struct({
  enabled: Schema.Boolean,
  events: Schema.Array(Schema.String),
});
export type HooksConfig = Schema.Schema.Type<typeof HooksConfig>;

export const CodexBarConfig = Schema.Struct({
  version: Schema.Number,
  providers: Schema.Array(ProviderConfig),
  hooks: Schema.optional(HooksConfig),
});
export type CodexBarConfig = Schema.Schema.Type<typeof CodexBarConfig>;

export const ConfigProviderToggleDTO = Schema.Struct({
  id: ProviderInstanceId,
  enabled: Schema.Boolean,
});
export type ConfigProviderToggleDTO = Schema.Schema.Type<typeof ConfigProviderToggleDTO>;
