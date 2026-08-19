import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { LoginRequestDTO } from "@codexbar/contracts";

import { DesktopChannels } from "../src/ipc/api.ts";

describe("desktop IPC boundary", () => {
  it("rejects invalid account and provider input before a handler runs", () => {
    const decode = Schema.decodeUnknownSync(LoginRequestDTO);
    expect(() => decode({ provider: "not-first-party", accountId: "default" })).toThrow();
    expect(() => decode({ provider: "t3chat", accountId: "../../escape" })).toThrow();
  });

  it("uses unique, high-level channels", () => {
    const channels = Object.values(DesktopChannels);
    expect(new Set(channels)).toHaveLength(channels.length);
    expect(channels.every((channel) => channel.startsWith("codexbar-multi:"))).toBe(true);
  });
});
