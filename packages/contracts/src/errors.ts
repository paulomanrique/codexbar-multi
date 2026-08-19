import * as Schema from "effect/Schema";
import { ProviderId } from "./provider.ts";

export const ProviderFetchErrorKind = Schema.Literals([
  "authentication-expired",
  "missing-credential",
  "permission-denied",
  "rate-limited",
  "provider-unavailable",
  "parse-failure",
  "network-failure",
  "api-failure",
]);
export type ProviderFetchErrorKind = Schema.Schema.Type<typeof ProviderFetchErrorKind>;
export const ProviderErrorKind = ProviderFetchErrorKind;
export type ProviderErrorKind = ProviderFetchErrorKind;

export const ProviderFetchClassifiedError = Schema.Struct({
  kind: ProviderFetchErrorKind,
  message: Schema.String,
  retryAfterSeconds: Schema.optional(Schema.Number),
  /** Adapter-friendly alias; Swift's wire form remains retryAfterSeconds. */
  retryAfterMs: Schema.optional(Schema.Number),
});
export type ProviderFetchClassifiedError = Schema.Schema.Type<typeof ProviderFetchClassifiedError>;
export const ClassifiedProviderError = ProviderFetchClassifiedError;
export type ClassifiedProviderError = ProviderFetchClassifiedError;

export const IPCErrorKind = Schema.Literals(["args", "config", "provider", "runtime"]);
export type IPCErrorKind = Schema.Schema.Type<typeof IPCErrorKind>;
export const ProviderError = Schema.Struct({
  code: Schema.Number,
  message: Schema.String,
  kind: Schema.optional(IPCErrorKind),
  provider: Schema.optional(ProviderId),
  classified: Schema.optional(ProviderFetchClassifiedError),
});
export type ProviderError = Schema.Schema.Type<typeof ProviderError>;
