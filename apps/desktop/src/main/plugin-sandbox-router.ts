import {
  PluginSandboxProtocolVersion,
  type PluginBrokerRequestMessage,
  type PluginSandboxCapabilityRequest,
} from "@codexbar/plugin-runtime";

/** Preserves the capability envelope emitted by the child; only HTTP needs wrapping. */
export function routePluginSandboxOutbound(
  executionId: string,
  message: PluginBrokerRequestMessage | PluginSandboxCapabilityRequest,
):
  | PluginSandboxCapabilityRequest
  | {
      readonly version: typeof PluginSandboxProtocolVersion;
      readonly type: "broker-request";
      readonly executionId: string;
      readonly message: PluginBrokerRequestMessage;
    } {
  if (message.type === "capability-request") return message;
  return { version: PluginSandboxProtocolVersion, type: "broker-request", executionId, message };
}
