import { describe, expect, it } from "vite-plus/test";

import { makePluginSandboxEnvironment } from "../src/node-plugin-sandbox.ts";

describe("Node plugin sandbox child environment", () => {
  it("passes only runtime-safe environment entries to the disposable child", () => {
    expect(
      makePluginSandboxEnvironment({
        CODEXBAR_MULTI_TOKEN: "must-not-cross",
        OPENAI_API_KEY: "must-not-cross",
        LANG: "en_US.UTF-8",
        SYSTEMROOT: "C:\\Windows",
        PATH: "/private/bin",
      }),
    ).toEqual({ LANG: "en_US.UTF-8", SYSTEMROOT: "C:\\Windows" });
  });
});
