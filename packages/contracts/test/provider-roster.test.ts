import { describe, expect, it } from "vite-plus/test";
import { PROVIDER_IDS, ProviderId, ProviderInstanceId } from "../src/provider.ts";
import * as Schema from "effect/Schema";

describe("provider roster parity", () => {
  it("contains exactly the 69 baseline IDs once, in source order", () => {
    expect(PROVIDER_IDS).toHaveLength(69);
    expect(new Set(PROVIDER_IDS).size).toBe(69);
    expect(Schema.decodeUnknownSync(ProviderId)("codex")).toBe("codex");
    expect(() => Schema.decodeUnknownSync(ProviderId)("not-a-provider")).toThrow();
  });

  it("keeps plugin instance IDs bounded and lowercase", () => {
    expect(Schema.decodeUnknownSync(ProviderInstanceId)("my-provider-1")).toBe("my-provider-1");
    expect(() => Schema.decodeUnknownSync(ProviderInstanceId)("Bad Provider")).toThrow();
  });
});
