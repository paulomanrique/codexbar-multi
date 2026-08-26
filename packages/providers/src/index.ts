export * from "./types.ts";
export * from "./registry.ts";
export * from "./snapshot-mapper.ts";
export * from "./token-account-support.ts";
export * from "./providers/codex-dashboard-authority.ts";

import { installProviderRegistry, PROVIDER_REGISTRY } from "./registry.ts";
import { aiand } from "./providers/aiand.ts";
import { abacus } from "./providers/abacus.ts";
import { alibaba } from "./providers/alibaba.ts";
import { alibabatokenplan } from "./providers/alibabatokenplan.ts";
import { amp } from "./providers/amp.ts";
import { antigravity } from "./providers/antigravity.ts";
import { augment } from "./providers/augment.ts";
import { azureopenai } from "./providers/azureopenai.ts";
import { bedrock } from "./providers/bedrock.ts";
import { chutes } from "./providers/chutes.ts";
import { claude } from "./providers/claude.ts";
import { clawrouter } from "./providers/clawrouter.ts";
import { clinepass } from "./providers/clinepass.ts";
import { codex } from "./providers/codex.ts";
import { codebuff } from "./providers/codebuff.ts";
import { commandcode } from "./providers/commandcode.ts";
import { copilot } from "./providers/copilot.ts";
import { crof } from "./providers/crof.ts";
import { cursor } from "./providers/cursor.ts";
import { deepinfra } from "./providers/deepinfra.ts";
import { deepseek } from "./providers/deepseek.ts";
import { deepgram } from "./providers/deepgram.ts";
import { devin } from "./providers/devin.ts";
import { doubao } from "./providers/doubao.ts";
import { elevenlabs } from "./providers/elevenlabs.ts";
import { factory } from "./providers/factory.ts";
import { fireworks } from "./providers/fireworks.ts";
import { gemini } from "./providers/gemini.ts";
import { grok } from "./providers/grok.ts";
import { groq } from "./providers/groq.ts";
import { ibmbob } from "./providers/ibmbob.ts";
import { jetbrains } from "./providers/jetbrains.ts";
import { kimi } from "./providers/kimi.ts";
import { kilo } from "./providers/kilo.ts";
import { kiro } from "./providers/kiro.ts";
import { llmproxy } from "./providers/llmproxy.ts";
import { litellm } from "./providers/litellm.ts";
import { longcat } from "./providers/longcat.ts";
import { manus } from "./providers/manus.ts";
import { mimo } from "./providers/mimo.ts";
import { mistral } from "./providers/mistral.ts";
import { moonshot } from "./providers/moonshot.ts";
import { minimax } from "./providers/minimax.ts";
import { neuralwatt } from "./providers/neuralwatt.ts";
import { notion } from "./providers/notion.ts";
import { openai } from "./providers/openai.ts";
import { ollama } from "./providers/ollama.ts";
import { opencode } from "./providers/opencode.ts";
import { opencodego } from "./providers/opencodego.ts";
import { openrouter } from "./providers/openrouter.ts";
import { perplexity } from "./providers/perplexity.ts";
import { poe } from "./providers/poe.ts";
import { qoder } from "./providers/qoder.ts";
import { qwencloud } from "./providers/qwencloud.ts";
import { sakana } from "./providers/sakana.ts";
import { sub2api } from "./providers/sub2api.ts";
import { synthetic } from "./providers/synthetic.ts";
import { stepfun } from "./providers/stepfun.ts";
import { t3chat } from "./providers/t3chat.ts";
import { venice } from "./providers/venice.ts";
import { vertexai } from "./providers/vertexai.ts";
import { windsurf } from "./providers/windsurf.ts";
import { xai } from "./providers/xai.ts";
import { zai } from "./providers/zai.ts";
import { zed } from "./providers/zed.ts";
import { warp } from "./providers/warp.ts";
import { wayfinder } from "./providers/wayfinder.ts";
import { zenmux } from "./providers/zenmux.ts";
import { zoommate } from "./providers/zoommate.ts";

export const FIRST_PARTY_PROVIDERS = [
  codex,
  abacus,
  aiand,
  alibaba,
  alibabatokenplan,
  amp,
  antigravity,
  augment,
  azureopenai,
  bedrock,
  chutes,
  claude,
  clawrouter,
  clinepass,
  codebuff,
  commandcode,
  copilot,
  crof,
  cursor,
  deepinfra,
  deepseek,
  deepgram,
  devin,
  doubao,
  elevenlabs,
  factory,
  fireworks,
  gemini,
  grok,
  groq,
  ibmbob,
  jetbrains,
  kimi,
  kilo,
  kiro,
  llmproxy,
  litellm,
  longcat,
  manus,
  mimo,
  mistral,
  moonshot,
  minimax,
  neuralwatt,
  notion,
  openai,
  ollama,
  opencode,
  opencodego,
  openrouter,
  perplexity,
  poe,
  qoder,
  qwencloud,
  sakana,
  sub2api,
  synthetic,
  stepfun,
  t3chat,
  venice,
  vertexai,
  windsurf,
  warp,
  wayfinder,
  xai,
  zai,
  zed,
  zenmux,
  zoommate,
] as const;

export const PROVIDERS = installProviderRegistry(FIRST_PARTY_PROVIDERS);
export { PROVIDER_REGISTRY };
export const PROVIDER_DESCRIPTORS = PROVIDER_REGISTRY;

export { clawrouter } from "./providers/clawrouter.ts";
export { abacus } from "./providers/abacus.ts";
export { aiand } from "./providers/aiand.ts";
export { amp } from "./providers/amp.ts";
export { alibaba } from "./providers/alibaba.ts";
export { alibabatokenplan } from "./providers/alibabatokenplan.ts";
export { antigravity } from "./providers/antigravity.ts";
export { augment } from "./providers/augment.ts";
export { azureopenai } from "./providers/azureopenai.ts";
export { bedrock } from "./providers/bedrock.ts";
export { chutes } from "./providers/chutes.ts";
export { claude } from "./providers/claude.ts";
export * from "./providers/claude-swap-retention.ts";
export { codex } from "./providers/codex.ts";
export { clinepass } from "./providers/clinepass.ts";
export { codebuff } from "./providers/codebuff.ts";
export { commandcode } from "./providers/commandcode.ts";
export { copilot } from "./providers/copilot.ts";
export { crof } from "./providers/crof.ts";
export { cursor } from "./providers/cursor.ts";
export { deepinfra } from "./providers/deepinfra.ts";
export { deepseek } from "./providers/deepseek.ts";
export { deepgram } from "./providers/deepgram.ts";
export { devin } from "./providers/devin.ts";
export { doubao } from "./providers/doubao.ts";
export { elevenlabs } from "./providers/elevenlabs.ts";
export { factory } from "./providers/factory.ts";
export {
  fireworks,
  InvalidFireworksAccountSlug,
  InvalidFireworksSummary,
  parseFireworksSummary,
  resolveFireworksAccountSlug,
  resolveFireworksAPIKey,
  resolveFireworksSummaryURL,
} from "./providers/fireworks.ts";
export { gemini } from "./providers/gemini.ts";
export { groq } from "./providers/groq.ts";
export { grok } from "./providers/grok.ts";
export { parseGrokAuthJson, parseGrokCreditsProxyResponse } from "./providers/grok.ts";
export * from "./providers/grok-local-session.ts";
export { ibmbob } from "./providers/ibmbob.ts";
export { jetbrains } from "./providers/jetbrains.ts";
export { kimi } from "./providers/kimi.ts";
export { kilo } from "./providers/kilo.ts";
export { kiro } from "./providers/kiro.ts";
export { llmproxy } from "./providers/llmproxy.ts";
export { litellm } from "./providers/litellm.ts";
export { longcat } from "./providers/longcat.ts";
export { manus } from "./providers/manus.ts";
export { mimo } from "./providers/mimo.ts";
export { mistral } from "./providers/mistral.ts";
export { moonshot, resolveMoonshotAPIKey, resolveMoonshotRegion } from "./providers/moonshot.ts";
export { minimax } from "./providers/minimax.ts";
export { neuralwatt } from "./providers/neuralwatt.ts";
export { notion } from "./providers/notion.ts";
export { openai } from "./providers/openai.ts";
export { ollama } from "./providers/ollama.ts";
export { opencode } from "./providers/opencode.ts";
export { opencodego } from "./providers/opencodego.ts";
export { openrouter } from "./providers/openrouter.ts";
export { perplexity } from "./providers/perplexity.ts";
export { poe } from "./providers/poe.ts";
export { qoder } from "./providers/qoder.ts";
export { qwencloud } from "./providers/qwencloud.ts";
export { sakana } from "./providers/sakana.ts";
export { sub2api } from "./providers/sub2api.ts";
export { synthetic } from "./providers/synthetic.ts";
export { stepfun } from "./providers/stepfun.ts";
export { t3chat } from "./providers/t3chat.ts";
export { venice } from "./providers/venice.ts";
export { vertexai } from "./providers/vertexai.ts";
export { windsurf } from "./providers/windsurf.ts";
export { warp } from "./providers/warp.ts";
export { wayfinder } from "./providers/wayfinder.ts";
export { xai } from "./providers/xai.ts";
export { zai } from "./providers/zai.ts";
export { zed } from "./providers/zed.ts";
export { zenmux } from "./providers/zenmux.ts";
export { zoommate } from "./providers/zoommate.ts";
