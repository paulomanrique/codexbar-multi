import {
  inspectPlugin,
  pluginSandboxFailure,
  PluginExecutionCache,
  PluginSandboxProtocolVersion,
  QuickJsPluginExecution,
  type PluginSandboxBrokerResponse,
  type PluginSandboxCapabilityResponse,
  type PluginSandboxExecuteRequest,
  type PluginSandboxInspectSuccess,
  type PluginSandboxRequest,
} from "@codexbar/plugin-runtime";

/**
 * Node CLI counterpart to Electron's utility-process guest.  It deliberately
 * speaks only the plugin sandbox protocol over the fork IPC channel: no host
 * filesystem, keyring, HTTP client, or environment values are passed to the
 * QuickJS guest.
 */
const activeExecutions = new Map<string, QuickJsPluginExecution>();
const executionCache = new PluginExecutionCache();

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isRequest = (value: unknown): value is PluginSandboxRequest => {
  if (
    !record(value) ||
    value.version !== PluginSandboxProtocolVersion ||
    typeof value.type !== "string"
  )
    return false;
  if (value.type === "inspect")
    return (
      typeof value.id === "string" && typeof value.source === "string" && record(value.options)
    );
  if (value.type === "execute")
    return (
      typeof value.id === "string" &&
      typeof value.source === "string" &&
      record(value.context) &&
      record(value.manifest) &&
      record(value.settings) &&
      record(value.settings.plain) &&
      record(value.settings.secure)
    );
  return (
    (value.type === "broker-response" &&
      typeof value.executionId === "string" &&
      record(value.message)) ||
    (value.type === "capability-response" &&
      typeof value.executionId === "string" &&
      typeof value.id === "string" &&
      typeof value.ok === "boolean")
  );
};

const post = (message: unknown): void => {
  process.send?.(message);
};

process.on("message", (message: unknown) => {
  if (!isRequest(message)) return;
  if (message.type === "broker-response" || message.type === "capability-response") {
    activeExecutions
      .get(message.executionId)
      ?.receive(message as PluginSandboxBrokerResponse | PluginSandboxCapabilityResponse);
    return;
  }
  if (message.type === "inspect") {
    void inspectPlugin(message.source, message.options)
      .then((plugin) => {
        const response: PluginSandboxInspectSuccess = {
          version: PluginSandboxProtocolVersion,
          type: "inspect-result",
          id: message.id,
          ok: true,
          plugin,
        };
        post(response);
      })
      .catch((cause: unknown) => post(pluginSandboxFailure(message.id, cause)));
    return;
  }
  void execute(message);
});

async function execute(request: PluginSandboxExecuteRequest): Promise<void> {
  try {
    // Re-inspect in the disposable process: a source swapped after host-side
    // approval cannot borrow a different manifest's capability binding.
    const inspected = await inspectPlugin(request.source, { allowsDynamicId: true });
    if (JSON.stringify(inspected.manifest) !== JSON.stringify(request.manifest))
      throw new Error("plugin source no longer matches its approved manifest");
    const execution = new QuickJsPluginExecution(
      request.id,
      (message) => {
        if (message.type === "capability-request") post(message);
        else
          post({
            version: PluginSandboxProtocolVersion,
            type: "broker-request",
            executionId: request.id,
            message,
          });
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
    post({
      version: PluginSandboxProtocolVersion,
      type: "execute-result",
      id: request.id,
      ok: true,
      value,
    });
  } catch (cause) {
    post(pluginSandboxFailure(request.id, cause, "execute-result"));
  } finally {
    activeExecutions.delete(request.id);
  }
}
