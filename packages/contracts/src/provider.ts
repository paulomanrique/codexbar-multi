import * as Schema from "effect/Schema";

/** The source-order provider roster from CodexBar 0.54.0 (baseline 453174fe). */
export const PROVIDER_IDS = [
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

export type ProviderId = (typeof PROVIDER_IDS)[number];
export const ProviderId = Schema.Literals(PROVIDER_IDS);
/** Naming aliases used by the Swift oracle and by migration adapters. */
export const UsageProvider = ProviderId;
export type UsageProvider = ProviderId;
export const ProviderID = ProviderId;
export type ProviderID = ProviderId;

/** IDs are extensible for user plugins, but deliberately constrained to the Swift baseline format. */
export const ProviderInstanceId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z0-9-]{1,64}$/)),
);
export type ProviderInstanceId = Schema.Schema.Type<typeof ProviderInstanceId>;
export const ProviderInstanceID = ProviderInstanceId;
export type ProviderInstanceID = ProviderInstanceId;

export const ProviderSourceMode = Schema.Literals(["auto", "web", "cli", "oauth", "api"]);
export type ProviderSourceMode = Schema.Schema.Type<typeof ProviderSourceMode>;

export const ProviderRuntime = Schema.Literals(["app", "cli"]);
export type ProviderRuntime = Schema.Schema.Type<typeof ProviderRuntime>;

export const ProviderFetchKind = Schema.Literals([
  "cli",
  "web",
  "oauth",
  "api-token",
  "local-probe",
  "web-dashboard",
]);
export type ProviderFetchKind = Schema.Schema.Type<typeof ProviderFetchKind>;

const NonEmptyString = Schema.String.pipe(Schema.check(Schema.isMinLength(1)));
const OptionalString = Schema.optional(Schema.String);

/** Serializable descriptor data. Fetch functions and credential stores are intentionally absent. */
export const ProviderDescriptor = Schema.Struct({
  id: ProviderId,
  displayName: NonEmptyString,
  shortDisplayName: Schema.optional(NonEmptyString),
  cliName: NonEmptyString,
  defaultEnabled: Schema.Boolean,
  widgetSelectable: Schema.optional(Schema.Boolean),
  isPrimaryProvider: Schema.optional(Schema.Boolean),
  balanceOnly: Schema.optional(Schema.Boolean),
  sourceModes: Schema.Array(ProviderSourceMode),
  defaultSourceMode: ProviderSourceMode,
  supportsCredits: Schema.optional(Schema.Boolean),
  supportsTokenCost: Schema.optional(Schema.Boolean),
  dashboardUrl: OptionalString,
});
export type ProviderDescriptor = Schema.Schema.Type<typeof ProviderDescriptor>;

export const ProviderDescriptorRegistry = Schema.Array(ProviderDescriptor);
export type ProviderDescriptorRegistry = Schema.Schema.Type<typeof ProviderDescriptorRegistry>;

export const ProviderStatusIndicator = Schema.Literals([
  "none",
  "minor",
  "major",
  "critical",
  "maintenance",
  "unknown",
]);
export type ProviderStatusIndicator = Schema.Schema.Type<typeof ProviderStatusIndicator>;

export const ProviderStatus = Schema.Struct({
  indicator: ProviderStatusIndicator,
  description: Schema.optional(Schema.String),
  updatedAt: Schema.optional(Schema.String),
  url: Schema.String,
});
export type ProviderStatus = Schema.Schema.Type<typeof ProviderStatus>;
