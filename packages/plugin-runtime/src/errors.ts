export type PluginErrorKind =
  | "load"
  | "invalid-manifest"
  | "network-policy"
  | "http"
  | "secret-access"
  | "invalid-snapshot"
  | "script"
  | "timed-out"
  | "cancelled"
  | "terminated"
  | "approval-drift"
  | "approval-required"
  | "response-too-large";

export class PluginRuntimeError extends Error {
  readonly kind: PluginErrorKind;

  constructor(kind: PluginErrorKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PluginRuntimeError";
    this.kind = kind;
  }
}
