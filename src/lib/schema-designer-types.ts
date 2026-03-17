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
