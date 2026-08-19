export const PluginRuntimeLimits = Object.freeze({
  maximumSourceBytes: 1024 * 1024,
  maximumResponseBytes: 1024 * 1024,
  memoryBytes: 64 * 1024 * 1024,
  stackBytes: 2 * 1024 * 1024,
  executionTimeoutMs: 20_000,
  requestTimeoutMs: 15_000,
});

export type PluginRuntimeLimits = typeof PluginRuntimeLimits;
