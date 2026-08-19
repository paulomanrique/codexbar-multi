import type { ProviderId, UsageSnapshot } from "@codexbar/contracts";
import { mapProviderSnapshot } from "./snapshot-mapper.ts";
import type { FirstPartyProvider, ProviderContext, ProviderDescriptor } from "./types.ts";

/** The persisted first-party provider roster. Keep this order stable. */
export const CANONICAL_PROVIDER_IDS = [
  "codex",
  "openai",
  "azureopenai",
  "claude",
  "clinepass",
  "cursor",
  "opencode",
  "opencodego",
  "alibaba",
  "alibabatokenplan",
  "qwencloud",
  "factory",
  "fireworks",
  "gemini",
  "antigravity",
  "copilot",
  "devin",
  "zai",
  "minimax",
  "manus",
  "kimi",
  "kilo",
  "kiro",
  "vertexai",
  "augment",
  "jetbrains",
  "moonshot",
  "amp",
  "t3chat",
  "ollama",
  "synthetic",
  "openrouter",
  "elevenlabs",
  "warp",
  "windsurf",
  "zed",
  "perplexity",
  "mimo",
  "doubao",
  "sakana",
  "abacus",
  "mistral",
  "deepseek",
  "deepinfra",
  "codebuff",
  "crof",
  "venice",
  "commandcode",
  "qoder",
  "stepfun",
  "bedrock",
  "grok",
  "groq",
  "llmproxy",
  "litellm",
  "deepgram",
  "poe",
  "chutes",
  "neuralwatt",
  "clawrouter",
  "longcat",
  "sub2api",
  "wayfinder",
  "zenmux",
  "aiand",
  "zoommate",
  "xai",
  "notion",
  "ibmbob",
] as const;

export type CanonicalProviderID = (typeof CANONICAL_PROVIDER_IDS)[number];

const displayName = (id: string): string =>
  id === "zai"
    ? "z.ai / GLM"
    : id === "xai"
      ? "xAI"
      : id
          .replace(/([a-z])([0-9])/g, "$1 $2")
          .replace(
            /(^|[-_])(.)/g,
            (_, prefix: string, letter: string) => `${prefix}${letter.toUpperCase()}`,
          );

const unported = (id: CanonicalProviderID): ProviderDescriptor => ({
  id,
  name: displayName(id),
  status: "unported",
  endpoints: [],
  settings: [],
});

/** Build the complete registry, replacing unported placeholders with direct modules below. */
export const createProviderRegistry = (
  ported: readonly ProviderDescriptor[] = [],
): readonly ProviderDescriptor[] => {
  const byID = new Map(ported.map((descriptor) => [descriptor.id, descriptor]));
  return CANONICAL_PROVIDER_IDS.map((id) => byID.get(id) ?? unported(id));
};

export const providerDescriptor = (
  id: string,
  registry: readonly ProviderDescriptor[] = PROVIDER_REGISTRY,
) => registry.find((descriptor) => descriptor.id === id);

// Assigned by index.ts once the direct modules have been imported. Keeping this export stable avoids a
// second, divergent registry in consumers that import ./registry directly.
export let PROVIDER_REGISTRY: readonly ProviderDescriptor[] = createProviderRegistry();
export const installProviderRegistry = (
  strategies: readonly FirstPartyProvider[],
): readonly ProviderDescriptor[] => {
  PROVIDER_REGISTRY = createProviderRegistry(strategies.map((strategy) => strategy.descriptor));
  return PROVIDER_REGISTRY;
};

export const getProviderDescriptor = providerDescriptor;
export const PROVIDER_DESCRIPTOR_REGISTRY = (): readonly ProviderDescriptor[] => PROVIDER_REGISTRY;

/** The only public execution boundary: raw upstream plugin shapes never escape providers. */
export async function fetchProviderUsage(
  providerId: ProviderId,
  context: ProviderContext,
): Promise<UsageSnapshot> {
  const descriptor = providerDescriptor(providerId);
  if (descriptor?.strategy === undefined) {
    throw new Error(`Provider '${providerId}' is mapped but not ported yet`);
  }
  const raw = await descriptor.strategy.fetchUsage(context);
  return mapProviderSnapshot(raw, providerId, context.date.now());
}
