import { describe, expect, it } from "vite-plus/test";

import { CANONICAL_PROVIDER_IDS, FIRST_PARTY_PROVIDERS, PROVIDERS } from "../src/index.ts";

describe("first-party provider migration registry", () => {
  it("contains every upstream provider exactly once", () => {
    expect(CANONICAL_PROVIDER_IDS).toHaveLength(69);
    expect(new Set(CANONICAL_PROVIDER_IDS)).toHaveLength(69);
    expect(PROVIDERS.map((provider) => provider.id)).toEqual(CANONICAL_PROVIDER_IDS);
  });

  it("marks executable migrations as partial until oracle parity", () => {
    expect(FIRST_PARTY_PROVIDERS).toHaveLength(68);
    expect(PROVIDERS.filter((provider) => provider.status === "partial")).toHaveLength(68);
    expect(new Set(FIRST_PARTY_PROVIDERS.map((provider) => provider.id))).toHaveLength(68);
  });

  it("does not silently give unported providers an executable strategy", () => {
    for (const provider of PROVIDERS.filter((entry) => entry.status === "unported")) {
      expect(provider.strategy).toBeUndefined();
    }
  });
});
