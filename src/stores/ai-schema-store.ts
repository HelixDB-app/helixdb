import { create } from 'zustand'
import type { QualityMode } from '@/lib/ai-schema-prompts'
import { OPENROUTER_FREE_MODELS } from '@/lib/ai-schema-engine'
import type { AISchemaResult, MilestoneKey } from '@/lib/schema-designer-types'

export type AISchemaPhase =
  | 'idle'
  | 'analyzing'
  | 'streaming'
  | 'recovering'
  | 'done'
  | 'error'

export interface CompressedContext {
  established_entities: string[]
  confirmed_decisions: string[]
  pending_questions: string[]
  last_schema_hash: string
  turn_count: number
}

export interface AISchemaStoreState {
  phase: AISchemaPhase
  milestones: Record<MilestoneKey, boolean>
  activeModel: string
  selectedModel: string
  modelAttempts: number
  qualityMode: QualityMode
  skipDocs: boolean
  updateIntent: string
  streamBuffer: string
  schemaResult: AISchemaResult | null
  error: string | null
  conversationHistory: CompressedContext | null
  abortController: AbortController | null
  startGeneration: (model: string) => AbortController
  updateBuffer: (chunk: string) => void
  setMilestone: (key: MilestoneKey) => void
  setPhase: (phase: AISchemaPhase) => void
  setResult: (result: AISchemaResult) => void
  setError: (error: string | null) => void
  setQualityMode: (mode: QualityMode) => void
  setSkipDocs: (skip: boolean) => void
  setUpdateIntent: (intent: string) => void
  setSelectedModel: (model: string) => void
  setConversationHistory: (ctx: CompressedContext | null) => void
  rotateModel: (fallbackChain: string[]) => string | null
  abort: () => void
  reset: () => void
}

const DEFAULT_MILESTONES: Record<MilestoneKey, boolean> = {
  meta: false,
  tables: false,
  indexes: false,
  graph: false,
  nodes: false,
  docs: false,
  first_table: false,
  done: false,
}

export const useAISchemaStore = create<AISchemaStoreState>((set, get) => ({
  phase: 'idle',
  milestones: { ...DEFAULT_MILESTONES },
  activeModel: OPENROUTER_FREE_MODELS[0]?.id ?? 'arcee-ai/trinity-mini:free',
  selectedModel: OPENROUTER_FREE_MODELS[0]?.id ?? 'arcee-ai/trinity-mini:free',
  modelAttempts: 0,
  qualityMode: 'full',
  skipDocs: false,
  updateIntent: '',
  streamBuffer: '',
  schemaResult: null,
  error: null,
  conversationHistory: null,
  abortController: null,
  startGeneration: (model) => {
    get().abortController?.abort()
    const abortController = new AbortController()
    set({
      phase: 'analyzing',
      milestones: { ...DEFAULT_MILESTONES },
      activeModel: model,
      modelAttempts: 1,
      streamBuffer: '',
      schemaResult: null,
      error: null,
      abortController,
    })
    return abortController
  },
  updateBuffer: (chunk) =>
    set((state) => ({
      streamBuffer: state.streamBuffer + chunk,
    })),
  setMilestone: (key) =>
    set((state) => ({
      milestones: { ...state.milestones, [key]: true },
    })),
  setPhase: (phase) => set({ phase }),
  setResult: (result) => set({ schemaResult: result, phase: 'done' }),
  setError: (error) => set({ error, phase: error ? 'error' : get().phase }),
  setQualityMode: (qualityMode) => set({ qualityMode }),
  setSkipDocs: (skipDocs) => set({ skipDocs }),
  setUpdateIntent: (updateIntent) => set({ updateIntent }),
  setSelectedModel: (selectedModel) => set({ selectedModel }),
  setConversationHistory: (conversationHistory) => set({ conversationHistory }),
  rotateModel: (fallbackChain) => {
    const { activeModel, modelAttempts } = get()
    const idx = fallbackChain.indexOf(activeModel)
    const next = idx >= 0 ? fallbackChain[idx + 1] : fallbackChain[0]
    if (!next) return null
    set({
      activeModel: next,
      modelAttempts: modelAttempts + 1,
    })
    return next
  },
  abort: () => {
    const controller = get().abortController
    if (controller) controller.abort()
    set({ abortController: null, phase: 'idle' })
  },
  reset: () => {
    const controller = get().abortController
    if (controller) controller.abort()
    set({
      phase: 'idle',
      milestones: { ...DEFAULT_MILESTONES },
      modelAttempts: 0,
      updateIntent: '',
      streamBuffer: '',
      schemaResult: null,
      error: null,
      abortController: null,
    })
  },
}))
