import { PROVIDER_IDS, type ProviderId } from "@codexbar/contracts";
import type { JsonValue } from "./json.ts";

export type FixtureManifestEntry = {
  readonly id: string;
  readonly pathGlobs: readonly string[];
  readonly observedCount: number;
  readonly providers?: readonly ProviderId[];
  readonly testGlobs: readonly string[];
  readonly status: "unported" | "partial" | "parity" | "not-applicable";
};

export type FixtureManifest = {
  readonly version: number;
  readonly baseline: { readonly repository: string; readonly commit: string };
  /** Fixed, offline bridge operations. `partial` is never evidence of provider parity by itself. */
  readonly oracleCases?: readonly {
    readonly id: string;
    readonly swiftTarget: "CodexBarOracle";
    readonly fixture: string;
    readonly tsTest: string;
    readonly providers?: readonly ProviderId[];
    readonly status: "partial" | "parity";
  }[];
  readonly entries: readonly FixtureManifestEntry[];
  readonly policy: {
    readonly allowNetwork: false;
    readonly allowCredentials: false;
    readonly requiredShape: string;
    readonly notes?: string;
  };
};

/** Accepts the checked-in manifest and fails fast if a fixture claims a non-first-party provider. */
export function validateFixtureManifest(manifest: FixtureManifest): void {
  if (manifest.policy.allowNetwork || manifest.policy.allowCredentials) {
    throw new Error("Parity fixtures must not use network access or real credentials");
  }
  const seen = new Set<string>();
  for (const fixture of manifest.entries) {
    if (seen.has(fixture.id)) throw new Error(`Duplicate fixture id: ${fixture.id}`);
    if (!Number.isSafeInteger(fixture.observedCount) || fixture.observedCount < 0)
      throw new Error(`Invalid fixture count: ${fixture.id}`);
    if (fixture.pathGlobs.length === 0)
      throw new Error(`Fixture entry has no paths: ${fixture.id}`);
    for (const provider of fixture.providers ?? []) {
      if (!PROVIDER_IDS.includes(provider))
        throw new Error(`Unknown fixture provider: ${provider}`);
    }
    seen.add(fixture.id);
  }
  const seenOracleCases = new Set<string>();
  for (const oracleCase of manifest.oracleCases ?? []) {
    if (seenOracleCases.has(oracleCase.id))
      throw new Error(`Duplicate oracle case: ${oracleCase.id}`);
    if (!oracleCase.fixture.startsWith("Tests/") || oracleCase.fixture.includes(".."))
      throw new Error(`Unsafe oracle fixture: ${oracleCase.id}`);
    if (oracleCase.swiftTarget !== "CodexBarOracle")
      throw new Error(`Unexpected Swift oracle target: ${oracleCase.id}`);
    for (const provider of oracleCase.providers ?? []) {
      if (!PROVIDER_IDS.includes(provider))
        throw new Error(`Unknown oracle-case provider: ${provider}`);
    }
    seenOracleCases.add(oracleCase.id);
  }
}

export function fixturePayload(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    typeof value === "number"
  )
    return value;
  if (Array.isArray(value)) return value.map(fixturePayload);
  if (typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, fixturePayload(child)]),
    );
  throw new TypeError("Fixture payload must be JSON-compatible");
}
