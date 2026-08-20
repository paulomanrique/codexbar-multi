import { describe, expect, it } from "vite-plus/test";

import {
  claudeCostUSD,
  codexAPIFastCostUSD,
  codexCostUSD,
  codexUnattributedModel,
  type ModelCatalogPrice,
  normalizeClaudeModel,
  normalizeCodexModel,
  type PricingCatalog,
} from "../src/index.ts";

function catalog(
  entries: Readonly<Record<string, Readonly<Record<string, ModelCatalogPrice>>>>,
): PricingCatalog {
  return {
    lookup(providerId, modelId) {
      return entries[providerId]?.[modelId];
    },
  };
}

describe("cost pricing (Swift parity)", () => {
  it("normalizes Codex aliases and dated variants", () => {
    expect(normalizeCodexModel("openai/gpt-5-codex")).toBe("gpt-5-codex");
    expect(normalizeCodexModel("gpt-5.4-mini-2026-03-17")).toBe("gpt-5.4-mini");
    expect(normalizeCodexModel("openai/gpt-5.6-terra-2099-01-01")).toBe("gpt-5.6-terra");
    expect(normalizeCodexModel("gpt-5.6")).toBe("gpt-5.6-sol");
  });

  it("fails closed for unattributed or an unknown routed model", () => {
    const prices = catalog({
      openai: { unknown: { inputPerMillion: 99, outputPerMillion: 199 } },
    });
    expect(
      codexCostUSD({
        model: codexUnattributedModel,
        inputTokens: 100,
        outputTokens: 1,
        options: { catalog: prices },
      }),
    ).toBeUndefined();
    expect(
      codexCostUSD({
        model: "unlisted-route/gpt-5.6-sol",
        inputTokens: 100,
        outputTokens: 1,
        options: { catalog: prices },
      }),
    ).toBeUndefined();
  });

  it("prices Sol, Terra, Luna and the unsuffixed alias with bundled rates", () => {
    const input = { inputTokens: 100, cachedInputTokens: 10, outputTokens: 5 };
    expect(codexCostUSD({ model: "gpt-5.6-sol", ...input })).toBeCloseTo(0.000605, 12);
    expect(codexCostUSD({ model: "gpt-5.6-terra", ...input })).toBeCloseTo(0.000242, 12);
    expect(codexCostUSD({ model: "gpt-5.6-luna", ...input })).toBeCloseTo(0.0000242, 12);
    expect(codexCostUSD({ model: "gpt-5.6", ...input })).toBeCloseTo(0.000605, 12);
  });

  it("uses historical Terra and Luna rates only before the July 2026 cutover", () => {
    const input = {
      model: "gpt-5.6-terra",
      inputTokens: 100,
      cachedInputTokens: 10,
      outputTokens: 5,
    };
    const old = codexCostUSD({ ...input, options: { pricingDate: new Date(1_785_369_599_000) } });
    const current = codexCostUSD({
      ...input,
      options: { pricingDate: new Date(1_785_369_601_000) },
    });
    expect(old).toBeCloseTo(0.0003025, 12);
    expect(current).toBeCloseTo(0.000242, 12);
    expect(old).toBeGreaterThan(current ?? 0);
  });

  it("clamps cache tokens and never double-bills them", () => {
    expect(
      codexCostUSD({ model: "gpt-5.5", inputTokens: 20, cachedInputTokens: 500, outputTokens: 5 }),
    ).toBeCloseTo(0.00016, 12);
    expect(
      codexCostUSD({
        model: "gpt-5-codex",
        inputTokens: 1000,
        cachedInputTokens: 900,
        outputTokens: 10,
      }),
    ).toBeCloseTo(0.0003375, 12);
  });

  it("prices Codex cache writes separately and applies long context to the whole request", () => {
    expect(
      codexCostUSD({
        model: "gpt-5.6-sol",
        inputTokens: 100,
        cachedInputTokens: 10,
        cacheWriteInputTokens: 20,
        outputTokens: 5,
      }),
    ).toBeCloseTo(0.00063, 12);
    expect(
      codexCostUSD({
        model: "gpt-5.6-sol",
        inputTokens: 272_001,
        cachedInputTokens: 10,
        cacheWriteInputTokens: 20,
        outputTokens: 10,
      }),
    ).toBeCloseTo(2.72042, 12);
  });

  it("prices API Fast from standard pricing and rejects long-context Fast", () => {
    expect(
      codexAPIFastCostUSD({
        model: "gpt-5.6-sol",
        inputTokens: 100_000,
        cachedInputTokens: 20_000,
        outputTokens: 20_000,
      }),
    ).toBeCloseTo(2.02, 12);
    expect(
      codexAPIFastCostUSD({ model: "gpt-5.5", inputTokens: 272_001, outputTokens: 1 }),
    ).toBeUndefined();
  });

  it("allows injected catalog prices without cross-charging a provider route", () => {
    const prices = catalog({
      deepseek: { "deepseek-v4-flash": { inputPerMillion: 0.14, outputPerMillion: 0.28 } },
      openai: { "gpt-5.6-sol": { inputPerMillion: 7, outputPerMillion: 31 } },
    });
    expect(
      codexCostUSD({
        model: "deepseek/deepseek-v4-flash",
        inputTokens: 100,
        outputTokens: 5,
        options: { catalog: prices },
      }),
    ).toBeCloseTo(0.0000154, 14);
    expect(
      codexCostUSD({
        model: "gpt-5.6",
        inputTokens: 100,
        outputTokens: 0,
        options: { catalog: prices },
      }),
    ).toBeCloseTo(0.0007, 14);
  });

  it("normalizes Claude dated and Bedrock forms", () => {
    expect(normalizeClaudeModel("claude-opus-4-1-20250805")).toBe("claude-opus-4-1");
    expect(normalizeClaudeModel("anthropic.claude-sonnet-4-6-v1:0")).toBe("claude-sonnet-4-6");
  });

  it("prices Claude cache reads, 5m writes, and 1h writes without inventing tokens", () => {
    expect(
      claudeCostUSD({
        model: "claude-fable-5",
        inputTokens: 100,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 30,
        cacheCreationInputTokens1h: 20,
        outputTokens: 5,
      }),
    ).toBeCloseTo(0.001795, 12);
    expect(
      claudeCostUSD({
        model: "claude-fable-5",
        inputTokens: -1,
        cacheReadInputTokens: -2,
        cacheCreationInputTokens: 10,
        cacheCreationInputTokens1h: 50,
        outputTokens: -5,
      }),
    ).toBeCloseTo(0.0002, 12);
  });

  it("uses Claude historical long context before its cutover and current full-context pricing afterwards", () => {
    const input = {
      model: "claude-sonnet-4-6",
      inputTokens: 240_000,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 0,
    };
    expect(
      claudeCostUSD({ ...input, options: { pricingDate: new Date(1_773_359_999_000) } }),
    ).toBeCloseTo(1.44, 12);
    expect(
      claudeCostUSD({ ...input, options: { pricingDate: new Date(1_773_360_000_000) } }),
    ).toBeCloseTo(0.72, 12);
  });

  it("uses an injected Claude long-context catalog and fails closed for unknown models", () => {
    const prices = catalog({
      anthropic: {
        "claude-threshold-model": {
          inputPerMillion: 3,
          outputPerMillion: 15,
          cacheReadPerMillion: 0.3,
          cacheWritePerMillion: 3.75,
          contextOver200k: {
            inputPerMillion: 6,
            outputPerMillion: 22.5,
            cacheReadPerMillion: 0.6,
            cacheWritePerMillion: 7.5,
          },
        },
      },
    });
    expect(
      claudeCostUSD({
        model: "claude-threshold-model",
        inputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 240_000,
        cacheCreationInputTokens1h: 120_000,
        outputTokens: 0,
        options: { catalog: prices },
      }),
    ).toBeCloseTo(2.34, 12);
    expect(
      claudeCostUSD({
        model: "glm-4.6",
        inputTokens: 1,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        outputTokens: 1,
      }),
    ).toBeUndefined();
  });
});
