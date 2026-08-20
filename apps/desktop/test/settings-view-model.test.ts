import { describe, expect, it } from "vite-plus/test";

import { isAvailableProviderSource } from "../src/renderer/settings-view-model.ts";

describe("settings view model", () => {
  it("offers only sources granted by the provider settings projection", () => {
    expect(isAvailableProviderSource("api", ["auto", "api"])).toBe(true);
    expect(isAvailableProviderSource("web", ["auto", "api"])).toBe(false);
    expect(isAvailableProviderSource("endpoint-override", ["auto", "web"])).toBe(false);
  });
});
