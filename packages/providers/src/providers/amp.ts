import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";

/** Pure port of Amp CLI display parsing. Process discovery/execution is injected by Platform.ProcessRunner. */
export const parseAmpUsage = (text: string, ctx: ProviderContext) => {
  const normalized = text.replace(/\r/g, "").trim();
  const percent = /(?:used|usage)\s*[:-]?\s*([0-9]+(?:\.[0-9]+)?)%/iu.exec(normalized)?.[1];
  const balance = /(?:balance|credits?)\s*[:-]?\s*\$?([0-9][0-9,]*(?:\.[0-9]+)?)/iu.exec(
    normalized,
  )?.[1];
  const plan = /(?:plan|subscription)\s*[:-]\s*([^\n]+)/iu.exec(normalized)?.[1]?.trim();
  if (!percent && !balance && !plan)
    throw ctx.fail.parseFailure("Could not parse Amp usage output.");
  return {
    ...(percent ? { primary: { usedPercent: Math.max(0, Math.min(100, Number(percent))) } } : {}),
    identity: {
      ...(plan ? { loginMethod: plan } : {}),
      ...(balance
        ? { organization: `Balance: ${ctx.format.usd(Number(balance.replace(/,/g, "")))}` }
        : {}),
    },
  };
};
const definition: ProviderDefinition = {
  id: "amp",
  name: "Amp",
  endpoints: ["https://ampcode.com"],
  settings: [],
  fetchUsage: async (ctx) => {
    if (ctx.local === undefined)
      throw ctx.fail.providerUnavailable("Amp CLI support is not configured by this host.");
    const result = await ctx.local.run("amp", { args: ["usage"], timeoutMs: 15_000 });
    const output = result.stdout.trim() || result.stderr.trim();
    if (!output) throw ctx.fail.providerUnavailable("The Amp CLI returned no usage data.");
    if (result.exitCode !== 0) {
      if (/not\s+logged\s+in|sign\s*in|auth(?:entication)?\s+required/iu.test(output))
        throw ctx.fail.authenticationExpired("Amp CLI is not logged in.");
      throw ctx.fail.providerUnavailable(`Amp CLI exited with status ${result.exitCode}.`);
    }
    return parseAmpUsage(output, ctx);
  },
};
const strategy: ProviderStrategy = {
  id: "amp.cli",
  kind: "cli",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const amp: FirstPartyProvider = { ...strategy, descriptor };
