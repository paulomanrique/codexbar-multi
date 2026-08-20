import type {
  FirstPartyProvider,
  ProviderContext,
  ProviderDefinition,
  ProviderDescriptor,
  ProviderStrategy,
} from "../types.ts";
const decode = (value: string) =>
  value
    .replace(/&#10;/gu, "\n")
    .replace(/&quot;/gu, '"')
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&apos;/gu, "'");
export const parseJetBrainsQuota = (xml: string, ctx: ProviderContext) => {
  const component =
    /<component[^>]*name\s*=\s*["']AIAssistantQuotaManager2["'][^>]*>([\s\S]*?)<\/component>/iu.exec(
      xml,
    )?.[1];
  const raw =
    component &&
    /option[^>]*name\s*=\s*["']quotaInfo["'][^>]*value\s*=\s*["']([^"']*)/iu.exec(component)?.[1];
  if (!raw) throw ctx.fail.parseFailure("No JetBrains quota information found.");
  let quota: Record<string, unknown>;
  try {
    quota = JSON.parse(decode(raw)) as Record<string, unknown>;
  } catch {
    throw ctx.fail.parseFailure("Invalid JetBrains quota JSON.");
  }
  const used = Number(quota.current ?? 0),
    max = Number(quota.maximum ?? 0);
  if (!Number.isFinite(used) || !Number.isFinite(max) || max < 0)
    throw ctx.fail.parseFailure("Invalid JetBrains quota values.");
  const refillRaw =
    component &&
    /option[^>]*name\s*=\s*["']nextRefill["'][^>]*value\s*=\s*["']([^"']*)/iu.exec(component)?.[1];
  let reset: string | undefined;
  try {
    const next = (JSON.parse(decode(refillRaw ?? "{}")) as Record<string, unknown>).next;
    if (typeof next === "string") reset = ctx.date.iso(next);
  } catch {}
  const identity = typeof quota.type === "string" ? { loginMethod: quota.type } : {};
  return {
    // Swift treats an uninitialised/zero quota as empty rather than a parser failure.
    primary: {
      usedPercent: max === 0 ? 0 : Math.max(0, Math.min(100, ctx.pct(used, max))),
      ...(reset ? { resetsAt: reset } : {}),
    },
    identity,
  };
};
const definition: ProviderDefinition = {
  id: "jetbrains",
  name: "JetBrains AI",
  endpoints: [],
  settings: [{ key: "JETBRAINS_QUOTA_XML", title: "Quota XML fixture", type: "secure" }],
  fetchUsage: async (ctx) => {
    const xml = ctx.settings.getSecret("JETBRAINS_QUOTA_XML");
    if (!xml)
      throw ctx.fail.missingCredential(
        "JetBrains IDE discovery and quota-file reads require PrivateFileStore and IDEDiscovery adapters.",
      );
    return parseJetBrainsQuota(xml, ctx);
  },
};
const strategy: ProviderStrategy = {
  id: "jetbrains.local",
  kind: "api",
  fetchUsage: definition.fetchUsage,
};
export const descriptor: ProviderDescriptor = { ...definition, status: "partial", strategy };
export const jetbrains: FirstPartyProvider = { ...strategy, descriptor };
