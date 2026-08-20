import { utilityProcess, type UtilityProcess } from "electron";
import { fileURLToPath } from "node:url";

import {
  PluginSandboxClient,
  type PluginSandboxRequest,
  type PluginSandboxTransport,
} from "@codexbar/plugin-runtime";

class ElectronUtilityTransport implements PluginSandboxTransport {
  private readonly child: UtilityProcess;

  constructor(entryUrl: URL) {
    this.child = utilityProcess.fork(fileURLToPath(entryUrl), [], {
      serviceName: "CodexBar Multi Plugin Sandbox",
    });
  }

  postMessage(message: PluginSandboxRequest): void {
    this.child.postMessage(message);
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.child.on("message", listener);
    return () => this.child.off("message", listener);
  }

  onExit(listener: () => void): () => void {
    const wrapped = () => listener();
    this.child.on("exit", wrapped);
    return () => this.child.off("exit", wrapped);
  }

  kill(): void {
    this.child.kill();
  }
}

/** Creates a lazy, kill-and-recreate QuickJS utility process owned by Electron main. */
export function makeElectronPluginSandbox(
  entryUrl = new URL(/* @vite-ignore */ "./plugin-sandbox-child.js", import.meta.url),
): PluginSandboxClient {
  return new PluginSandboxClient(() => new ElectronUtilityTransport(entryUrl));
}
