/**
 * Pure, injectable cost pricing. Ported from
 * `Sources/CodexBarCore/Vendored/CostUsage/CostUsagePricing.swift`.
 *
 * Rates are USD per token. Catalog prices, like models.dev, are expressed per
 * million tokens so an adapter can feed a downloaded catalog without making
 * the domain package depend on storage or networking.
 */
export interface CodexPricing {
  readonly inputCostPerToken: number;
  readonly outputCostPerToken: number;
  readonly cacheReadInputCostPerToken?: number;
  readonly cacheWriteInputCostPerToken?: number;
  readonly displayLabel?: string;
  readonly thresholdTokens?: number;
  readonly inputCostPerTokenAboveThreshold?: number;
  readonly outputCostPerTokenAboveThreshold?: number;
  readonly cacheReadInputCostPerTokenAboveThreshold?: number;
  readonly cacheWriteInputCostPerTokenAboveThreshold?: number;
}

export interface ClaudePricing {
  readonly inputCostPerToken: number;
  readonly outputCostPerToken: number;
  readonly cacheCreationInputCostPerToken: number;
  readonly cacheReadInputCostPerToken: number;
  readonly thresholdTokens?: number;
  readonly inputCostPerTokenAboveThreshold?: number;
  readonly outputCostPerTokenAboveThreshold?: number;
  readonly cacheCreationInputCostPerTokenAboveThreshold?: number;
  readonly cacheReadInputCostPerTokenAboveThreshold?: number;
}

/** A serializable catalog overlay. `contextOver200k` being present but empty is meaningful. */
export interface ModelCatalogPrice {
  readonly inputPerMillion: number;
  readonly outputPerMillion: number;
  readonly cacheReadPerMillion?: number;
  readonly cacheWritePerMillion?: number;
  readonly contextOver200k?: Readonly<Partial<ModelCatalogPrice>>;
}

export interface PricingCatalog {
  readonly lookup: (providerId: string, modelId: string) => ModelCatalogPrice | undefined;
}

export interface CostPricingOptions {
  readonly pricingDate?: Date;
  readonly catalog?: PricingCatalog;
}

export const codexUnattributedModel = "unknown";
export const codexPriorityInputTokenLimit = 272_000;
export const codexGPT56PricingCutoff = new Date(1_785_369_600_000);
export const claudeFullContextStandardPricingCutoff = new Date(1_773_360_000_000);

const codex = {
  "gpt-5": p(1.25, 10, 0.125),
  "gpt-5-codex": p(1.25, 10, 0.125),
  "gpt-5-mini": p(0.25, 2, 0.025),
  "gpt-5-nano": p(0.05, 0.4, 0.005),
  "gpt-5-pro": p(15, 120),
  "gpt-5.1": p(1.25, 10, 0.125),
  "gpt-5.1-codex": p(1.25, 10, 0.125),
  "gpt-5.1-codex-max": p(1.25, 10, 0.125),
  "gpt-5.1-codex-mini": p(0.25, 2, 0.025),
  "gpt-5.2": p(1.75, 14, 0.175),
  "gpt-5.2-codex": p(1.75, 14, 0.175),
  "gpt-5.2-pro": p(21, 168),
  "gpt-5.3-codex": p(1.75, 14, 0.175),
  "gpt-5.3-codex-spark": p(0, 0, 0, { displayLabel: "Research Preview" }),
  "gpt-5.4": p(2.5, 15, 0.25, longContext(5, 22.5, 0.5)),
  "gpt-5.4-mini": p(0.75, 4.5, 0.075),
  "gpt-5.4-nano": p(0.2, 1.25, 0.02),
  "gpt-5.4-pro": p(30, 180),
  "gpt-5.5": p(5, 30, 0.5, longContext(10, 45, 1)),
  "gpt-5.5-pro": p(30, 180),
  "gpt-5.6-sol": p(5, 30, 0.5, longContext(10, 45, 1, 12.5), 6.25),
  "gpt-5.6-terra": p(2, 12, 0.2, longContext(4, 18, 0.4, 5), 2.5),
  "gpt-5.6-luna": p(0.2, 1.2, 0.02, longContext(0.4, 1.8, 0.04, 0.5), 0.25),
} as const satisfies Readonly<Record<string, CodexPricing>>;

const codexHistorical: Readonly<Partial<Record<keyof typeof codex, CodexPricing>>> = {
  "gpt-5.6-terra": p(2.5, 15, 0.25, longContext(5, 22.5, 0.5, 6.25), 3.125),
  "gpt-5.6-luna": p(1, 6, 0.1, longContext(2, 9, 0.2, 2.5), 1.25),
};

const claude = {
  "claude-fable-5": c(10, 50, 12.5, 1),
  "claude-haiku-4-5": c(1, 5, 1.25, 0.1),
  "claude-haiku-4-5-20251001": c(1, 5, 1.25, 0.1),
  "claude-opus-4-5": c(5, 25, 6.25, 0.5),
  "claude-opus-4-5-20251101": c(5, 25, 6.25, 0.5),
  "claude-opus-4-6": c(5, 25, 6.25, 0.5),
  "claude-opus-4-6-20260205": c(5, 25, 6.25, 0.5),
  "claude-opus-4-7": c(5, 25, 6.25, 0.5),
  "claude-opus-4-8": c(5, 25, 6.25, 0.5),
  "claude-sonnet-4-5": c(3, 15, 3.75, 0.3, claudeLongContext(6, 22.5, 7.5, 0.6)),
  "claude-sonnet-4-5-20250929": c(3, 15, 3.75, 0.3, claudeLongContext(6, 22.5, 7.5, 0.6)),
  "claude-sonnet-4-6": c(3, 15, 3.75, 0.3),
  "claude-opus-4-20250514": c(15, 75, 18.75, 1.5),
  "claude-opus-4-1": c(15, 75, 18.75, 1.5),
  "claude-sonnet-4-20250514": c(3, 15, 3.75, 0.3, claudeLongContext(6, 22.5, 7.5, 0.6)),
} as const satisfies Readonly<Record<string, ClaudePricing>>;

const claudeHistorical: Readonly<Partial<Record<keyof typeof claude, ClaudePricing>>> = {
  "claude-opus-4-6": c(5, 25, 6.25, 0.5, claudeLongContext(10, 37.5, 12.5, 1)),
  "claude-sonnet-4-6": c(3, 15, 3.75, 0.3, claudeLongContext(6, 22.5, 7.5, 0.6)),
};

const codexCatalogRoutes = new Set([
  "deepseek",
  "kimi-coding",
  "kimi-for-coding",
  "openai",
  "opencode",
  "opencode-free",
  "opencode-go",
]);

function perToken(perMillion: number): number {
  return perMillion / 1_000_000;
}

function p(
  input: number,
  output: number,
  cacheRead?: number,
  extra?: Omit<
    CodexPricing,
    "inputCostPerToken" | "outputCostPerToken" | "cacheReadInputCostPerToken"
  >,
  cacheWrite?: number,
): CodexPricing {
  return {
    inputCostPerToken: perToken(input),
    outputCostPerToken: perToken(output),
    ...(cacheRead === undefined ? {} : { cacheReadInputCostPerToken: perToken(cacheRead) }),
    ...(cacheWrite === undefined ? {} : { cacheWriteInputCostPerToken: perToken(cacheWrite) }),
    ...extra,
  };
}

function longContext(
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite?: number,
): Omit<CodexPricing, "inputCostPerToken" | "outputCostPerToken" | "cacheReadInputCostPerToken"> {
  return {
    thresholdTokens: codexPriorityInputTokenLimit,
    inputCostPerTokenAboveThreshold: perToken(input),
    outputCostPerTokenAboveThreshold: perToken(output),
    cacheReadInputCostPerTokenAboveThreshold: perToken(cacheRead),
    ...(cacheWrite === undefined
      ? {}
      : { cacheWriteInputCostPerTokenAboveThreshold: perToken(cacheWrite) }),
  };
}

function c(
  input: number,
  output: number,
  cacheCreation: number,
  cacheRead: number,
  extra?: Omit<
    ClaudePricing,
    | "inputCostPerToken"
    | "outputCostPerToken"
    | "cacheCreationInputCostPerToken"
    | "cacheReadInputCostPerToken"
  >,
): ClaudePricing {
  return {
    inputCostPerToken: perToken(input),
    outputCostPerToken: perToken(output),
    cacheCreationInputCostPerToken: perToken(cacheCreation),
    cacheReadInputCostPerToken: perToken(cacheRead),
    ...extra,
  };
}

function claudeLongContext(
  input: number,
  output: number,
  cacheCreation: number,
  cacheRead: number,
): Omit<
  ClaudePricing,
  | "inputCostPerToken"
  | "outputCostPerToken"
  | "cacheCreationInputCostPerToken"
  | "cacheReadInputCostPerToken"
> {
  return {
    thresholdTokens: 200_000,
    inputCostPerTokenAboveThreshold: perToken(input),
    outputCostPerTokenAboveThreshold: perToken(output),
    cacheCreationInputCostPerTokenAboveThreshold: perToken(cacheCreation),
    cacheReadInputCostPerTokenAboveThreshold: perToken(cacheRead),
  };
}

export function normalizeCodexModel(rawModel: string): string {
  let model = rawModel.trim();
  if (model.startsWith("openai/")) model = model.slice("openai/".length);
  if (model === "gpt-5.6") return "gpt-5.6-sol";
  if (model in codex) return model;
  const base = model.replace(/-\d{4}-\d{2}-\d{2}$/, "");
  return base in codex ? base : model;
}

export function normalizeClaudeModel(rawModel: string): string {
  let model = rawModel.trim();
  if (model.startsWith("anthropic.")) model = model.slice("anthropic.".length);
  const lastDot = model.lastIndexOf(".");
  if (lastDot >= 0 && model.includes("claude-") && model.slice(lastDot + 1).startsWith("claude-")) {
    model = model.slice(lastDot + 1);
  }
  model = model.replace(/-v\d+:\d+$/, "");
  const base = model.replace(/-\d{8}$/, "");
  return base in claude ? base : model;
}

export function isCodexUnattributedModel(model: string): boolean {
  return normalizeCodexModel(model) === codexUnattributedModel;
}

export function codexDisplayLabel(model: string): string | undefined {
  return codex[normalizeCodexModel(model) as keyof typeof codex]?.displayLabel;
}

export function codexAPIFastMultiplier(model: string): number | undefined {
  switch (normalizeCodexModel(model)) {
    case "gpt-5.4":
    case "gpt-5.4-mini":
    case "gpt-5.6-sol":
    case "gpt-5.6-terra":
    case "gpt-5.6-luna":
      return 2;
    case "gpt-5.5":
      return 2.5;
    default:
      return undefined;
  }
}

/** Resolves catalog routes before bundled OpenAI prices; unknown routes never cross-charge. */
export function resolveCodexPricing(
  model: string,
  options: CostPricingOptions = {},
): CodexPricing | undefined {
  const key = normalizeCodexModel(model);
  if (key === codexUnattributedModel) return undefined;
  const historical =
    options.pricingDate !== undefined && options.pricingDate < codexGPT56PricingCutoff
      ? codexHistorical[key as keyof typeof codex]
      : undefined;
  if (historical !== undefined) return historical;

  const catalog = resolveCodexCatalogPrice(model, options.catalog);
  if (catalog !== undefined) return catalog;
  return codex[key as keyof typeof codex];
}

export function codexCostUSD(input: {
  readonly model: string;
  readonly inputTokens: number;
  readonly cachedInputTokens?: number;
  readonly cacheWriteInputTokens?: number;
  readonly outputTokens: number;
  readonly options?: CostPricingOptions;
}): number | undefined {
  const pricing = resolveCodexPricing(input.model, input.options);
  return pricing === undefined ? undefined : calculateCodexCost(pricing, input);
}

export function calculateCodexCost(
  pricing: CodexPricing,
  input: Omit<Parameters<typeof codexCostUSD>[0], "model" | "options">,
): number {
  const totalInput = nonNegative(input.inputTokens);
  const cached = Math.min(nonNegative(input.cachedInputTokens ?? 0), totalInput);
  const cacheWrite = Math.min(nonNegative(input.cacheWriteInputTokens ?? 0), totalInput - cached);
  const nonCached = totalInput - cached - cacheWrite;
  const long = pricing.thresholdTokens !== undefined && totalInput > pricing.thresholdTokens;
  const inputRate = long
    ? (pricing.inputCostPerTokenAboveThreshold ?? pricing.inputCostPerToken)
    : pricing.inputCostPerToken;
  const cacheRate = long
    ? (pricing.cacheReadInputCostPerTokenAboveThreshold ??
      pricing.cacheReadInputCostPerToken ??
      inputRate)
    : (pricing.cacheReadInputCostPerToken ?? pricing.inputCostPerToken);
  const writeRate = long
    ? (pricing.cacheWriteInputCostPerTokenAboveThreshold ??
      pricing.cacheWriteInputCostPerToken ??
      inputRate)
    : (pricing.cacheWriteInputCostPerToken ?? inputRate);
  const outputRate = long
    ? (pricing.outputCostPerTokenAboveThreshold ?? pricing.outputCostPerToken)
    : pricing.outputCostPerToken;
  return (
    nonCached * inputRate +
    cached * cacheRate +
    cacheWrite * writeRate +
    nonNegative(input.outputTokens) * outputRate
  );
}

export function codexAPIFastCostUSD(input: Parameters<typeof codexCostUSD>[0]): number | undefined {
  if (nonNegative(input.inputTokens) > codexPriorityInputTokenLimit) return undefined;
  const multiplier = codexAPIFastMultiplier(input.model);
  const standard = codexCostUSD(input);
  return multiplier === undefined || standard === undefined ? undefined : standard * multiplier;
}

export function resolveClaudePricing(
  model: string,
  options: CostPricingOptions = {},
): ClaudePricing | undefined {
  const key = normalizeClaudeModel(model);
  const historical =
    options.pricingDate !== undefined &&
    options.pricingDate < claudeFullContextStandardPricingCutoff
      ? claudeHistorical[key as keyof typeof claude]
      : undefined;
  if (historical !== undefined) return historical;
  const catalog = options.catalog?.lookup("anthropic", key);
  if (catalog !== undefined) return claudePricingFromCatalog(catalog);
  return claude[key as keyof typeof claude];
}

export function claudeCostUSD(input: {
  readonly model: string;
  readonly inputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheCreationInputTokens1h?: number;
  readonly outputTokens: number;
  readonly options?: CostPricingOptions;
}): number | undefined {
  const pricing = resolveClaudePricing(input.model, input.options);
  if (pricing === undefined) return undefined;
  const ordinary = nonNegative(input.inputTokens);
  const cacheRead = nonNegative(input.cacheReadInputTokens);
  const cacheCreation = nonNegative(input.cacheCreationInputTokens);
  const oneHour = Math.min(nonNegative(input.cacheCreationInputTokens1h ?? 0), cacheCreation);
  const fiveMinute = cacheCreation - oneHour;
  const long =
    pricing.thresholdTokens !== undefined &&
    ordinary + cacheRead + cacheCreation > pricing.thresholdTokens;
  const inputRate = long
    ? (pricing.inputCostPerTokenAboveThreshold ?? pricing.inputCostPerToken)
    : pricing.inputCostPerToken;
  const cacheReadRate = long
    ? (pricing.cacheReadInputCostPerTokenAboveThreshold ?? pricing.cacheReadInputCostPerToken)
    : pricing.cacheReadInputCostPerToken;
  const cacheCreationRate = long
    ? (pricing.cacheCreationInputCostPerTokenAboveThreshold ??
      pricing.cacheCreationInputCostPerToken)
    : pricing.cacheCreationInputCostPerToken;
  const outputRate = long
    ? (pricing.outputCostPerTokenAboveThreshold ?? pricing.outputCostPerToken)
    : pricing.outputCostPerToken;
  return (
    ordinary * inputRate +
    cacheRead * cacheReadRate +
    fiveMinute * cacheCreationRate +
    oneHour * inputRate * 2 +
    nonNegative(input.outputTokens) * outputRate
  );
}

function resolveCodexCatalogPrice(
  model: string,
  catalog: PricingCatalog | undefined,
): CodexPricing | undefined {
  if (catalog === undefined) return undefined;
  const trimmed = model.trim();
  const slash = trimmed.indexOf("/");
  if (slash >= 0) {
    const route = trimmed.slice(0, slash).toLowerCase();
    const id = trimmed.slice(slash + 1);
    if (!codexCatalogRoutes.has(route) || id.length === 0) return undefined;
    const aliases =
      route === "kimi-coding"
        ? [route, "kimi-for-coding"]
        : route === "opencode-free"
          ? [route, "opencode"]
          : [route];
    for (const provider of aliases) {
      const found = catalog.lookup(provider, id);
      if (found !== undefined)
        return codexPricingFromCatalog(
          found,
          provider === "openai" ? codex[normalizeCodexModel(id) as keyof typeof codex] : undefined,
        );
    }
    return undefined;
  }
  const exact = catalog.lookup("openai", trimmed);
  const canonical = normalizeCodexModel(trimmed);
  const found = exact ?? (canonical === trimmed ? undefined : catalog.lookup("openai", canonical));
  return found === undefined
    ? undefined
    : codexPricingFromCatalog(found, codex[canonical as keyof typeof codex]);
}

function codexPricingFromCatalog(
  price: ModelCatalogPrice,
  bundled: CodexPricing | undefined,
): CodexPricing {
  const context = price.contextOver200k;
  const hasContext = context !== undefined;
  const normalInput = perToken(price.inputPerMillion);
  return {
    inputCostPerToken: normalInput,
    outputCostPerToken: perToken(price.outputPerMillion),
    ...(price.cacheReadPerMillion === undefined
      ? bundled?.cacheReadInputCostPerToken === undefined
        ? {}
        : { cacheReadInputCostPerToken: bundled.cacheReadInputCostPerToken }
      : { cacheReadInputCostPerToken: perToken(price.cacheReadPerMillion) }),
    ...(price.cacheWritePerMillion === undefined
      ? bundled?.cacheWriteInputCostPerToken === undefined
        ? {}
        : { cacheWriteInputCostPerToken: bundled.cacheWriteInputCostPerToken }
      : { cacheWriteInputCostPerToken: perToken(price.cacheWritePerMillion) }),
    ...(hasContext
      ? { thresholdTokens: 200_000 }
      : bundled?.thresholdTokens === undefined
        ? {}
        : { thresholdTokens: bundled.thresholdTokens }),
    ...(context?.inputPerMillion === undefined
      ? !hasContext && bundled?.inputCostPerTokenAboveThreshold !== undefined
        ? { inputCostPerTokenAboveThreshold: bundled.inputCostPerTokenAboveThreshold }
        : {}
      : { inputCostPerTokenAboveThreshold: perToken(context.inputPerMillion) }),
    ...(context?.outputPerMillion === undefined
      ? !hasContext && bundled?.outputCostPerTokenAboveThreshold !== undefined
        ? { outputCostPerTokenAboveThreshold: bundled.outputCostPerTokenAboveThreshold }
        : {}
      : { outputCostPerTokenAboveThreshold: perToken(context.outputPerMillion) }),
    ...(context?.cacheReadPerMillion === undefined
      ? hasContext
        ? {
            cacheReadInputCostPerTokenAboveThreshold: perToken(
              price.cacheReadPerMillion ?? price.inputPerMillion,
            ),
          }
        : bundled?.cacheReadInputCostPerTokenAboveThreshold === undefined
          ? {}
          : {
              cacheReadInputCostPerTokenAboveThreshold:
                bundled.cacheReadInputCostPerTokenAboveThreshold,
            }
      : { cacheReadInputCostPerTokenAboveThreshold: perToken(context.cacheReadPerMillion) }),
    ...(context?.cacheWritePerMillion === undefined
      ? hasContext
        ? {
            cacheWriteInputCostPerTokenAboveThreshold: perToken(
              price.cacheWritePerMillion ?? price.inputPerMillion,
            ),
          }
        : bundled?.cacheWriteInputCostPerTokenAboveThreshold === undefined
          ? {}
          : {
              cacheWriteInputCostPerTokenAboveThreshold:
                bundled.cacheWriteInputCostPerTokenAboveThreshold,
            }
      : { cacheWriteInputCostPerTokenAboveThreshold: perToken(context.cacheWritePerMillion) }),
  };
}

function claudePricingFromCatalog(price: ModelCatalogPrice): ClaudePricing {
  const context = price.contextOver200k;
  return {
    inputCostPerToken: perToken(price.inputPerMillion),
    outputCostPerToken: perToken(price.outputPerMillion),
    cacheCreationInputCostPerToken: perToken(price.cacheWritePerMillion ?? price.inputPerMillion),
    cacheReadInputCostPerToken: perToken(price.cacheReadPerMillion ?? price.inputPerMillion),
    ...(context === undefined ? {} : { thresholdTokens: 200_000 }),
    ...(context?.inputPerMillion === undefined
      ? {}
      : { inputCostPerTokenAboveThreshold: perToken(context.inputPerMillion) }),
    ...(context?.outputPerMillion === undefined
      ? {}
      : { outputCostPerTokenAboveThreshold: perToken(context.outputPerMillion) }),
    ...(context?.cacheWritePerMillion === undefined
      ? {}
      : { cacheCreationInputCostPerTokenAboveThreshold: perToken(context.cacheWritePerMillion) }),
    ...(context?.cacheReadPerMillion === undefined
      ? {}
      : { cacheReadInputCostPerTokenAboveThreshold: perToken(context.cacheReadPerMillion) }),
  };
}

function nonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}
