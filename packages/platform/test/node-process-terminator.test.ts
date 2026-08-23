import { describe, expect, it } from "vite-plus/test";
import { resolveTaskKillPath, terminateProcessTree } from "../src/node-process-terminator.ts";

describe("process tree terminator", () => {
  it("uses win32 System32 semantics for taskkill even on a POSIX host", () => {
    expect(resolveTaskKillPath({ SYSTEMROOT: "D:\\Windows" }, "win32")).toBe(
      "D:\\Windows\\System32\\taskkill.exe",
    );
    expect(resolveTaskKillPath({ WINDIR: "C:\\Windows" }, "win32")).toBe(
      "C:\\Windows\\System32\\taskkill.exe",
    );
    expect(resolveTaskKillPath({}, "win32")).toBe("C:\\Windows\\System32\\taskkill.exe");
    expect(resolveTaskKillPath({}, "linux")).toBe("taskkill.exe");
  });

  it("awaits Windows taskkill /T /F /PID with no shell", async () => {
    const calls: Array<{
      readonly file: string;
      readonly args: readonly string[];
      readonly options: { readonly windowsHide: boolean; readonly shell: false };
    }> = [];
    await terminateProcessTree(4242, {
      platform: "win32",
      environment: { SYSTEMROOT: "C:\\Windows" },
      execFileImpl: (file, args, options, callback) => {
        calls.push({ file, args: [...args], options });
        callback(null);
      },
    });
    expect(calls).toEqual([
      {
        file: "C:\\Windows\\System32\\taskkill.exe",
        args: ["/T", "/F", "/PID", "4242"],
        options: { windowsHide: true, shell: false },
      },
    ]);
  });

  it("POSIX terminator kills the process group, not only one PID", async () => {
    const killed: Array<{ readonly pid: number; readonly signal: NodeJS.Signals }> = [];
    await terminateProcessTree(99, {
      platform: "linux",
      killImpl: (pid, signal) => {
        killed.push({ pid, signal });
      },
    });
    expect(killed).toEqual([{ pid: -99, signal: "SIGKILL" }]);
  });
});
