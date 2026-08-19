import { getQuickJS, type QuickJSContext, type QuickJSRuntime } from "quickjs-emscripten";
import { transform } from "sucrase";

import { PluginRuntimeError } from "./errors.js";
import { PluginRuntimeLimits } from "./limits.js";
import { parsePluginManifest, type PluginManifest } from "./manifest.js";

export interface LoadedPlugin {
  readonly manifest: PluginManifest;
  readonly transpiledSource: string;
}

function ensureSourceLimit(source: string): void {
  if (new TextEncoder().encode(source).byteLength > PluginRuntimeLimits.maximumSourceBytes) {
    throw new PluginRuntimeError("load", "plugin exceeds the 1 MiB source limit");
  }
}

function transpile(source: string, language: "javascript" | "typescript"): string {
  if (language === "javascript") return source;
  try {
    return transform(source, { transforms: ["typescript"] }).code;
  } catch (cause) {
    throw new PluginRuntimeError("load", "TypeScript transpilation failed", { cause });
  }
}

export async function inspectPlugin(
  source: string,
  options: {
    readonly language?: "javascript" | "typescript";
    readonly allowsDynamicId?: boolean;
  } = {},
): Promise<LoadedPlugin> {
  ensureSourceLimit(source);
  const transpiledSource = transpile(source, options.language ?? "javascript");
  const quickJs = await getQuickJS();
  let runtime: QuickJSRuntime | undefined;
  let context: QuickJSContext | undefined;
  try {
    runtime = quickJs.newRuntime();
    runtime.setMemoryLimit(PluginRuntimeLimits.memoryBytes);
    runtime.setMaxStackSize(PluginRuntimeLimits.stackBytes);
    const deadline = Date.now() + PluginRuntimeLimits.executionTimeoutMs;
    runtime.setInterruptHandler(() => Date.now() >= deadline);
    context = runtime.newContext();
    let definition: unknown;
    const defineProvider = context.newFunction("defineProvider", (value) => {
      definition = context?.dump(value);
      return context?.undefined;
    });
    context.setProp(context.global, "defineProvider", defineProvider);
    defineProvider.dispose();
    const result = context.evalCode(`"use strict";\n${transpiledSource}`, "provider-plugin.js");
    if (result.error !== undefined) {
      const dumped = context.dump(result.error);
      result.error.dispose();
      const message =
        typeof dumped === "object" && dumped !== null && "message" in dumped
          ? String(dumped.message)
          : String(dumped);
      if (Date.now() >= deadline || /interrupted/i.test(message))
        throw new PluginRuntimeError("timed-out", "Provider plugin timed out");
      throw new PluginRuntimeError("script", message);
    }
    result.value.dispose();
    if (definition === undefined)
      throw new PluginRuntimeError("invalid-manifest", "plugin did not call defineProvider(...)");
    return { manifest: parsePluginManifest(definition, options), transpiledSource };
  } finally {
    context?.dispose();
    runtime?.dispose();
  }
}
