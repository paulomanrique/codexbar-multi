import type {
  FirstPartyProvider,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
const definition: ProviderDefinition = {
  id: "kiro",
  name: "Kiro",
  endpoints: ["https://app.kiro.dev"],
  settings: [{ key: "KIRO_CLI_USAGE_TEXT", title: "CLI usage output", type: "secure" }],
  fetchUsage: async (ctx) => {
    const raw = ctx.settings.getSecret("KIRO_CLI_USAGE_TEXT");
    if (!raw)
      throw ctx.fail.missingCredential(
        "Kiro CLI discovery, PTY login and output collection require ProcessRunner/PtyRunner adapters.",
      );
    const pct = /([0-9]+(?:\.[0-9]+)?)%\s*used/iu.exec(raw)?.[1];
    if (!pct) throw ctx.fail.parseFailure("Could not parse Kiro CLI usage output.");
    return { primary: { usedPercent: Number(pct) } };
  },
};
const strategy: ProviderStrategy = {
  id: "kiro.cli",
  kind: "api",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const kiro: FirstPartyProvider = { ...strategy, descriptor };
