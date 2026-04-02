/**
 * Groq chat model catalog — keep in sync with backend validation (Rust allows matching id pattern).
 */

export type GroqModelTier =
  | 'gemini'
  | 'flagship'
  | 'high_performance'
  | 'ultra_fast'
  | 'specialized'
  | 'openrouter_free'

export interface GroqModelInfo {
  id: string
  label: string
  tier: GroqModelTier
  speedBadge: 'Fast' | 'Balanced' | 'Deep' | 'Instant'
  contextWindow: number
  description: string
  /** Groq vision / multimodal chat (image_url in user messages). */
  supportsVision?: boolean
}

export const DEFAULT_GROQ_MODEL_ID = 'nvidia/nemotron-3-super-120b-a12b:free'
export const DEFAULT_SCHEMA_AI_PROVIDER = 'worker'
export const SCHEMA_AI_WORKER_DEFAULT_MODEL_ID = '@cf/meta/llama-3.3-70b-instruct-fp8-fast'

/** Default when the user attaches images and the current model is text-only. */
export const DEFAULT_GROQ_VISION_MODEL_ID =
  'meta-llama/llama-4-scout-17b-16e-instruct'

export const GROQ_MODELS: GroqModelInfo[] = [
  {
    id: 'gemini-2.5-pro',
    label: 'Gemini 2.5 Pro',
    tier: 'gemini',
    speedBadge: 'Deep',
    contextWindow: 1048576,
    description: 'Top-tier Gemini model for complex schema planning and deep reasoning.',
  },
  {
    id: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    tier: 'gemini',
    speedBadge: 'Balanced',
    contextWindow: 1048576,
    description: 'Best quality/speed balance for most schema generation workflows.',
  },
  {
    id: 'gemini-2.5-flash-lite',
    label: 'Gemini 2.5 Flash-Lite',
    tier: 'gemini',
    speedBadge: 'Fast',
    contextWindow: 1048576,
    description: 'Low-latency Gemini for quick iterations and lightweight refinements.',
  },
  {
    id: 'gemini-2.0-flash',
    label: 'Gemini 2.0 Flash',
    tier: 'gemini',
    speedBadge: 'Fast',
    contextWindow: 1048576,
    description: 'Reliable fast Gemini option for broad schema drafting tasks.',
  },
  {
    id: 'gemini-1.5-pro',
    label: 'Gemini 1.5 Pro',
    tier: 'gemini',
    speedBadge: 'Balanced',
    contextWindow: 1048576,
    description: 'Stable Pro-tier Gemini model with strong long-context capabilities.',
  },
  {
    id: 'gemini-1.5-flash',
    label: 'Gemini 1.5 Flash',
    tier: 'gemini',
    speedBadge: 'Fast',
    contextWindow: 1048576,
    description: 'Fast Gemini model for responsive schema exploration and edits.',
  },
  {
    id: 'openrouter/free',
    label: 'OpenRouter Free (Auto Pool)',
    tier: 'openrouter_free',
    speedBadge: 'Balanced',
    contextWindow: 131072,
    description:
      'OpenRouter free model pool alias. Automatically routes to an available free model.',
  },
  {
    id: 'nvidia/nemotron-3-super-120b-a12b:free',
    label: 'OpenRouter Nemotron 3 Super 120B (Free)',
    tier: 'openrouter_free',
    speedBadge: 'Balanced',
    contextWindow: 131072,
    description:
      'OpenRouter free-tier model for high-quality schema generation with no paid quota.',
  },
  {
    id: 'deepseek/deepseek-r1-0528:free',
    label: 'OpenRouter DeepSeek R1 0528 (Free)',
    tier: 'openrouter_free',
    speedBadge: 'Deep',
    contextWindow: 65536,
    description: 'OpenRouter free reasoning model for normalization and tradeoff-heavy design.',
  },
  {
    id: 'google/gemma-3-27b-it:free',
    label: 'OpenRouter Gemma 3 27B (Free)',
    tier: 'openrouter_free',
    speedBadge: 'Fast',
    contextWindow: 32768,
    description: 'OpenRouter free model for fast drafts and iterative schema refinement.',
  },
  {
    id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    label: 'Llama 3.3 70B FP8 Fast (Worker)',
    tier: 'flagship',
    speedBadge: 'Fast',
    contextWindow: 131072,
    description:
      'Default schema model routed through the managed AI worker endpoint for stable generation.',
  },
  {
    id: '@cf/moonshotai/kimi-k2.5',
    label: 'Cloudflare Kimi K2.5',
    tier: 'flagship',
    speedBadge: 'Balanced',
    contextWindow: 131072,
    description: 'Cloudflare ai/run model for long-context and high quality reasoning.',
  },
  {
    id: '@cf/nvidia/nemotron-3-120b-a12b',
    label: 'Cloudflare Nemotron 3 120B',
    tier: 'high_performance',
    speedBadge: 'Balanced',
    contextWindow: 131072,
    description: 'Cloudflare ai/run large model for robust enterprise-grade completions.',
  },
  {
    id: '@cf/meta/llama-4-scout-17b-16e-instruct',
    label: 'Cloudflare Llama 4 Scout 17B',
    tier: 'high_performance',
    speedBadge: 'Fast',
    contextWindow: 131072,
    description: 'Cloudflare ai/run multimodal-capable Scout variant for fast generation.',
    supportsVision: true,
  },
  {
    id: '@cf/openai/gpt-oss-120b',
    label: 'Cloudflare GPT-OSS 120B',
    tier: 'flagship',
    speedBadge: 'Balanced',
    contextWindow: 131072,
    description: 'Cloudflare AI Gateway provider route for large-context schema generation.',
  },
  {
    id: 'openai/gpt-oss-120b',
    label: 'GPT-OSS 120B',
    tier: 'flagship',
    speedBadge: 'Balanced',
    contextWindow: 131072,
    description: 'Large open-weight flagship for complex schema reasoning.',
  },
  {
    id: 'meta-llama/llama-4-maverick-17b-128e-instruct',
    label: 'Llama 4 Maverick 17B',
    tier: 'flagship',
    speedBadge: 'Balanced',
    contextWindow: 131072,
    description: 'Llama 4 multimodal-class instruct; strong general reasoning.',
    supportsVision: true,
  },
  {
    id: 'meta-llama/llama-4-scout-17b-16e-instruct',
    label: 'Llama 4 Scout 17B',
    tier: 'high_performance',
    speedBadge: 'Fast',
    contextWindow: 131072,
    description: 'Efficient Llama 4 variant for fast iterations.',
    supportsVision: true,
  },
  {
    id: 'deepseek-r1-distill-llama-70b',
    label: 'DeepSeek R1 Distill (Llama 70B)',
    tier: 'specialized',
    speedBadge: 'Deep',
    contextWindow: 131072,
    description: 'Reasoning-first; use for normalization and tradeoff analysis.',
  },
  {
    id: 'moonshotai/kimi-k2-instruct-0905',
    label: 'Kimi K2 Instruct',
    tier: 'high_performance',
    speedBadge: 'Balanced',
    contextWindow: 262144,
    description: 'Long-context instruct model for large specifications.',
  },
  {
    id: 'qwen/qwq-32b',
    label: 'Qwen QwQ 32B',
    tier: 'specialized',
    speedBadge: 'Deep',
    contextWindow: 32768,
    description: 'Reasoning-focused Qwen for structured design tasks.',
  },
  {
    id: 'compound-beta',
    label: 'Compound Beta',
    tier: 'specialized',
    speedBadge: 'Balanced',
    contextWindow: 8192,
    description: 'Agentic compound workflows on Groq.',
  },
  {
    id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    label: 'Llama 3.3 70B',
    tier: 'flagship',
    speedBadge: 'Balanced',
    contextWindow: 131072,
    description: 'Versatile high-IQ workhorse for schemas and docs.',
  },
  {
    id: 'llama-3.1-8b-instant',
    label: 'Llama 3.1 8B Instant',
    tier: 'ultra_fast',
    speedBadge: 'Instant',
    contextWindow: 131072,
    description: 'Lowest latency for quick drafts and small domains.',
  },
  {
    id: 'gemma2-9b-it',
    label: 'Gemma 2 9B IT',
    tier: 'ultra_fast',
    speedBadge: 'Fast',
    contextWindow: 8192,
    description: 'Lightweight Google Gemma instruct for fast passes.',
  },
  {
    id: 'mistral-saba-24b',
    label: 'Mistral Saba 24B',
    tier: 'high_performance',
    speedBadge: 'Balanced',
    contextWindow: 32768,
    description: 'Mistral mid-size instruct for balanced quality/speed.',
  },
  {
    id: 'mixtral-8x7b-32768',
    label: 'Mixtral 8x7B',
    tier: 'high_performance',
    speedBadge: 'Fast',
    contextWindow: 32768,
    description: 'MoE architecture; strong for wide multi-table designs.',
  },
]

const TIER_LABEL: Record<GroqModelTier, string> = {
  gemini: 'Google Gemini',
  flagship: 'Flagship',
  high_performance: 'High performance',
  ultra_fast: 'Ultra fast',
  specialized: 'Specialized',
  openrouter_free: 'OpenRouter free',
}

export function groqModelsGrouped(): { tier: GroqModelTier; label: string; models: GroqModelInfo[] }[] {
  const tiers: GroqModelTier[] = [
    'gemini',
    'openrouter_free',
    'flagship',
    'high_performance',
    'ultra_fast',
    'specialized',
  ]
  return tiers.map((tier) => ({
    tier,
    label: TIER_LABEL[tier],
    models: GROQ_MODELS.filter((m) => m.tier === tier),
  }))
}

export function getGroqModelById(id: string): GroqModelInfo | undefined {
  return GROQ_MODELS.find((m) => m.id === id)
}

export function groqModelSupportsVision(modelId: string): boolean {
  return getGroqModelById(modelId)?.supportsVision === true
}

/** If images are attached, ensure a vision-capable model id. */
export function pickGroqModelForAttachments(
  currentId: string,
  hasAttachments: boolean
): string {
  if (!hasAttachments) return currentId
  if (groqModelSupportsVision(currentId)) return currentId
  return DEFAULT_GROQ_VISION_MODEL_ID
}

export type SchemaAiProvider =
  | 'groq'
  | 'cloudflare'
  | 'worker'
  | 'openrouter'
  | 'gemini'

export function isSchemaAiWorkerModel(modelId: string): boolean {
  return modelId.trim() === SCHEMA_AI_WORKER_DEFAULT_MODEL_ID
}

export function providerForSchemaAiModel(modelId: string): SchemaAiProvider {
  const id = modelId.trim()
  if (isSchemaAiWorkerModel(modelId)) return 'worker'
  if (id.startsWith('@cf/')) return 'cloudflare'
  if (id.startsWith('gemini-') || id.startsWith('models/gemini-')) return 'gemini'
  if (id.startsWith('openrouter/') || id.includes(':free')) return 'openrouter'
  return 'groq'
}
