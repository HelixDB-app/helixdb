import { create } from 'zustand'
import { DEFAULT_GENERATION_OPTIONS } from '@/lib/schema-designer/constants'
import {
  createEmptySchema,
  getDefaultModel,
} from '@/lib/schema-designer/project-utils'
import type {
  GenerationOptions,
  SchemaData,
  SchemaDesignerProject,
  SchemaError,
  SchemaRelationship,
  StreamSection,
  StreamStatus,
  TableSchema,
} from '@/lib/schema-designer/types'

interface SchemaDesignerStore {
  project: SchemaDesignerProject | null
  loading: boolean
  streamStatus: StreamStatus
  streamText: string
  reasoningText: string
  streamSections: StreamSection[]
  streamError: SchemaError | null
  selectedTableId: string | null
  selectedRelationshipId: string | null
  hoveredRelationshipId: string | null
  draftPrompt: string
  selectedModel: string
  options: GenerationOptions
  setProject: (project: SchemaDesignerProject | null) => void
  patchProject: (updater: (project: SchemaDesignerProject) => SchemaDesignerProject) => void
  setLoading: (loading: boolean) => void
  setStreamState: (payload: Partial<Pick<SchemaDesignerStore, 'streamStatus' | 'streamText' | 'reasoningText' | 'streamSections' | 'streamError'>>) => void
  resetStream: () => void
  setDraftPrompt: (prompt: string) => void
  setSelectedModel: (model: string) => void
  updateOptions: (updates: Partial<GenerationOptions>) => void
  setSelectedTableId: (tableId: string | null) => void
  setSelectedRelationshipId: (relationshipId: string | null) => void
  setHoveredRelationshipId: (relationshipId: string | null) => void
  replaceSchema: (schema: SchemaData) => void
  upsertTable: (table: TableSchema) => void
  deleteTable: (tableId: string) => void
  updateRelationship: (relationship: SchemaRelationship) => void
  replaceCanvasState: (next: SchemaDesignerProject['canvasState']) => void
  reset: () => void
}

const baseState = {
  project: null,
  loading: true,
  streamStatus: 'idle' as StreamStatus,
  streamText: '',
  reasoningText: '',
  streamSections: [] as StreamSection[],
  streamError: null,
  selectedTableId: null,
  selectedRelationshipId: null,
  hoveredRelationshipId: null,
  draftPrompt: '',
  selectedModel: getDefaultModel(),
  options: DEFAULT_GENERATION_OPTIONS,
}

export const useSchemaDesignerStore = create<SchemaDesignerStore>((set) => ({
  ...baseState,
  setProject: (project) =>
    set(() => ({
      project,
      selectedModel: project?.model ?? getDefaultModel(),
      draftPrompt: project?.prompt ?? '',
      loading: false,
    })),
  patchProject: (updater) =>
    set((state) => {
      if (!state.project) return state
      return {
        project: updater(state.project),
      }
    }),
  setLoading: (loading) => set(() => ({ loading })),
  setStreamState: (payload) => set(() => payload),
  resetStream: () =>
    set(() => ({
      streamStatus: 'idle',
      streamText: '',
      reasoningText: '',
      streamSections: [],
      streamError: null,
    })),
  setDraftPrompt: (draftPrompt) => set(() => ({ draftPrompt })),
  setSelectedModel: (selectedModel) => set(() => ({ selectedModel })),
  updateOptions: (updates) =>
    set((state) => ({
      options: {
        ...state.options,
        ...updates,
      },
    })),
  setSelectedTableId: (selectedTableId) => set(() => ({ selectedTableId })),
  setSelectedRelationshipId: (selectedRelationshipId) =>
    set(() => ({ selectedRelationshipId })),
  setHoveredRelationshipId: (hoveredRelationshipId) =>
    set(() => ({ hoveredRelationshipId })),
  replaceSchema: (schema) =>
    set((state) => {
      if (!state.project) return state
      return {
        project: {
          ...state.project,
          schema,
          thumbnailColor: schema.tables[0]?.color ?? state.project.thumbnailColor,
          updatedAt: new Date().toISOString(),
        },
      }
    }),
  upsertTable: (table) =>
    set((state) => {
      if (!state.project) return state
      const schema = state.project.schema ?? createEmptySchema()
      const nextTables = [
        ...schema.tables.filter((entry) => entry.id !== table.id),
        table,
      ]
      return {
        project: {
          ...state.project,
          schema: {
            ...schema,
            tables: nextTables,
            metadata: {
              ...schema.metadata,
              totalTables: nextTables.length,
            },
          },
          updatedAt: new Date().toISOString(),
        },
      }
    }),
  deleteTable: (tableId) =>
    set((state) => {
      if (!state.project?.schema) return state
      const nextSchema = {
        ...state.project.schema,
        tables: state.project.schema.tables.filter((table) => table.id !== tableId),
        relationships: state.project.schema.relationships.filter(
          (relationship) =>
            relationship.sourceTableId !== tableId && relationship.targetTableId !== tableId
        ),
      }
      nextSchema.metadata = {
        ...nextSchema.metadata,
        totalTables: nextSchema.tables.length,
        totalRelationships: nextSchema.relationships.length,
      }
      return {
        project: {
          ...state.project,
          schema: nextSchema,
          updatedAt: new Date().toISOString(),
        },
        selectedTableId: state.selectedTableId === tableId ? null : state.selectedTableId,
      }
    }),
  updateRelationship: (relationship) =>
    set((state) => {
      if (!state.project?.schema) return state
      const nextRelationships = [
        ...state.project.schema.relationships.filter((entry) => entry.id !== relationship.id),
        relationship,
      ]
      return {
        project: {
          ...state.project,
          schema: {
            ...state.project.schema,
            relationships: nextRelationships,
            metadata: {
              ...state.project.schema.metadata,
              totalRelationships: nextRelationships.length,
            },
          },
          updatedAt: new Date().toISOString(),
        },
      }
    }),
  replaceCanvasState: (nextCanvasState) =>
    set((state) => {
      if (!state.project) return state
      return {
        project: {
          ...state.project,
          canvasState: nextCanvasState,
          updatedAt: new Date().toISOString(),
        },
      }
    }),
  reset: () =>
    set(() => ({
      ...baseState,
      loading: false,
      project: null,
    })),
}))
