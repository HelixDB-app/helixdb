import { v4 as uuidv4 } from 'uuid'
import {
  DEFAULT_GENERATION_OPTIONS,
  DEFAULT_VIEWPORT,
  GROQ_MODELS,
  TABLE_COLORS,
} from '@/lib/schema-designer/constants'
import type {
  CanvasState,
  ConversationMessage,
  GenerationOptions,
  SchemaData,
  SchemaDesignerDraft,
  SchemaDesignerProject,
  SchemaProjectSummary,
  SchemaVersionSnapshot,
  StreamSection,
  TableSchema,
} from '@/lib/schema-designer/types'

export function getDefaultModel(): string {
  return GROQ_MODELS[0]?.models[0]?.id ?? 'openai/gpt-oss-120b'
}

export function createEmptySchema(): SchemaData {
  return {
    tables: [],
    enums: [],
    relationships: [],
    metadata: {
      databaseType: DEFAULT_GENERATION_OPTIONS.databaseType,
      version: '1.0',
      description: 'Schema not generated yet.',
      totalTables: 0,
      totalRelationships: 0,
      generatedByModel: getDefaultModel(),
      generationTimeMs: 0,
    },
  }
}

export function createDefaultCanvasState(): CanvasState {
  return {
    viewport: DEFAULT_VIEWPORT,
    nodePositions: {},
    layoutDirection: 'LR',
    selectedNodes: [],
  }
}

export function createProjectSummary(
  project: SchemaDesignerProject
): SchemaProjectSummary {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    thumbnailColor: project.thumbnailColor,
    updatedAt: project.updatedAt,
    createdAt: project.createdAt,
    totalTables: project.schema?.tables.length ?? 0,
    totalRelationships: project.schema?.relationships.length ?? 0,
    model: project.model,
  }
}

export function createConversationMessage(
  role: ConversationMessage['role'],
  content: string,
  extras?: Partial<ConversationMessage>
): ConversationMessage {
  return {
    id: uuidv4(),
    role,
    content,
    timestamp: new Date().toISOString(),
    tokenCount: extras?.tokenCount ?? null,
    model: extras?.model ?? null,
    schemaSnapshot: extras?.schemaSnapshot ?? null,
  }
}

export function createVersionSnapshot(
  schema: SchemaData,
  label?: string
): SchemaVersionSnapshot {
  return {
    id: uuidv4(),
    label: label?.trim() || `Version ${new Date().toLocaleString()}`,
    createdAt: new Date().toISOString(),
    schema: JSON.parse(JSON.stringify(schema)) as SchemaData,
  }
}

export function createSchemaDesignerProject(
  draft?: Partial<SchemaDesignerDraft> & {
    id?: string
    name?: string
    description?: string
    userId?: string
  }
): SchemaDesignerProject {
  const now = new Date().toISOString()
  return {
    id: draft?.id ?? uuidv4(),
    userId: draft?.userId ?? 'local-user',
    name: draft?.name?.trim() || 'Untitled schema project',
    description: draft?.description?.trim() || 'AI-assisted schema design workspace',
    thumbnailColor: TABLE_COLORS[0],
    model: draft?.model ?? getDefaultModel(),
    prompt: draft?.prompt ?? '',
    schema: null,
    canvasState: createDefaultCanvasState(),
    conversation: [],
    versions: [],
    createdAt: now,
    updatedAt: now,
  }
}

export function getProjectThumbnailColor(tables: TableSchema[]): string {
  return tables[0]?.color ?? TABLE_COLORS[0]
}

export function updateProjectTimestamp<T extends { updatedAt: string }>(
  project: T
): T {
  return {
    ...project,
    updatedAt: new Date().toISOString(),
  }
}

export function serializeSchema(schema: SchemaData | null): string | null {
  if (!schema) return null
  return JSON.stringify(schema)
}

export function getInitialDraft(): SchemaDesignerDraft {
  return {
    prompt: '',
    model: getDefaultModel(),
    options: DEFAULT_GENERATION_OPTIONS,
  }
}

export function groupSectionsFromMarkdown(markdown: string): StreamSection[] {
  const clean = markdown.trim()
  if (!clean) return []

  const segments = clean.split(/\n(?=##\s+)/g)
  return segments
    .map((segment, index) => {
      const match = segment.match(/^##\s+(.+)$/m)
      if (!match) {
        return {
          id: `section-live-${index}`,
          title: 'Live stream',
          content: segment.trim(),
        }
      }
      const title = match[1].trim()
      return {
        id: `section-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${index}`,
        title,
        content: segment.replace(match[0], '').trim(),
      }
    })
    .filter((section) => section.content.length > 0)
}

export function withUpdatedSchema(
  project: SchemaDesignerProject,
  schema: SchemaData,
  options?: {
    prompt?: string
    model?: string
    createVersion?: boolean
    versionLabel?: string
  }
): SchemaDesignerProject {
  const next: SchemaDesignerProject = {
    ...project,
    prompt: options?.prompt ?? project.prompt,
    model: options?.model ?? project.model,
    schema,
    thumbnailColor: getProjectThumbnailColor(schema.tables),
    updatedAt: new Date().toISOString(),
  }

  if (options?.createVersion !== false) {
    next.versions = [
      ...project.versions,
      createVersionSnapshot(schema, options?.versionLabel),
    ]
  }

  return next
}

export function mergeOptions(
  current: GenerationOptions,
  updates: Partial<GenerationOptions>
): GenerationOptions {
  return {
    ...current,
    ...updates,
  }
}
