import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";

const ansiControlSequence = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-?]*[ -/]*[@-~]`, "gu");

/** Parses the non-interactive `kiro-cli ... /usage` display produced by the Swift probe. */
export const parseKiroUsage = (raw: string, ctx: ProviderContext) => {
  const output = raw.replace(ansiControlSequence, "").trim();
  const pct = /([0-9]+(?:\.[0-9]+)?)%\s*(?:used|usage)/iu.exec(output)?.[1];
  if (!pct) throw ctx.fail.parseFailure("Could not parse Kiro CLI usage output.");
  return { primary: { usedPercent: Math.max(0, Math.min(100, Number(pct))) } };
};

const definition: ProviderDefinition = {
  id: "kiro",
  name: "Kiro",
  endpoints: ["https://app.kiro.dev"],
  settings: [],
  fetchUsage: async (ctx) => {
    if (ctx.local === undefined)
      throw ctx.fail.providerUnavailable("Kiro CLI support is not configured by this host.");
    const result = await ctx.local.run("kiro-cli", {
      args: ["chat", "--no-interactive", "/usage"],
      timeoutMs: 20_000,
    });
    const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
    if (/not\s+logged\s+in|login\s+required|kiro-cli\s+login|oauth\s+error/iu.test(output))
      throw ctx.fail.authenticationExpired(
        "Kiro CLI is not logged in. Run 'kiro-cli login' first.",
      );
    if (result.exitCode !== 0)
      throw ctx.fail.providerUnavailable(
        `Kiro CLI exited with status ${result.exitCode ?? "unknown"}.`,
      );
    return parseKiroUsage(output, ctx);
  },
};
const strategy: ProviderStrategy = {
  id: "kiro.cli",
  kind: "cli",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const kiro: FirstPartyProvider = { ...strategy, descriptor };
