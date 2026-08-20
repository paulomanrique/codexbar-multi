import {
  inspectPlugin,
  pluginSandboxFailure,
  PluginSandboxProtocolVersion,
  PluginExecutionCache,
  QuickJsPluginExecution,
  type PluginSandboxBrokerResponse,
  type PluginSandboxCapabilityResponse,
  type PluginSandboxExecuteRequest,
  type PluginSandboxInspectSuccess,
  type PluginSandboxRequest,
} from "@codexbar/plugin-runtime";

import { routePluginSandboxOutbound } from "./plugin-sandbox-router.js";

const parentPort = process.parentPort;
const activeExecutions = new Map<string, QuickJsPluginExecution>();
const executionCache = new PluginExecutionCache();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRequest(value: unknown): value is PluginSandboxRequest {
  if (
    !isRecord(value) ||
    value.version !== PluginSandboxProtocolVersion ||
    typeof value.type !== "string"
  )
    return false;
  if (value.type === "inspect")
    return (
      typeof value.id === "string" && typeof value.source === "string" && isRecord(value.options)
    );
  if (value.type === "execute")
    return (
      typeof value.id === "string" &&
      typeof value.source === "string" &&
      isRecord(value.context) &&
      isRecord(value.manifest) &&
      isRecord(value.settings) &&
      isRecord(value.settings.plain) &&
      isRecord(value.settings.secure)
    );
  return (
    (value.type === "broker-response" &&
      typeof value.executionId === "string" &&
      isRecord(value.message)) ||
    (value.type === "capability-response" &&
      typeof value.executionId === "string" &&
      typeof value.id === "string" &&
      typeof value.ok === "boolean")
  );
}

if (parentPort === undefined) throw new Error("plugin sandbox requires an Electron parent port");

parentPort.on("message", (event) => {
  const request = event.data;
  if (!isRequest(request)) return;
  if (request.type === "broker-response" || request.type === "capability-response") {
    activeExecutions
      .get(request.executionId)
      ?.receive(request as PluginSandboxBrokerResponse | PluginSandboxCapabilityResponse);
    return;
  }
  if (request.type === "inspect") {
    void inspectPlugin(request.source, request.options)
      .then((plugin) => {
        const response: PluginSandboxInspectSuccess = {
          version: PluginSandboxProtocolVersion,
          type: "inspect-result",
          id: request.id,
          ok: true,
          plugin,
        };
        parentPort.postMessage(response);
      })
      .catch((cause: unknown) => parentPort.postMessage(pluginSandboxFailure(request.id, cause)));
    return;
  }
  void execute(request);
});

async function execute(request: PluginSandboxExecuteRequest): Promise<void> {
  try {
    // Bind the source actually evaluated in this utility process to the manifest that
    // Electron main used for approval. A swapped source cannot inherit an older grant.
    const inspected = await inspectPlugin(request.source, { allowsDynamicId: true });
    if (JSON.stringify(inspected.manifest) !== JSON.stringify(request.manifest))
      throw new Error("plugin source no longer matches its approved manifest");
    const execution = new QuickJsPluginExecution(
      request.id,
      (message) => {
        parentPort.postMessage(routePluginSandboxOutbound(request.id, message));
      },
      { pluginId: request.manifest.id, cache: executionCache },
    );
    activeExecutions.set(request.id, execution);
    const value = await execution.execute(request.source, {
      ...request.context,
      settings: request.settings,
      settingKinds: Object.fromEntries(
        request.manifest.settings.map((setting) => [setting.key, setting.type]),
      ),
    });
    parentPort.postMessage({
      version: PluginSandboxProtocolVersion,
      type: "execute-result",
      id: request.id,
      ok: true,
      value,
    });
  } catch (cause) {
    parentPort.postMessage(pluginSandboxFailure(request.id, cause, "execute-result"));
  } finally {
    activeExecutions.delete(request.id);
  }
}
