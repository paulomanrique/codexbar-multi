import * as Schema from "effect/Schema";
import { ProviderId, ProviderInstanceId, ProviderSourceMode, ProviderStatus } from "./provider.ts";
import { ProviderError } from "./errors.ts";
import { ProviderCost, ProviderIdentity, UsageSnapshot } from "./usage.ts";

export const ProviderPayload = Schema.Struct({
  provider: ProviderInstanceId,
  account: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
  source: ProviderSourceMode,
  status: Schema.optional(ProviderStatus),
  usage: Schema.optional(UsageSnapshot),
  error: Schema.optional(ProviderError),
});
export type ProviderPayload = Schema.Schema.Type<typeof ProviderPayload>;
export const ProviderUsageDTO = ProviderPayload;
export type ProviderUsageDTO = ProviderPayload;

export const DashboardWindowDTO = Schema.Struct({
  kind: Schema.String,
  label: Schema.String,
  usedPercent: Schema.Number,
  remainingPercent: Schema.Number,
  resetAt: Schema.optional(Schema.String),
});
export type DashboardWindowDTO = Schema.Schema.Type<typeof DashboardWindowDTO>;

export const DashboardProviderDTO = Schema.Struct({
  id: ProviderInstanceId,
  name: Schema.String,
  enabled: Schema.Boolean,
  source: ProviderSourceMode,
  status: Schema.optional(ProviderStatus),
  identity: Schema.optional(ProviderIdentity),
  windows: Schema.Array(DashboardWindowDTO),
  cost: Schema.optional(ProviderCost),
  error: Schema.optional(ProviderError),
  updatedAt: Schema.optional(Schema.String),
});
export type DashboardProviderDTO = Schema.Schema.Type<typeof DashboardProviderDTO>;

export const DashboardSnapshotDTO = Schema.Struct({
  schemaVersion: Schema.Number,
  generatedAt: Schema.String,
  staleAfterSeconds: Schema.Number,
  providers: Schema.Array(DashboardProviderDTO),
});
export type DashboardSnapshotDTO = Schema.Schema.Type<typeof DashboardSnapshotDTO>;

export const LoginRequestDTO = Schema.Struct({
  provider: ProviderId,
  accountId: Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/))),
});
export type LoginRequestDTO = Schema.Schema.Type<typeof LoginRequestDTO>;

export const LoginResultDTO = Schema.Struct({
  provider: ProviderId,
  accountId: Schema.String,
  status: Schema.Literals(["connected", "cancelled"]),
});
export type LoginResultDTO = Schema.Schema.Type<typeof LoginResultDTO>;

export const IPCRequest = Schema.Union([
  Schema.Struct({ type: Schema.Literal("get-usage"), provider: Schema.optional(ProviderId) }),
  Schema.Struct({ type: Schema.Literal("get-config") }),
  Schema.Struct({
    type: Schema.Literal("set-provider-enabled"),
    provider: ProviderInstanceId,
    enabled: Schema.Boolean,
  }),
  Schema.Struct({ type: Schema.Literal("start-login"), request: LoginRequestDTO }),
  Schema.Struct({ type: Schema.Literal("cancel-login"), request: LoginRequestDTO }),
  Schema.Struct({ type: Schema.Literal("logout"), request: LoginRequestDTO }),
]);
export type IPCRequest = Schema.Schema.Type<typeof IPCRequest>;

export const IPCResponse = Schema.Union([
  Schema.Struct({ type: Schema.Literal("usage"), payload: ProviderPayload }),
  Schema.Struct({ type: Schema.Literal("dashboard"), payload: DashboardSnapshotDTO }),
  Schema.Struct({ type: Schema.Literal("config"), payload: Schema.Unknown }),
  Schema.Struct({ type: Schema.Literal("error"), error: ProviderError }),
]);
export type IPCResponse = Schema.Schema.Type<typeof IPCResponse>;
