import { describe, expect, it } from "vite-plus/test";

import { PluginSandboxProtocolVersion } from "@codexbar/plugin-runtime";

import { routePluginSandboxOutbound } from "../src/main/plugin-sandbox-router.ts";

describe("plugin utility-process outbound router", () => {
  it("forwards per-key setting and cookie capabilities without wrapping them as HTTP", () => {
    const setting = routePluginSandboxOutbound("execution-1", {
      version: PluginSandboxProtocolVersion,
      type: "capability-request",
      executionId: "execution-1",
      id: "capability-1",
      capability: "setting",
      key: "apiKey",
      secure: true,
    });
    expect(setting).toEqual(
      expect.objectContaining({ type: "capability-request", key: "apiKey", secure: true }),
    );

    const cookie = routePluginSandboxOutbound("execution-1", {
      version: PluginSandboxProtocolVersion,
      type: "capability-request",
      executionId: "execution-1",
      id: "capability-2",
      capability: "cookie",
      key: "example.com",
    });
    expect(cookie).toEqual(
      expect.objectContaining({ type: "capability-request", key: "example.com" }),
    );
  });

  it("wraps only broker HTTP requests with the execution id", () => {
    const outbound = routePluginSandboxOutbound("execution-2", {
      version: 1,
      type: "http",
      id: "request-1",
      request: { url: "https://api.example.com" },
    });
    expect(outbound).toMatchObject({
      type: "broker-request",
      executionId: "execution-2",
      message: { type: "http" },
    });
  });
});
