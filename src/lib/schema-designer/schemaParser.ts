import { v4 as uuidv4 } from 'uuid'
import { TABLE_COLORS } from '@/lib/schema-designer/constants'
import type {
  EnumDefinition,
  ForeignKeyReference,
  SchemaColumn,
  SchemaData,
  SchemaError,
  SchemaIndex,
  SchemaRelationship,
  TableSchema,
} from '@/lib/schema-designer/types'

function tryParseJsonBlock(raw: string): unknown {
  const fenced = raw.match(/```json\s*([\s\S]*?)```/i)
  if (fenced?.[1]) {
    return JSON.parse(fenced[1])
  }

  const genericFence = raw.match(/```\s*([\s\S]*?)```/i)
  if (genericFence?.[1]) {
    return JSON.parse(genericFence[1])
  }

  const firstBrace = raw.indexOf('{')
  const lastBrace = raw.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return JSON.parse(raw.slice(firstBrace, lastBrace + 1))
  }

  throw new Error('No JSON block found in response')
}

function narrativeFromRaw(raw: string): string {
  const fenced = raw.match(/```json\s*[\s\S]*?```([\s\S]*)$/i)
  return fenced?.[1]?.trim() ?? ''
}

function buildColumn(raw: Partial<SchemaColumn>, index: number): SchemaColumn {
  return {
    id: raw.id ?? uuidv4(),
    name: raw.name?.trim() || `column_${index + 1}`,
    type: raw.type?.trim() || 'text',
    nullable: raw.nullable ?? false,
    primaryKey: raw.primaryKey ?? false,
    unique: raw.unique ?? false,
    indexed: raw.indexed ?? false,
    default: raw.default ?? null,
    references: (raw.references ?? null) as ForeignKeyReference | null,
    description: raw.description?.trim() || '',
  }
}

function buildIndex(raw: Partial<SchemaIndex>, index: number): SchemaIndex {
  return {
    id: raw.id ?? uuidv4(),
    name: raw.name?.trim() || `idx_${index + 1}`,
    columns: raw.columns ?? [],
    unique: raw.unique ?? false,
    type: raw.type ?? 'BTREE',
  }
}

function buildTable(raw: Partial<TableSchema>, index: number): TableSchema {
  return {
    id: raw.id ?? uuidv4(),
    name: raw.name?.trim() || `table_${index + 1}`,
    description: raw.description?.trim() || '',
    columns: (raw.columns ?? []).map(buildColumn),
    indexes: (raw.indexes ?? []).map(buildIndex),
    color: raw.color ?? TABLE_COLORS[index % TABLE_COLORS.length],
    position: raw.position ?? null,
  }
}

function buildEnum(raw: Partial<EnumDefinition>): EnumDefinition {
  return {
    id: raw.id ?? uuidv4(),
    name: raw.name?.trim() || 'enum_value',
    values: raw.values ?? [],
  }
}

function relationshipKind(source: SchemaColumn, target: SchemaColumn): SchemaRelationship['kind'] {
  if (source.unique && target.unique) return '1:1'
  if (source.unique || target.primaryKey || target.unique) return '1:N'
  return '1:N'
}

export function deriveSchemaRelationships(tables: TableSchema[]): SchemaRelationship[] {
  const tableByName = new Map(tables.map((table) => [table.name.toLowerCase(), table]))
  const relationships: SchemaRelationship[] = []

  for (const table of tables) {
    for (const column of table.columns) {
      if (!column.references) continue
      const targetTable = tableByName.get(column.references.table.toLowerCase())
      if (!targetTable) continue
      const targetColumn =
        targetTable.columns.find(
          (candidate) =>
            candidate.name.toLowerCase() === column.references?.column.toLowerCase()
        ) ?? targetTable.columns[0]

      if (!targetColumn) continue

      relationships.push({
        id: uuidv4(),
        sourceTableId: table.id,
        sourceColumnId: column.id,
        targetTableId: targetTable.id,
        targetColumnId: targetColumn.id,
        kind: relationshipKind(column, targetColumn),
        color: table.color,
        label: `${table.name}.${column.name} -> ${targetTable.name}.${targetColumn.name}`,
      })
    }
  }

  return relationships
}

export function countSchemaRelationships(tables: TableSchema[]): number {
  return tables.reduce(
    (total, table) =>
      total + table.columns.filter((column) => Boolean(column.references)).length,
    0
  )
}

export function syncSchemaRelationships(schema: SchemaData): SchemaData {
  const relationships = deriveSchemaRelationships(schema.tables)
  return {
    ...schema,
    relationships,
    metadata: {
      ...schema.metadata,
      totalTables: schema.tables.length,
      totalRelationships: relationships.length,
    },
  }
}

export function parseSchemaResponse(raw: string): {
  schema: SchemaData
  narrative: string
} {
  const parsed = tryParseJsonBlock(raw) as {
    schema?: Partial<SchemaData>
  }

  const schemaInput = parsed?.schema
  if (!schemaInput) {
    throw { type: 'PARSE_ERROR', rawResponse: raw } satisfies SchemaError
  }

  const tables = (schemaInput.tables ?? []).map(buildTable)
  const relationships = deriveSchemaRelationships(tables)
  const schema: SchemaData = {
    tables,
    enums: (schemaInput.enums ?? []).map(buildEnum),
    relationships,
    metadata: {
      databaseType: schemaInput.metadata?.databaseType ?? 'postgresql',
      version: schemaInput.metadata?.version ?? '1.0',
      description: schemaInput.metadata?.description ?? 'AI-generated schema',
      totalTables: schemaInput.metadata?.totalTables ?? tables.length,
      totalRelationships:
        schemaInput.metadata?.totalRelationships ?? countSchemaRelationships(tables),
      generatedByModel: schemaInput.metadata?.generatedByModel,
      generationTimeMs: schemaInput.metadata?.generationTimeMs,
    },
  }

  return {
    schema,
    narrative: narrativeFromRaw(raw),
  }
}

export function safeParseSchemaResponse(raw: string): {
  schema: SchemaData | null
  narrative: string
  error: SchemaError | null
} {
  try {
    const parsed = parseSchemaResponse(raw)
    return {
      schema: parsed.schema,
      narrative: parsed.narrative,
      error: null,
    }
  } catch (error) {
    return {
      schema: null,
      narrative: '',
      error:
        (error as SchemaError) ?? {
          type: 'PARSE_ERROR',
          rawResponse: raw,
        },
    }
  }
}
