import { create } from 'zustand'

export interface Column {
  id: string
  name: string
  type:
    | 'string'
    | 'integer'
    | 'numeric'
    | 'boolean'
    | 'text'
    | 'timestamp'
    | 'uuid'
    | 'json'
  nullable: boolean
  isPrimaryKey: boolean
  isUnique: boolean
  default?: string
}

export interface SchemaIndex {
  id: string
  name: string
  columns: string[]
  unique: boolean
  method?: string
}

export interface Table {
  id: string
  name: string
  columns: Column[]
  indexes?: SchemaIndex[]
  x: number
  y: number
}

export interface Relationship {
  id: string
  sourceTableId: string
  sourceColumnId: string
  targetTableId: string
  targetColumnId: string
  type: 'one-to-one' | 'one-to-many' | 'many-to-many'
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
  tableId: string
  functionName: string
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
  imageUrl?: string
  schedule?: string
  task?: string
}

export interface SchemaState {
  projectId: string | null
  projectName: string
  projectDescription: string
  projectAppType: string
  projectCreatedAt: string | null
  projectUpdatedAt: string | null
  tables: Table[]
  relationships: Relationship[]
  functions: SchemaFunction[]
  triggers: SchemaTrigger[]
  canvasItems: CanvasItem[]
  selectedTableId: string | null
  selectedRelationshipId: string | null
  code: string
  
  // Table operations
  addTable: (table: Table) => void
  updateTable: (id: string, table: Partial<Table>) => void
  deleteTable: (id: string) => void
  
  // Column operations
  addColumn: (tableId: string, column: Column) => void
  updateColumn: (tableId: string, columnId: string, column: Partial<Column>) => void
  deleteColumn: (tableId: string, columnId: string) => void

  // Index operations
  addIndex: (tableId: string, index: SchemaIndex) => void
  updateIndex: (tableId: string, indexId: string, updates: Partial<SchemaIndex>) => void
  deleteIndex: (tableId: string, indexId: string) => void
  
  // Relationship operations
  addRelationship: (relationship: Relationship) => void
  updateRelationship: (id: string, updates: Partial<Relationship>) => void
  deleteRelationship: (id: string) => void

  // Function/Trigger operations
  setFunctions: (functions: SchemaFunction[]) => void
  addFunction: (fn: SchemaFunction) => void
  updateFunction: (id: string, updates: Partial<SchemaFunction>) => void
  deleteFunction: (id: string) => void
  setTriggers: (triggers: SchemaTrigger[]) => void
  addTrigger: (trigger: SchemaTrigger) => void
  updateTrigger: (id: string, updates: Partial<SchemaTrigger>) => void
  deleteTrigger: (id: string) => void

  // Canvas items (notes, images)
  addCanvasItem: (item: CanvasItem) => void
  updateCanvasItem: (id: string, updates: Partial<CanvasItem>) => void
  deleteCanvasItem: (id: string) => void
  
  // Bulk updates (useful for project hydration)
  setTables: (tables: Table[]) => void
  setRelationships: (relationships: Relationship[]) => void
  setCanvasItems: (items: CanvasItem[]) => void
  
  // Selection
  setSelectedTableId: (id: string | null) => void
  setSelectedRelationshipId: (id: string | null) => void
  
  // Code sync
  setCode: (code: string) => void

  // Project metadata
  setProjectMeta: (meta: Partial<Pick<SchemaState, 'projectId' | 'projectName' | 'projectDescription' | 'projectAppType' | 'projectCreatedAt' | 'projectUpdatedAt'>>) => void

  // Hydrate full project state
  hydrateProject: (payload: Pick<SchemaState, 'projectId' | 'projectName' | 'projectDescription' | 'projectAppType' | 'projectCreatedAt' | 'projectUpdatedAt' | 'tables' | 'relationships' | 'functions' | 'triggers' | 'canvasItems' | 'code'>) => void
  
  // Reset
  reset: () => void
}

export const DEFAULT_SCHEMA_STATE = {
  tables: [
    {
      id: 'table-1',
      name: 'users',
      x: 100,
      y: 100,
      indexes: [],
      columns: [
        {
          id: 'col-1',
          name: 'id',
          type: 'uuid' as const,
          nullable: false,
          isPrimaryKey: true,
          isUnique: true,
        },
        {
          id: 'col-2',
          name: 'email',
          type: 'string' as const,
          nullable: false,
          isPrimaryKey: false,
          isUnique: true,
        },
        {
          id: 'col-3',
          name: 'created_at',
          type: 'timestamp' as const,
          nullable: false,
          isPrimaryKey: false,
          isUnique: false,
        },
      ],
    },
    {
      id: 'table-2',
      name: 'posts',
      x: 500,
      y: 100,
      indexes: [],
      columns: [
        {
          id: 'col-4',
          name: 'id',
          type: 'uuid' as const,
          nullable: false,
          isPrimaryKey: true,
          isUnique: true,
        },
        {
          id: 'col-5',
          name: 'user_id',
          type: 'uuid' as const,
          nullable: false,
          isPrimaryKey: false,
          isUnique: false,
        },
        {
          id: 'col-6',
          name: 'title',
          type: 'string' as const,
          nullable: false,
          isPrimaryKey: false,
          isUnique: false,
        },
        {
          id: 'col-7',
          name: 'content',
          type: 'text' as const,
          nullable: true,
          isPrimaryKey: false,
          isUnique: false,
        },
        {
          id: 'col-8',
          name: 'created_at',
          type: 'timestamp' as const,
          nullable: false,
          isPrimaryKey: false,
          isUnique: false,
        },
      ],
    },
  ],
  relationships: [
    {
      id: 'rel-1',
      sourceTableId: 'table-1',
      sourceColumnId: 'col-1',
      targetTableId: 'table-2',
      targetColumnId: 'col-5',
      type: 'one-to-many' as const,
    },
  ],
  selectedTableId: null,
  selectedRelationshipId: null,
  code: '',
  functions: [],
  triggers: [],
  canvasItems: [],
}

function cloneDefaultState() {
  try {
    return structuredClone(DEFAULT_SCHEMA_STATE)
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_SCHEMA_STATE)) as typeof DEFAULT_SCHEMA_STATE
  }
}

const initialState = {
  projectId: null,
  projectName: 'Untitled Project',
  projectDescription: '',
  projectAppType: 'database',
  projectCreatedAt: null,
  projectUpdatedAt: null,
  ...cloneDefaultState(),
}

export const useSchemaStore = create<SchemaState>((set) => ({
  ...initialState,

  addTable: (table) =>
    set((state) => ({
      tables: [...state.tables, { ...table, indexes: table.indexes ?? [] }],
    })),

  updateTable: (id, updates) =>
    set((state) => ({
      tables: state.tables.map((table) =>
        table.id === id ? { ...table, ...updates } : table
      ),
    })),

  deleteTable: (id) =>
    set((state) => ({
      tables: state.tables.filter((table) => table.id !== id),
      relationships: state.relationships.filter(
        (rel) => rel.sourceTableId !== id && rel.targetTableId !== id
      ),
      triggers: state.triggers.filter((trg) => trg.tableId !== id),
    })),

  addColumn: (tableId, column) =>
    set((state) => ({
      tables: state.tables.map((table) =>
        table.id === tableId
          ? { ...table, columns: [...table.columns, column] }
          : table
      ),
    })),

  updateColumn: (tableId, columnId, updates) =>
    set((state) => ({
      tables: state.tables.map((table) =>
        table.id === tableId
          ? {
              ...table,
              columns: table.columns.map((col) =>
                col.id === columnId ? { ...col, ...updates } : col
              ),
              indexes: (() => {
                const existing = table.columns.find((col) => col.id === columnId)
                if (!existing || !updates.name || updates.name === existing.name) {
                  return table.indexes
                }
                return (table.indexes ?? []).map((idx) => ({
                  ...idx,
                  columns: idx.columns.map((colName) =>
                    colName === existing.name ? updates.name! : colName
                  ),
                }))
              })(),
            }
          : table
      ),
    })),

  deleteColumn: (tableId, columnId) =>
    set((state) => ({
      tables: state.tables.map((table) =>
        table.id === tableId
          ? {
              ...table,
              columns: table.columns.filter((col) => col.id !== columnId),
              indexes: (() => {
                const removed = table.columns.find((col) => col.id === columnId)
                if (!removed) return table.indexes
                return (table.indexes ?? []).filter(
                  (idx) => !idx.columns.includes(removed.name)
                )
              })(),
            }
          : table
      ),
      relationships: state.relationships.filter(
        (rel) =>
          !(
            (rel.sourceTableId === tableId && rel.sourceColumnId === columnId) ||
            (rel.targetTableId === tableId && rel.targetColumnId === columnId)
          )
      ),
    })),

  addIndex: (tableId, index) =>
    set((state) => ({
      tables: state.tables.map((table) =>
        table.id === tableId
          ? {
              ...table,
              indexes: [...(table.indexes ?? []), index],
            }
          : table
      ),
    })),

  updateIndex: (tableId, indexId, updates) =>
    set((state) => ({
      tables: state.tables.map((table) =>
        table.id === tableId
          ? {
              ...table,
              indexes: (table.indexes ?? []).map((idx) =>
                idx.id === indexId ? { ...idx, ...updates } : idx
              ),
            }
          : table
      ),
    })),

  deleteIndex: (tableId, indexId) =>
    set((state) => ({
      tables: state.tables.map((table) =>
        table.id === tableId
          ? {
              ...table,
              indexes: (table.indexes ?? []).filter((idx) => idx.id !== indexId),
            }
          : table
      ),
    })),

  addRelationship: (relationship) =>
    set((state) => ({
      relationships: [...state.relationships, relationship],
    })),

  updateRelationship: (id, updates) =>
    set((state) => ({
      relationships: state.relationships.map((rel) =>
        rel.id === id ? { ...rel, ...updates } : rel
      ),
    })),

  deleteRelationship: (id) =>
    set((state) => ({
      relationships: state.relationships.filter((rel) => rel.id !== id),
    })),

  setFunctions: (functions) =>
    set({
      functions,
    }),

  addFunction: (fn) =>
    set((state) => ({
      functions: [...state.functions, fn],
    })),

  updateFunction: (id, updates) =>
    set((state) => ({
      functions: state.functions.map((fn) =>
        fn.id === id ? { ...fn, ...updates } : fn
      ),
    })),

  deleteFunction: (id) =>
    set((state) => ({
      functions: state.functions.filter((fn) => fn.id !== id),
    })),

  setTriggers: (triggers) =>
    set({
      triggers,
    }),

  addTrigger: (trigger) =>
    set((state) => ({
      triggers: [...state.triggers, trigger],
    })),

  updateTrigger: (id, updates) =>
    set((state) => ({
      triggers: state.triggers.map((trg) =>
        trg.id === id ? { ...trg, ...updates } : trg
      ),
    })),

  deleteTrigger: (id) =>
    set((state) => ({
      triggers: state.triggers.filter((trg) => trg.id !== id),
    })),

  addCanvasItem: (item) =>
    set((state) => ({
      canvasItems: [...state.canvasItems, item],
    })),

  updateCanvasItem: (id, updates) =>
    set((state) => ({
      canvasItems: state.canvasItems.map((item) =>
        item.id === id ? { ...item, ...updates } : item
      ),
    })),

  deleteCanvasItem: (id) =>
    set((state) => ({
      canvasItems: state.canvasItems.filter((item) => item.id !== id),
    })),

  setTables: (tables) =>
    set({
      tables,
    }),

  setRelationships: (relationships) =>
    set({
      relationships,
    }),

  setCanvasItems: (items) =>
    set({
      canvasItems: items,
    }),

  setSelectedTableId: (id) =>
    set({
      selectedTableId: id,
    }),

  setSelectedRelationshipId: (id) =>
    set({
      selectedRelationshipId: id,
    }),

  setCode: (code) =>
    set({
      code,
    }),

  setProjectMeta: (meta) =>
    set((state) => ({
      ...state,
      ...meta,
    })),

  hydrateProject: (payload) =>
    set({
      ...payload,
      selectedTableId: null,
      selectedRelationshipId: null,
    }),

  reset: () =>
    set(initialState),
}))
