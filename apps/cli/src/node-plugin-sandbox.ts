import { fork, type ChildProcess } from "node:child_process";
import { extname } from "node:path";
import { isSea } from "node:sea";
import { fileURLToPath } from "node:url";

import {
  PluginSandboxClient,
  type PluginSandboxRequest,
  type PluginSandboxTransport,
} from "@codexbar/plugin-runtime";
import { seaPluginSandboxChildEnvironmentKey } from "./plugin-sandbox-sea.ts";

export const makePluginSandboxEnvironment = (
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv =>
  Object.fromEntries(
    [
      "LANG",
      "LC_ALL",
      "LC_CTYPE",
      "TZ",
      "SYSTEMROOT",
      "WINDIR",
      "COMSPEC",
      "PATHEXT",
      "TEMP",
      "TMP",
    ].flatMap((key) => (environment[key] === undefined ? [] : [[key, environment[key]] as const])),
  );

class NodePluginSandboxTransport implements PluginSandboxTransport {
  private readonly child: ChildProcess;

  constructor(entry: URL | undefined) {
    const sea = isSea();
    const path = sea ? process.execPath : fileURLToPath(entry as URL);
    this.child = fork(path, [], {
      // The child speaks a small structured protocol.  It receives no shell,
      // stdio input, or inherited IPC endpoint beyond this one channel.
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "advanced",
      // A QuickJS guest has no Node globals, but the host child should not
      // inherit provider tokens or arbitrary user environment values either.
      env: {
        ...makePluginSandboxEnvironment(),
        ...(sea ? { [seaPluginSandboxChildEnvironmentKey]: "1" } : {}),
      },
      ...(!sea && extname(path) === ".ts" ? { execArgv: ["--experimental-strip-types"] } : {}),
    });
  }

  postMessage(message: PluginSandboxRequest): void {
    if (!this.child.send(message)) throw new Error("plugin sandbox IPC is closed");
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.child.on("message", listener);
    return () => this.child.off("message", listener);
  }

  onExit(listener: () => void): () => void {
    this.child.once("exit", listener);
    return () => this.child.off("exit", listener);
  }

  kill(): void {
    this.child.kill("SIGKILL");
  }
}

/** Lazy disposable Node child for untrusted CLI plugins; no Electron required. */
export const makeNodePluginSandbox = (
  entry = !isSea()
    ? new URL(
        extname(fileURLToPath(import.meta.url)) === ".ts"
          ? "./plugin-sandbox-child.ts"
          : "./plugin-sandbox-child.js",
        import.meta.url,
      )
    : undefined,
): PluginSandboxClient => new PluginSandboxClient(() => new NodePluginSandboxTransport(entry));
