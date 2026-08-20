import * as Schema from "effect/Schema";
import { UsageSnapshot } from "./usage.ts";

export const UserPluginId = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z0-9-]{1,64}$/)));
export type UserPluginId = Schema.Schema.Type<typeof UserPluginId>;

export const PluginSourceLanguage = Schema.Literals(["javascript", "typescript"]);
export type PluginSourceLanguage = Schema.Schema.Type<typeof PluginSourceLanguage>;

const PluginSettingsRecord = Schema.Record(
  Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9_]{0,63}$/))),
  Schema.String.pipe(Schema.check(Schema.isMaxLength(4096))),
).pipe(
  Schema.refine((value): value is typeof value => Object.keys(value).length <= 32, {
    message: "plugin settings exceed 32 entries",
  }),
);

const PluginSettingDTO = Schema.Struct({
  key: Schema.String,
  title: Schema.String,
  subtitle: Schema.optional(Schema.String),
  type: Schema.Literals(["plain", "secure"]),
});

export const PluginApprovalBindingDTO = Schema.Struct({
  instanceId: UserPluginId,
  origins: Schema.Array(Schema.String),
  authMode: Schema.String,
  authHeader: Schema.optional(Schema.String),
  authSecret: Schema.optional(Schema.String),
  authScheme: Schema.optional(Schema.String),
  secretNames: Schema.Array(Schema.String),
  capabilities: Schema.Array(Schema.String),
  cookieDomains: Schema.Array(Schema.String),
});
export type PluginApprovalBindingDTO = Schema.Schema.Type<typeof PluginApprovalBindingDTO>;

export const InstalledPluginDTO = Schema.Struct({
  id: UserPluginId,
  name: Schema.String,
  language: PluginSourceLanguage,
  icon: Schema.Struct({ monogram: Schema.String, tint: Schema.String }),
  settings: Schema.Array(PluginSettingDTO),
  capabilities: Schema.Array(Schema.String),
  cookieDomains: Schema.Array(Schema.String),
  approvalStatus: Schema.Literals(["approved", "needs-approval"]),
});
export type InstalledPluginDTO = Schema.Schema.Type<typeof InstalledPluginDTO>;

export const PluginListResultDTO = Schema.Struct({
  plugins: Schema.Array(InstalledPluginDTO),
  invalidFiles: Schema.Array(
    Schema.Struct({
      fileName: Schema.String,
      error: Schema.String,
    }),
  ),
});
export type PluginListResultDTO = Schema.Schema.Type<typeof PluginListResultDTO>;

export const InstallPluginRequestDTO = Schema.Struct({
  source: Schema.String.pipe(Schema.check(Schema.isMaxLength(1_048_576))),
  language: PluginSourceLanguage,
});
export type InstallPluginRequestDTO = Schema.Schema.Type<typeof InstallPluginRequestDTO>;

export const PluginApprovalRequestDTO = Schema.Struct({
  pluginId: UserPluginId,
  settings: PluginSettingsRecord,
  /** Each local/private origin must map to the same string typed by the user. */
  typedConfirmations: Schema.Record(
    Schema.String.pipe(Schema.check(Schema.isMaxLength(2048))),
    Schema.String.pipe(Schema.check(Schema.isMaxLength(2048))),
  ).pipe(
    Schema.refine((value): value is typeof value => Object.keys(value).length <= 16, {
      message: "plugin typed confirmations exceed 16 entries",
    }),
  ),
});
export type PluginApprovalRequestDTO = Schema.Schema.Type<typeof PluginApprovalRequestDTO>;

export const PluginApprovalPreviewRequestDTO = Schema.Struct({
  pluginId: UserPluginId,
  settings: PluginSettingsRecord,
});
export type PluginApprovalPreviewRequestDTO = Schema.Schema.Type<
  typeof PluginApprovalPreviewRequestDTO
>;

export const PluginApprovalPreviewDTO = Schema.Struct({
  binding: PluginApprovalBindingDTO,
  typedConfirmationOrigins: Schema.Array(Schema.String),
});
export type PluginApprovalPreviewDTO = Schema.Schema.Type<typeof PluginApprovalPreviewDTO>;

export const RemovePluginRequestDTO = Schema.Struct({ pluginId: UserPluginId });
export type RemovePluginRequestDTO = Schema.Schema.Type<typeof RemovePluginRequestDTO>;

export const TestPluginRequestDTO = Schema.Struct({ pluginId: UserPluginId });
export type TestPluginRequestDTO = Schema.Schema.Type<typeof TestPluginRequestDTO>;

export const TestPluginResultDTO = Schema.Struct({
  pluginId: UserPluginId,
  snapshot: UsageSnapshot,
});
export type TestPluginResultDTO = Schema.Schema.Type<typeof TestPluginResultDTO>;
