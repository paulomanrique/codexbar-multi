import { describe, expect, it } from "vite-plus/test";
import { resolveCLIConfigPath } from "../src/config-path.ts";

describe("CLI config path", () => {
  it("honors only an explicit CODEXBAR_CONFIG override", () => {
    expect(
      resolveCLIConfigPath({ CODEXBAR_CONFIG: "~/private/config.json" }, "linux", "/home/tester"),
    ).toBe("/home/tester/private/config.json");
    expect(
      resolveCLIConfigPath(
        { CODEXBAR_CONFIG: "/var/tmp/config.json" },
        "win32",
        "C:\\Users\\tester",
      ),
    ).toBe("/var/tmp/config.json");
    expect(
      resolveCLIConfigPath(
        { CODEXBAR_CONFIG: "C:\\private\\config.json" },
        "win32",
        "C:\\Users\\tester",
      ),
    ).toBe("C:\\private\\config.json");
  });

  it("keeps the multi namespace separate on each host", () => {
    expect(resolveCLIConfigPath({ XDG_CONFIG_HOME: "/tmp/xdg" }, "linux", "/home/tester")).toBe(
      "/tmp/xdg/codexbar-multi/config.json",
    );
    expect(
      resolveCLIConfigPath(
        { APPDATA: "C:\\Users\\tester\\AppData\\Roaming" },
        "win32",
        "C:\\Users\\tester",
      ),
    ).toBe("C:\\Users\\tester\\AppData\\Roaming\\codexbar-multi\\config.json");
    expect(resolveCLIConfigPath({}, "darwin", "/home/tester")).toBe(
      "/home/tester/.config/codexbar-multi/config.json",
    );
  });
});
