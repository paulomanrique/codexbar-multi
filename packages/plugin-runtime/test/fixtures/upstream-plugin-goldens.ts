import type { PluginApprovalBinding } from "../../src/index.js";

/**
 * Small, deterministic source fixture derived from the Swift plugin oracle's
 * portable test shape. It exercises the public manifest surface without a
 * provider network call or a real credential.
 */
export const typedFixtureSource = `
  type FixtureSettings = { readonly API_KEY: string };
  const settings: FixtureSettings = { API_KEY: "fixture-only" };
  defineProvider({
    id: "fixture-meter",
    name: "Fixture Meter",
    icon: { monogram: "FM", tint: "#336699" },
    endpoints: ["https://api.fixture.test"],
    settings: [{ key: "API_KEY", title: "API key", type: "secure" }],
    auth: { type: "bearer", secret: "API_KEY" },
    async fetchUsage(ctx: unknown) {
      const typed = settings as FixtureSettings;
      return {
        primary: { usedPercent: 37 },
        identity: { organization: typed.API_KEY, loginMethod: "fixture" },
        details: [{ rows: [{ label: "source", value: String(Boolean(ctx)) }] }],
      };
    },
  });
`;

export const fixtureApprovalBinding: PluginApprovalBinding = {
  instanceId: "fixture-meter",
  origins: ["https://api.fixture.test"],
  authMode: "bearer",
  authHeader: "Authorization",
  authSecret: "API_KEY",
  secretNames: ["API_KEY"],
  capabilities: [],
  cookieDomains: [],
};

export const fixtureSnapshotGolden = {
  primary: { usedPercent: 37 },
  identity: { organization: "fixture-only", loginMethod: "fixture" },
  details: [{ rows: [{ label: "source", value: "true" }] }],
} as const;
