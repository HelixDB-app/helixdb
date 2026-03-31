import templatesJson from '@/data/schema-designer-templates.json'
import type {
  GenerationOptions,
  GroqModelGroup,
  SchemaTemplate,
} from '@/lib/schema-designer/types'

export const TABLE_COLORS = [
  '#6366f1',
  '#8b5cf6',
  '#ec4899',
  '#f59e0b',
  '#10b981',
  '#3b82f6',
  '#ef4444',
  '#14b8a6',
  '#f97316',
  '#84cc16',
  '#a855f7',
  '#06b6d4',
] as const

export const GROQ_MODELS: GroqModelGroup[] = [
  {
    group: 'Flagship (Recommended)',
    models: [
      {
        id: 'openai/gpt-oss-120b',
        label: 'GPT OSS 120B',
        badge: 'Default',
        description: 'Best for complex schemas with deep reasoning',
        contextWindow: '128K',
        speed: 'Fast',
      },
      {
        id: 'moonshotai/kimi-k2-instruct',
        label: 'Kimi K2 Instruct',
        badge: 'New',
        description: 'Excellent for multi-table relational design',
        contextWindow: '131K',
        speed: 'Fast',
      },
    ],
  },
  {
    group: 'High Performance',
    models: [
      {
        id: 'meta-llama/llama-4-maverick-17b-128e-instruct',
        label: 'Llama 4 Maverick 17B',
        description: 'Fast with strong schema understanding',
        contextWindow: '128K',
        speed: 'Very fast',
      },
      {
        id: 'meta-llama/llama-4-scout-17b-16e-instruct',
        label: 'Llama 4 Scout 17B',
        description: 'Efficient for smaller projects',
        contextWindow: '128K',
        speed: 'Very fast',
      },
      {
        id: 'deepseek-r1-distill-llama-70b',
        label: 'DeepSeek R1 70B',
        badge: 'Reasoning',
        description: 'Chain-of-thought for complex ERDs',
        contextWindow: '128K',
        speed: 'Fast',
      },
    ],
  },
  {
    group: 'Ultra Fast',
    models: [
      {
        id: 'llama-3.3-70b-versatile',
        label: 'Llama 3.3 70B Versatile',
        description: 'Balanced for broad schema generation',
        contextWindow: '128K',
        speed: 'Fast',
      },
      {
        id: 'llama-3.1-8b-instant',
        label: 'Llama 3.1 8B Instant',
        badge: 'Fastest',
        description: 'Best for quick drafts and refinements',
        contextWindow: '128K',
        speed: 'Fastest',
      },
      {
        id: 'gemma2-9b-it',
        label: 'Gemma 2 9B',
        description: 'Lightweight ideation for early exploration',
        contextWindow: '8K',
        speed: 'Fast',
      },
      {
        id: 'mistral-saba-24b',
        label: 'Mistral Saba 24B',
        description: 'Crisp structured output for compact schemas',
        contextWindow: '32K',
        speed: 'Fast',
      },
    ],
  },
  {
    group: 'Specialized',
    models: [
      {
        id: 'qwen-qwq-32b',
        label: 'Qwen QwQ 32B',
        badge: 'Reasoning',
        description: 'Deep relational reasoning',
        contextWindow: '131K',
        speed: 'Fast',
      },
      {
        id: 'compound-beta',
        label: 'Compound Beta',
        badge: 'Agentic',
        description: 'Multi-step schema planning with tool use',
        contextWindow: '128K',
        speed: 'Fast',
      },
    ],
  },
]

export const DEFAULT_GENERATION_OPTIONS: GenerationOptions = {
  temperature: 0.7,
  maxTokens: 8192,
  databaseType: 'postgresql',
  outputFormat: 'with-indexes',
  includeEnums: true,
  includeAuditColumns: true,
  includeIndexes: true,
  includeSampleData: false,
  normalizationLevel: '3NF',
  namingConvention: 'snake_case',
  reasoningEffort: 'medium',
}

export const SCHEMA_DESIGNER_SUGGESTIONS = [
  'Design a marketplace for vintage furniture with inventory, sellers, orders, and payouts.',
  'Create a SaaS analytics platform with organizations, dashboards, billing, and audit logs.',
  'Plan a social learning app with cohorts, lessons, quizzes, progress tracking, and messaging.',
  'Build a healthcare scheduling system with patients, practitioners, visits, and claims.',
]

export const CONTINUATION_SUGGESTIONS = [
  'Add authentication tables',
  'Add audit logging',
  'Optimize for read-heavy workload',
  'Add soft delete support',
]

export const SCHEMA_DESIGNER_FEATURES = [
  'Prompt-to-schema generation with live AI streaming and structured parsing.',
  'ReactFlow ERD canvas with custom table cards, relationship highlighting, and auto layout.',
  'Conversation-driven schema evolution with version snapshots and rollback-ready history.',
  'Project library grouped by recency with search, templates, and lightweight previews.',
  'Desktop-safe API key management through Tauri commands and keyring storage.',
  'Export-friendly toolbar designed for JSON, image, and future SQL artifact pipelines.',
]

const rawTemplates = (templatesJson.full_schema_templates ?? []) as Array<{
  id: string
  name: string
  description: string
  category: string
  tags?: string[]
}>

export const SCHEMA_TEMPLATES: SchemaTemplate[] = rawTemplates.slice(0, 8).map((template) => ({
  id: template.id,
  name: template.name,
  description: template.description,
  category: template.category,
  tags: template.tags ?? [],
  prompt: `Use the ${template.name} pattern as inspiration. ${template.description}`,
}))

export const DEFAULT_VIEWPORT = {
  x: 0,
  y: 0,
  zoom: 0.85,
}

export const PROJECT_DRAFT_SESSION_KEY = 'schema-designer:draft'
export const PROJECT_STORAGE_NAMESPACE = 'schema-designer:v2'
