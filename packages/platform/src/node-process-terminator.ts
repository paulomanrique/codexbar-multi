import { execFile } from "node:child_process";
import { win32 } from "node:path";

export interface NodeProcessTreeTerminatorOptions {
  readonly platform?: NodeJS.Platform;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** Injectable for synthetic tests; production uses `execFile` with no shell. */
  readonly execFileImpl?: (
    file: string,
    args: readonly string[],
    options: { readonly windowsHide: boolean; readonly shell: false },
    callback: (error: Error | null) => void,
  ) => unknown;
  /** Injectable POSIX kill; production uses `process.kill`. */
  readonly killImpl?: (pid: number, signal: NodeJS.Signals) => void;
}

const WINDOWS_TASKKILL = "taskkill.exe";

const isUsablePid = (pid: number): boolean => Number.isSafeInteger(pid) && pid > 0;

/**
 * Absolute `System32\\taskkill.exe` using win32 path semantics even when the
 * host running the test is not Windows. SYSTEMROOT/WINDIR win when present.
 */
export const resolveTaskKillPath = (
  environment: Readonly<Record<string, string | undefined>> = {},
  platform: NodeJS.Platform = "win32",
): string => {
  if (platform !== "win32") return WINDOWS_TASKKILL;
  const systemRoot = environment.SYSTEMROOT?.trim() || environment.WINDIR?.trim() || "C:\\Windows";
  return win32.join(systemRoot, "System32", WINDOWS_TASKKILL);
};

const killPosixProcessGroup = (
  pid: number,
  killImpl: (pid: number, signal: NodeJS.Signals) => void,
): void => {
  try {
    killImpl(-pid, "SIGKILL");
    return;
  } catch {
    // The child must be a process-group leader (`detached: true` on spawn).
  }
  try {
    killImpl(pid, "SIGKILL");
  } catch {
    // Already reaped.
  }
};

/**
 * Awaited descendant-tree termination. Windows uses fixed absolute System32
 * `taskkill.exe /T /F /PID` with no shell. POSIX sends SIGKILL to the process
 * group (`-pid`); callers must spawn with `detached: true` so the child is a
 * group leader.
 */
export const terminateProcessTree = async (
  pid: number,
  options: NodeProcessTreeTerminatorOptions = {},
): Promise<void> => {
  if (!isUsablePid(pid)) return;
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    const killImpl = options.killImpl ?? ((target, signal) => process.kill(target, signal));
    killPosixProcessGroup(pid, killImpl);
    return;
  }
  const environment = options.environment ?? process.env;
  const taskkill = resolveTaskKillPath(environment, platform);
  const execFileImpl = options.execFileImpl ?? execFile;
  await new Promise<void>((resolve, reject) => {
    execFileImpl(
      taskkill,
      ["/T", "/F", "/PID", String(pid)],
      { windowsHide: true, shell: false },
      (error) => {
        if (error !== null) reject(error);
        else resolve();
      },
    );
  });
};
