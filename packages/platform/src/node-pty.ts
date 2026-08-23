import { Effect } from "effect";
import {
  InfrastructureError,
  type PtyRunnerService,
  type PtySession,
  type PtySpec,
} from "@codexbar/core";
import { terminateProcessTree } from "./node-process-terminator.ts";

export interface NodePtyHandle {
  readonly pid: number;
  readonly onData: (callback: (data: string) => void) => { readonly dispose: () => void };
  readonly onExit: (callback: (exit: { exitCode: number; signal?: number }) => void) => {
    readonly dispose: () => void;
  };
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: (signal?: string) => void;
}

export interface NodePtyRunnerOptions {
  readonly platform?: NodeJS.Platform;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly maximumOutputBytes?: number;
  /** Host-owned spawn seam. Only the Electron desktop adapter imports `node-pty`. */
  readonly spawnImpl: (
    command: string,
    args: readonly string[],
    options: {
      readonly name: string;
      readonly cols: number;
      readonly rows: number;
      readonly cwd?: string;
      readonly env: Record<string, string>;
    },
  ) => NodePtyHandle;
  readonly terminator?: (pid: number) => Promise<void>;
}

export interface NodePtySession extends PtySession {
  readonly pid: number;
  readonly exitCode: () => number | undefined;
  readonly exitSignal: () => string | undefined;
}

const MAXIMUM_PTY_OUTPUT_BYTES = 1024 * 1024;

const abortError = (): Error => {
  const error = new Error("Process execution was cancelled.");
  error.name = "AbortError";
  return error;
};

export const makeNodePtyRunner = (options: NodePtyRunnerOptions): PtyRunnerService => {
  const platform = options.platform ?? process.platform;
  const maximumOutputBytes = options.maximumOutputBytes ?? MAXIMUM_PTY_OUTPUT_BYTES;
  const terminator =
    options.terminator ??
    ((pid: number) =>
      terminateProcessTree(pid, { platform, environment: options.environment ?? process.env }));
  return {
    start: (spec: PtySpec) =>
      Effect.tryPromise({
        try: async (signal) => {
          if (
            spec.command.includes("\u0000") ||
            (spec.args ?? []).some((arg) => arg.includes("\u0000"))
          )
            throw new Error("PTY spec contains NUL");
          const cols = spec.columns ?? 160;
          const rows = spec.rows ?? 50;
          const env: Record<string, string> = {};
          for (const [key, value] of Object.entries(spec.env ?? {})) {
            if (value === undefined) continue;
            if (key.includes("\u0000") || value.includes("\u0000"))
              throw new Error("PTY env contains NUL");
            env[key] = value;
          }
          const ptyOptions = {
            name: "xterm-256color",
            cols,
            rows,
            ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
            env,
          };
          const pty = options.spawnImpl(spec.command, spec.args ?? [], ptyOptions);

          let closed = false;
          let closePromise: Promise<void> | undefined;
          let disposing = false;
          let outputTooLarge = false;
          let capturedExitCode: number | undefined;
          let capturedExitSignal: string | undefined;
          const chunks: string[] = [];
          let totalBytes = 0;
          let dataDisposable: { dispose: () => void } | undefined;
          let exitDisposable: { dispose: () => void } | undefined;

          const disposeHandlers = (): void => {
            if (disposing) return;
            disposing = true;
            try {
              dataDisposable?.dispose();
            } catch {
              // Handler disposal is best-effort and must run once.
            }
            try {
              exitDisposable?.dispose();
            } catch {
              // Same once-only contract for onExit.
            }
          };

          dataDisposable = pty.onData((data: string) => {
            const bytes = Buffer.byteLength(data, "utf8");
            totalBytes += bytes;
            if (totalBytes > maximumOutputBytes) {
              outputTooLarge = true;
              try {
                pty.kill();
              } catch {
                // Close path awaits the tree terminator.
              }
              return;
            }
            chunks.push(data);
          });
          exitDisposable = pty.onExit((exit) => {
            capturedExitCode = exit.exitCode;
            capturedExitSignal = exit.signal === undefined ? undefined : String(exit.signal);
          });

          const closeSession = async (): Promise<void> => {
            if (closePromise !== undefined) return closePromise;
            closePromise = (async () => {
              closed = true;
              signal.removeEventListener("abort", abortHandler);
              disposeHandlers();
              try {
                pty.kill();
              } catch {
                // Tree terminator is the source of truth for descendant cleanup.
              }
              await terminator(pty.pid);
            })();
            return closePromise;
          };

          const abortHandler = (): void => {
            void closeSession();
          };
          if (signal.aborted) {
            await closeSession();
            throw abortError();
          }
          signal.addEventListener("abort", abortHandler, { once: true });

          const session: NodePtySession = {
            pid: pty.pid,
            exitCode: () => capturedExitCode,
            exitSignal: () => capturedExitSignal,
            write: (input: Uint8Array) =>
              Effect.tryPromise({
                try: async () => {
                  if (closed) throw new Error("PTY closed");
                  if (input.byteLength > maximumOutputBytes)
                    throw new Error("PTY write exceeds 1 MiB");
                  if (input.includes(0)) throw new Error("PTY write contains NUL");
                  pty.write(new TextDecoder("utf-8", { fatal: true }).decode(input));
                },
                catch: (error) => new InfrastructureError("write pty", "PTY write failed", error),
              }),
            read: Effect.tryPromise({
              try: async () => {
                if (outputTooLarge) throw new Error("PTY output exceeded 1 MiB");
                return new TextEncoder().encode(chunks.join(""));
              },
              catch: (error) => new InfrastructureError("read pty", "PTY read failed", error),
            }),
            resize: (columns: number, rowCount: number) =>
              Effect.try({
                try: () => pty.resize(columns, rowCount),
                catch: (error) => new InfrastructureError("resize pty", "PTY resize failed", error),
              }),
            close: Effect.tryPromise({
              try: () => closeSession(),
              catch: (error) => new InfrastructureError("close pty", "PTY close failed", error),
            }),
          };
          return session;
        },
        catch: (error) => new InfrastructureError("start pty", "Unable to start PTY", error),
      }),
  };
};
