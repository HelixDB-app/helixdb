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

export type AgentStage =
  | 'idle'
  | 'planning'
  | 'schema'
  | 'features'
  | 'docs'
  | 'saving'
  | 'done'
  | 'error'

export interface SchemaExtension {
  id: string
  name: string
  reason?: string | null
}

export interface SchemaCronJob {
  id: string
  name: string
  schedule: string
  command: string
  description?: string | null
}

export interface SchemaDocumentation {
  overview: string
  capacity_estimate?: string | null
  design_rationale?: string | null
  migration_notes?: string | null
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
  hex_color?: string | null
  description?: string | null
}

export interface SchemaSnapshot {
  id: string
  label: string
  timestamp: string
  tables: SchemaTable[]
  conversation_turn_id?: string | null
}

/** Persisted image turn (raw base64); matches Tauri `SchemaMessageAttachment`. */
export interface SchemaDesignerMessageAttachment {
  mime_type: string
  data_base64: string
}

export interface SchemaDesignerMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  created_at: string
  model?: string | null
  latency_ms?: number | null
  attachments?: SchemaDesignerMessageAttachment[]
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
  extensions?: SchemaExtension[]
  cron_jobs?: SchemaCronJob[]
  documentation?: SchemaDocumentation | null
  canvas_items?: CanvasItem[]
  created_at: string
  updated_at: string
  code?: string
  thumbnail_color?: string | null
  messages?: SchemaDesignerMessage[]
  ai_panel_markdown?: string | null
  last_model_id?: string | null
  last_generation_options_json?: string | null
  canvas_state_json?: string | null
}

export interface SchemaProjectSummary {
  id: string
  name: string
  description?: string
  app_type?: string
  created_at: string
  updated_at: string
  table_count: number
  thumbnail_color?: string | null
}
