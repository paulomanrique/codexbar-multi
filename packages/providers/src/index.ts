export * from "./types.ts";
export * from "./registry.ts";
export * from "./snapshot-mapper.ts";

import { installProviderRegistry, PROVIDER_REGISTRY } from "./registry.ts";
import { clawrouter } from "./providers/clawrouter.ts";
import { aiand } from "./providers/aiand.ts";
import { azureopenai } from "./providers/azureopenai.ts";
import { bedrock } from "./providers/bedrock.ts";
import { chutes } from "./providers/chutes.ts";
import { codex } from "./providers/codex.ts";
import { clinepass } from "./providers/clinepass.ts";
import { codebuff } from "./providers/codebuff.ts";
import { copilot } from "./providers/copilot.ts";
import { crof } from "./providers/crof.ts";
import { deepinfra } from "./providers/deepinfra.ts";
import { deepseek } from "./providers/deepseek.ts";
import { deepgram } from "./providers/deepgram.ts";
import { doubao } from "./providers/doubao.ts";
import { elevenlabs } from "./providers/elevenlabs.ts";
import { fireworks } from "./providers/fireworks.ts";
import { gemini } from "./providers/gemini.ts";
import { groq } from "./providers/groq.ts";
import { ibmbob } from "./providers/ibmbob.ts";
import { llmproxy } from "./providers/llmproxy.ts";
import { litellm } from "./providers/litellm.ts";
import { manus } from "./providers/manus.ts";
import { moonshot } from "./providers/moonshot.ts";
import { minimax } from "./providers/minimax.ts";
import { neuralwatt } from "./providers/neuralwatt.ts";
import { openai } from "./providers/openai.ts";
import { openrouter } from "./providers/openrouter.ts";
import { perplexity } from "./providers/perplexity.ts";
import { poe } from "./providers/poe.ts";
import { qoder } from "./providers/qoder.ts";
import { sub2api } from "./providers/sub2api.ts";
import { synthetic } from "./providers/synthetic.ts";
import { t3chat } from "./providers/t3chat.ts";
import { venice } from "./providers/venice.ts";
import { vertexai } from "./providers/vertexai.ts";
import { xai } from "./providers/xai.ts";
import { zai } from "./providers/zai.ts";
import { warp } from "./providers/warp.ts";
import { wayfinder } from "./providers/wayfinder.ts";
import { zenmux } from "./providers/zenmux.ts";

export const FIRST_PARTY_PROVIDERS = [
  codex,
  aiand,
  azureopenai,
  bedrock,
  chutes,
  clawrouter,
  clinepass,
  codebuff,
  copilot,
  crof,
  deepinfra,
  deepseek,
  deepgram,
  doubao,
  elevenlabs,
  fireworks,
  gemini,
  groq,
  ibmbob,
  llmproxy,
  litellm,
  manus,
  moonshot,
  minimax,
  neuralwatt,
  openai,
  openrouter,
  perplexity,
  poe,
  qoder,
  sub2api,
  synthetic,
  t3chat,
  venice,
  vertexai,
  warp,
  wayfinder,
  xai,
  zai,
  zenmux,
] as const;

export const PROVIDERS = installProviderRegistry(FIRST_PARTY_PROVIDERS);
export { PROVIDER_REGISTRY };
export const PROVIDER_DESCRIPTORS = PROVIDER_REGISTRY;

export { clawrouter } from "./providers/clawrouter.ts";
export { aiand } from "./providers/aiand.ts";
export { azureopenai } from "./providers/azureopenai.ts";
export { bedrock } from "./providers/bedrock.ts";
export { chutes } from "./providers/chutes.ts";
export { codex } from "./providers/codex.ts";
export { clinepass } from "./providers/clinepass.ts";
export { codebuff } from "./providers/codebuff.ts";
export { copilot } from "./providers/copilot.ts";
export { crof } from "./providers/crof.ts";
export { deepinfra } from "./providers/deepinfra.ts";
export { deepseek } from "./providers/deepseek.ts";
export { deepgram } from "./providers/deepgram.ts";
export { doubao } from "./providers/doubao.ts";
export { elevenlabs } from "./providers/elevenlabs.ts";
export { fireworks } from "./providers/fireworks.ts";
export { gemini } from "./providers/gemini.ts";
export { groq } from "./providers/groq.ts";
export { ibmbob } from "./providers/ibmbob.ts";
export { llmproxy } from "./providers/llmproxy.ts";
export { litellm } from "./providers/litellm.ts";
export { manus } from "./providers/manus.ts";
export { moonshot } from "./providers/moonshot.ts";
export { minimax } from "./providers/minimax.ts";
export { neuralwatt } from "./providers/neuralwatt.ts";
export { openai } from "./providers/openai.ts";
export { openrouter } from "./providers/openrouter.ts";
export { perplexity } from "./providers/perplexity.ts";
export { poe } from "./providers/poe.ts";
export { qoder } from "./providers/qoder.ts";
export { sub2api } from "./providers/sub2api.ts";
export { synthetic } from "./providers/synthetic.ts";
export { t3chat } from "./providers/t3chat.ts";
export { venice } from "./providers/venice.ts";
export { vertexai } from "./providers/vertexai.ts";
export { warp } from "./providers/warp.ts";
export { wayfinder } from "./providers/wayfinder.ts";
export { xai } from "./providers/xai.ts";
export { zai } from "./providers/zai.ts";
export { zenmux } from "./providers/zenmux.ts";
