export interface ForeignKeyRef {
  target_table_id: string
  target_column_id: string
  on_delete?: string | null
  on_update?: string | null
}

export interface SchemaColumn {
  id: string
  name: string
  data_type: string
  nullable?: boolean
  default_value?: string | null
  is_primary_key?: boolean
  is_unique?: boolean
  foreign_key?: ForeignKeyRef | null
}

export interface SchemaIndex {
  id: string
  name: string
  columns: string[]
  unique?: boolean
  method?: string
}

export interface SchemaFunction {
  id: string
  name: string
  language?: string
  returns?: string
  definition?: string
  x?: number
  y?: number
}

export interface SchemaTrigger {
  id: string
  name: string
  table_id: string
  function_name: string
  timing?: string
  events?: string[]
  x?: number
  y?: number
}

export interface CanvasItem {
  id: string
  kind: 'note' | 'image' | 'cron'
  x: number
  y: number
  text?: string
  image_url?: string
  schedule?: string
  task?: string
}

export interface TablePosition {
  x: number
  y: number
}

export interface SchemaTable {
  id: string
  name: string
  columns: SchemaColumn[]
  indexes?: SchemaIndex[]
  position?: TablePosition | null
}

export interface SchemaSnapshot {
  id: string
  label: string
  timestamp: string
  tables: SchemaTable[]
}

export interface SchemaProject {
  id: string
  name: string
  app_type?: string
  description?: string
  tables: SchemaTable[]
  version_history?: SchemaSnapshot[]
  functions?: SchemaFunction[]
  triggers?: SchemaTrigger[]
  canvas_items?: CanvasItem[]
  created_at: string
  updated_at: string
  code?: string
}

export interface SchemaProjectSummary {
  id: string
  name: string
  description?: string
  app_type?: string
  created_at: string
  updated_at: string
  table_count: number
}

export type SchemaNodeCategory = 'core' | 'junction' | 'audit' | 'config' | 'view'
export type SchemaCardinality = '1:1' | '1:N' | 'N:M'
export type SchemaOnDelete = 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION'
export type MilestoneKey =
  | 'meta'
  | 'tables'
  | 'indexes'
  | 'graph'
  | 'nodes'
  | 'docs'
  | 'first_table'
  | 'done'

export interface OpenRouterModel {
  id: string
  label: string
  contextK: number
  free: boolean
  latencyTier: 'fast' | 'balanced' | 'slow'
}

export interface SchemaGraphColumn {
  name: string
  type: string
  constraints: string[]
  indexed: boolean
}

export interface SchemaGraphNode {
  id: string
  type: 'tableNode'
  position: { x: number; y: number }
  data: {
    label: string
    category: SchemaNodeCategory
    columns: SchemaGraphColumn[]
    rowEstimate: string
  }
}

export interface SchemaGraphEdge {
  id: string
  source: string
  target: string
  sourceHandle: string
  targetHandle: string
  label: string
  data: {
    cardinality: SchemaCardinality
    onDelete: SchemaOnDelete
  }
}

export interface AISchemaResult {
  schema_meta: Record<string, unknown>
  sql_blocks: Record<string, string>
  react_flow_graph: {
    nodes: SchemaGraphNode[]
    edges: SchemaGraphEdge[]
  }
  schema_doc?: string
}

export interface AISchemaProject {
  id: string
  name: string
  description?: string
  prompt: string
  update_prompt?: string
  model?: string
  created_at: string
  updated_at: string
  schema: AISchemaResult
}

export interface AISchemaProjectSummary {
  id: string
  name: string
  description?: string
  updated_at: string
  table_count: number
}
