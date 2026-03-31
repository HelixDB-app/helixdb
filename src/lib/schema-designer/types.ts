import type { Edge, Node } from 'reactflow'

export type SupportedDatabaseType =
  | 'postgresql'
  | 'mysql'
  | 'mongodb'
  | 'sqlite'
  | 'multi'

export type OutputFormat =
  | 'detailed'
  | 'minimal'
  | 'with-indexes'
  | 'with-sample-data'

export type NormalizationLevel = '1NF' | '2NF' | '3NF' | 'BCNF' | 'denormalized'
export type NamingConvention = 'snake_case' | 'camelCase' | 'PascalCase'
export type ReasoningEffort = 'low' | 'medium' | 'high'
export type RelationshipKind = '1:1' | '1:N' | 'N:M'
export type StreamChunkType = 'token' | 'reasoning'
export type StreamStatus = 'idle' | 'streaming' | 'done' | 'error'

export interface GenerationOptions {
  temperature: number
  maxTokens: number
  databaseType: SupportedDatabaseType
  outputFormat: OutputFormat
  includeEnums: boolean
  includeAuditColumns: boolean
  includeIndexes: boolean
  includeSampleData: boolean
  normalizationLevel: NormalizationLevel
  namingConvention: NamingConvention
  reasoningEffort: ReasoningEffort
  apiKeyId?: string | null
}

export interface GroqModelOption {
  id: string
  label: string
  badge?: string | null
  description?: string
  contextWindow?: string
  speed?: string
}

export interface GroqModelGroup {
  group: string
  models: GroqModelOption[]
}

export interface StreamChunk {
  type: StreamChunkType
  content: string
}

export interface ForeignKeyReference {
  table: string
  column: string
  onDelete?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION'
  onUpdate?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION'
}

export interface SchemaColumn {
  id: string
  name: string
  type: string
  nullable: boolean
  primaryKey: boolean
  unique: boolean
  indexed?: boolean
  default: string | null
  references: ForeignKeyReference | null
  description: string
}

export interface SchemaIndex {
  id: string
  name: string
  columns: string[]
  unique: boolean
  type: 'BTREE' | 'GIN' | 'GIST' | 'HASH'
}

export interface NodePosition {
  x: number
  y: number
}

export interface TableSchema {
  id: string
  name: string
  description: string
  columns: SchemaColumn[]
  indexes: SchemaIndex[]
  color: string
  position?: NodePosition | null
}

export interface EnumDefinition {
  id: string
  name: string
  values: string[]
}

export interface SchemaRelationship {
  id: string
  sourceTableId: string
  sourceColumnId: string
  targetTableId: string
  targetColumnId: string
  kind: RelationshipKind
  color: string
  label: string
}

export interface SchemaMetadata {
  databaseType: string
  version: string
  description: string
  totalTables: number
  totalRelationships: number
  generatedByModel?: string
  generationTimeMs?: number
}

export interface SchemaData {
  tables: TableSchema[]
  enums: EnumDefinition[]
  relationships: SchemaRelationship[]
  metadata: SchemaMetadata
}

export interface StreamSection {
  id: string
  title: string
  content: string
}

export interface ConversationMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: string
  tokenCount?: number | null
  model?: string | null
  schemaSnapshot?: string | null
}

export interface CanvasViewport {
  x: number
  y: number
  zoom: number
}

export interface CanvasState {
  viewport: CanvasViewport
  nodePositions: Record<string, NodePosition>
  layoutDirection: 'LR' | 'TB'
  selectedNodes: string[]
}

export interface SchemaVersionSnapshot {
  id: string
  label: string
  createdAt: string
  schema: SchemaData
}

export interface SchemaDesignerProject {
  id: string
  userId: string
  name: string
  description: string
  thumbnailColor: string
  model: string
  prompt: string
  schema: SchemaData | null
  canvasState: CanvasState
  conversation: ConversationMessage[]
  versions: SchemaVersionSnapshot[]
  createdAt: string
  updatedAt: string
}

export interface SchemaProjectSummary {
  id: string
  name: string
  description: string
  thumbnailColor: string
  updatedAt: string
  createdAt: string
  totalTables: number
  totalRelationships: number
  model: string
}

export interface SchemaTemplate {
  id: string
  name: string
  description: string
  category: string
  tags: string[]
  prompt: string
}

export interface ApiKeyRecord {
  id: string
  label: string
  maskedValue: string
  isDefault: boolean
  createdAt: string
  lastValidatedAt?: string | null
}

export type SchemaError =
  | { type: 'API_KEY_INVALID'; message: string }
  | { type: 'MODEL_NOT_FOUND'; message: string }
  | { type: 'RATE_LIMITED'; retryAfter: number }
  | { type: 'CONTEXT_TOO_LONG'; message: string }
  | { type: 'PARSE_ERROR'; rawResponse: string }
  | { type: 'MONGO_ERROR'; message: string }
  | { type: 'NETWORK_ERROR'; message: string }

export interface SchemaDesignerDraft {
  prompt: string
  model: string
  options: GenerationOptions
}

export interface RelationshipEdgeData {
  kind: RelationshipKind
  color: string
  label: string
  isActive?: boolean
}

export interface TableNodeData {
  table: TableSchema
  highlightedColumnIds: string[]
  isSelected: boolean
  onEdit: (table: TableSchema) => void
  onSelect: (tableId: string) => void
}

export interface LayoutResult {
  nodes: Node[]
  edges: Edge[]
}
