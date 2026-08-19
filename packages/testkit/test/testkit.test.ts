import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vite-plus/test";
import {
  compareWithOracle,
  jsonParityEqual,
  normalizeJsonText,
  runSwiftOracle,
  validateFixtureManifest,
  type FixtureManifest,
} from "../src/index.ts";

describe("parity testkit", () => {
  it("sorts keys and can redact secret-shaped fields", () => {
    expect(normalizeJsonText('{"b":2,"apiKey":"x","a":1}', { redactSecrets: true })).toBe(
      '{"a":1,"apiKey":"[REDACTED]","b":2}',
    );
    expect(jsonParityEqual({ b: 2, a: 1 }, { a: 1, b: 2 })).toBe(true);
  });

  it("rejects fixture manifests that enable network or credentials", () => {
    expect(() =>
      validateFixtureManifest({
        version: 1,
        baseline: { repository: "x", commit: "y" },
        entries: [],
        policy: {
          allowNetwork: false,
          allowCredentials: false,
          requiredShape: "provider-response",
        },
      }),
    ).not.toThrow();
  });

  it("validates the checked-in upstream fixture inventory", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../../../upstream/fixtures.manifest.json", import.meta.url), "utf8"),
    ) as FixtureManifest;
    expect(() => validateFixtureManifest(manifest)).not.toThrow();
  });

  it("normalizes and redacts Swift oracle output before comparison", async () => {
    const oracle = await runSwiftOracle(
      { executable: "swift-oracle", args: ["usage", "--json"] },
      async () => ({ stdout: '{"used":12,"accessToken":"secret"}', stderr: "" }),
    );
    expect(compareWithOracle(oracle, { accessToken: "different", used: 12 })).toMatchObject({
      equal: true,
      oracle: { accessToken: "[REDACTED]", used: 12 },
    });
  });
});
