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
  settings: [
    { key: "AMP_API_KEY", title: "API key", type: "secure" },
    { key: "AMP_CLI_USAGE_TEXT", title: "CLI usage fixture", type: "secure" },
  ],
  capabilities: ["browser-cookies"],
  cookieDomains: ["ampcode.com", "www.ampcode.com"],
  fetchUsage: async (ctx) => {
    const output = ctx.settings.getSecret("AMP_CLI_USAGE_TEXT");
    if (!output)
      throw ctx.fail.missingCredential(
        "Amp CLI execution requires the ProcessRunner platform adapter; no parsed CLI output is available.",
      );
    return parseAmpUsage(output, ctx);
  },
};
const strategy: ProviderStrategy = {
  id: "amp.cli",
  kind: "api",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const amp: FirstPartyProvider = { ...strategy, descriptor };
