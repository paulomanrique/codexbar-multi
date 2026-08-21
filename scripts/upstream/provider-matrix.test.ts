import assert from "node:assert/strict";
import test from "node:test";
import { validateProviderMatrix } from "./provider-matrix.ts";

const ids = Array.from({ length: 69 }, (_, index) => `provider-${index}`);

const matrixFor = (overrides: (id: string, index: number) => string = (id) => id): string => {
  const entries = ids.map((id, index) => {
    const actualId = overrides(id, index);
    return `  - id: ${actualId}
    swiftGlobs:
      - Sources/CodexBar/Providers/${actualId}.swift
    tests:
      swiftGlobs:
        - Tests/CodexBarTests/${actualId}.swift
      tsGlobs:
        - packages/providers/test/${actualId}.test.ts
    fixtures:
      - Tests/CodexBarTests/Fixtures/Providers/${actualId}/**/*
    tsPaths:
      expected: [packages/providers/src/providers/${actualId}.ts]
      real:
        - packages/providers/src/providers/${actualId}.ts
    tsTestGlobs:
      - packages/providers/test/${actualId}.test.ts
    status: partial
    oracleStatus: pending
    lastReviewedCommit: 453174fe13eebdf403cc0776268eb2b101fd9553`;
  });
  return `version: 2
baselineCommit: 453174fe13eebdf403cc0776268eb2b101fd9553
providerCount: 69
providers:
${entries.join("\n")}
`;
};

const sources = (): Readonly<Record<string, string>> =>
  Object.fromEntries(
    ids.map((id) => [
      `packages/providers/src/providers/${id}.ts`,
      "const strategy: ProviderStrategy = {}; export const descriptor: ProviderDescriptor = { settings: [] };",
    ]),
  );

const validate = (source: string) =>
  validateProviderMatrix({
    source,
    canonicalProviderIds: ids,
    pluginResourceFiles: [],
    trackedFiles: ids.map((id) => `Tests/CodexBarTests/Fixtures/Providers/${id}/fixture.json`),
    providerSources: sources(),
  });

const validateWithProviderSource = (source: string, providerSource: string) =>
  validateProviderMatrix({
    source,
    canonicalProviderIds: ids,
    pluginResourceFiles: [],
    trackedFiles: ids.map((id) => `Tests/CodexBarTests/Fixtures/Providers/${id}/fixture.json`),
    providerSources: Object.fromEntries(
      ids.map((id) => [`packages/providers/src/providers/${id}.ts`, providerSource]),
    ),
  });

test("accepts the complete 69-provider contract matrix", () => {
  assert.equal(validate(matrixFor()).length, 69);
});

test("rejects a missing or duplicate provider instead of silently accepting the roster", () => {
  assert.throws(
    () => validate(matrixFor((id, index) => (index === 1 ? ids[0]! : id))),
    /duplicate/,
  );
  assert.throws(
    () => validate(matrixFor((id, index) => (index === 1 ? "missing-provider" : id))),
    /order/,
  );
  const withoutProvider = matrixFor().replace(
    /  - id: provider-1\n[\s\S]*?(?=  - id: provider-2)/,
    "",
  );
  assert.throws(() => validate(withoutProvider), /exactly 69/);
});

test("requires descriptor, strategy, config, fixture, tests, and oracle mappings", () => {
  assert.throws(
    () =>
      validate(
        matrixFor().replace(
          "expected: [packages/providers/src/providers/provider-0.ts]",
          "expected: []",
        ),
      ),
    /descriptor/,
  );
  assert.throws(
    () =>
      validateWithProviderSource(
        matrixFor(),
        "const implementation = {}; export const descriptor: ProviderDescriptor = { settings: [] };",
      ),
    /strategy module has no fetch strategy/,
  );
  assert.throws(
    () =>
      validateWithProviderSource(
        matrixFor(),
        "const strategy: ProviderStrategy = {}; export const descriptor: ProviderDescriptor = {};",
      ),
    /config\/settings/,
  );
  const missingDescriptorPathSources = Object.fromEntries(
    Object.entries(sources()).filter(
      ([path]) => path !== "packages/providers/src/providers/provider-0.ts",
    ),
  );
  assert.throws(
    () =>
      validateProviderMatrix({
        source: matrixFor(),
        canonicalProviderIds: ids,
        pluginResourceFiles: [],
        trackedFiles: ids.map((id) => `Tests/CodexBarTests/Fixtures/Providers/${id}/fixture.json`),
        providerSources: missingDescriptorPathSources,
      }),
    /descriptor module/,
  );
  assert.throws(
    () =>
      validate(
        matrixFor().replace(
          "real:\n        - packages/providers/src/providers/provider-0.ts",
          "real:\n        - packages/providers/src/providers/provider-0-missing.ts",
        ),
      ),
    /strategy module/,
  );
  assert.throws(
    () =>
      validate(
        matrixFor().replace(
          "    fixtures:\n      - Tests/CodexBarTests/Fixtures/Providers/provider-0/**/*",
          "    fixtures: []",
        ),
      ),
    /fixture/,
  );
  assert.throws(
    () =>
      validate(
        matrixFor().replace(
          "    tsTestGlobs:\n      - packages/providers/test/provider-0.test.ts",
          "    tsTestGlobs: []",
        ),
      ),
    /TypeScript test/,
  );
  assert.throws(
    () =>
      validate(
        matrixFor().replace(
          "    lastReviewedCommit: 453174fe13eebdf403cc0776268eb2b101fd9553",
          "    lastReviewedCommit: pending",
        ),
      ),
    /oracle mapping/,
  );
});

test("rejects fixture globs that do not resolve to a tracked golden or test", () => {
  assert.throws(
    () =>
      validate(
        matrixFor().replace(
          "Tests/CodexBarTests/Fixtures/Providers/provider-0/**/*",
          "Tests/CodexBarTests/Fixtures/Providers/provider-0/does-not-exist.json",
        ),
      ),
    /fixture mapping does not resolve/,
  );
});

test("does not allow parity without an accepted oracle comparison", () => {
  assert.throws(
    () => validate(matrixFor().replace("    status: partial", "    status: parity")),
    /accepted Swift oracle/,
  );
});
