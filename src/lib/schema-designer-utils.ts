import { generateSQL } from '@/lib/sql-export'
import type {
  CanvasItem,
  Column,
  Relationship,
  SchemaFunction,
  SchemaIndex,
  SchemaTrigger,
  Table,
} from '@/lib/schema-store'
import { DEFAULT_SCHEMA_STATE } from '@/lib/schema-store'
import type {
  CanvasItem as PersistedCanvasItem,
  ForeignKeyRef,
  SchemaColumn,
  SchemaFunction as PersistedFunction,
  SchemaProject,
  SchemaProjectSummary,
  SchemaTable,
  SchemaTrigger as PersistedTrigger,
} from '@/lib/schema-designer-types'

const TYPE_MAP: Array<{ pattern: RegExp; value: Column['type'] }> = [
  { pattern: /\b(INT|INTEGER|BIGINT|SMALLINT|SERIAL|BIGSERIAL)\b/i, value: 'integer' },
  { pattern: /\b(NUMERIC|DECIMAL|FLOAT|DOUBLE|REAL)\b/i, value: 'numeric' },
  { pattern: /\b(BOOL|BOOLEAN)\b/i, value: 'boolean' },
  { pattern: /\b(UUID)\b/i, value: 'uuid' },
  { pattern: /\b(JSONB?|JSON)\b/i, value: 'json' },
  { pattern: /\b(TIMESTAMP|TIMESTAMPTZ|DATE|TIME)\b/i, value: 'timestamp' },
  { pattern: /\b(TEXT)\b/i, value: 'text' },
  { pattern: /\b(CHAR|VARCHAR|CHARACTER|STRING)\b/i, value: 'string' },
]

function mapSqlTypeToStore(typeRaw: string): Column['type'] {
  const cleaned = typeRaw.trim()
  for (const entry of TYPE_MAP) {
    if (entry.pattern.test(cleaned)) return entry.value
  }
  return 'string'
}

function normalizeName(name: string): string {
  return name.trim().replace(/"/g, '').toLowerCase()
}

function splitTopLevel(input: string, delimiter = ','): string[] {
  const parts: string[] = []
  let buf = ''
  let depth = 0
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]
    const prev = input[i - 1]
    if (ch === "'" && !inDouble && prev !== '\\') {
      inSingle = !inSingle
      buf += ch
      continue
    }
    if (ch === '"' && !inSingle && prev !== '\\') {
      inDouble = !inDouble
      buf += ch
      continue
    }
    if (!inSingle && !inDouble) {
      if (ch === '(') depth += 1
      if (ch === ')') depth = Math.max(0, depth - 1)
      if (ch === delimiter && depth === 0) {
        const trimmed = buf.trim()
        if (trimmed) parts.push(trimmed)
        buf = ''
        continue
      }
    }
    buf += ch
  }
  const trimmed = buf.trim()
  if (trimmed) parts.push(trimmed)
  return parts
}

function splitSqlStatements(sql: string): string[] {
  const statements: string[] = []
  let buf = ''
  let depth = 0
  let inSingle = false
  let inDouble = false
  let dollarTag: string | null = null
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i]
    const prev = sql[i - 1]
    if (!inSingle && !inDouble && ch === '$') {
      const match = sql.slice(i).match(/^\$[A-Za-z0-9_]*\$/)
      if (match) {
        const tag = match[0]
        if (dollarTag === null) {
          dollarTag = tag
          buf += tag
          i += tag.length - 1
          continue
        }
        if (dollarTag === tag) {
          dollarTag = null
          buf += tag
          i += tag.length - 1
          continue
        }
      }
    }
    if (dollarTag) {
      buf += ch
      continue
    }
    if (ch === "'" && !inDouble && prev !== '\\') {
      inSingle = !inSingle
    } else if (ch === '"' && !inSingle && prev !== '\\') {
      inDouble = !inDouble
    }
    if (!inSingle && !inDouble) {
      if (ch === '(') depth += 1
      if (ch === ')') depth = Math.max(0, depth - 1)
      if (ch === ';' && depth === 0) {
        const trimmed = buf.trim()
        if (trimmed) statements.push(trimmed)
        buf = ''
        continue
      }
    }
    buf += ch
  }
  const trimmed = buf.trim()
  if (trimmed) statements.push(trimmed)
  return statements
}

function stripSqlComments(statement: string): string {
  return statement
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--.*$/gm, ' ')
    .trim()
}

function findMatchingParen(input: string, openIndex: number): number {
  let depth = 0
  let inSingle = false
  let inDouble = false
  for (let i = openIndex; i < input.length; i += 1) {
    const ch = input[i]
    const prev = input[i - 1]
    if (ch === "'" && !inDouble && prev !== '\\') {
      inSingle = !inSingle
    } else if (ch === '"' && !inSingle && prev !== '\\') {
      inDouble = !inDouble
    }
    if (inSingle || inDouble) continue
    if (ch === '(') depth += 1
    if (ch === ')') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

function extractTableName(raw: string): string {
  const cleaned = raw.trim().replace(/["`]/g, '')
  const parts = cleaned.split('.').map((p) => p.trim()).filter(Boolean)
  return parts[parts.length - 1] ?? cleaned
}

function buildRelationshipKey(
  sourceTable: string,
  sourceColumn: string,
  targetTable: string,
  targetColumn: string
): string {
  return `${normalizeName(sourceTable)}.${normalizeName(sourceColumn)}->${normalizeName(targetTable)}.${normalizeName(targetColumn)}`
}

function deriveExistingRelationshipMap(
  tables: Table[],
  relationships: Relationship[]
): Map<string, string> {
  const tableById = new Map(tables.map((t) => [t.id, t]))
  const colById = new Map<string, { table: Table; col: Column }>()
  for (const table of tables) {
    for (const col of table.columns) {
      colById.set(col.id, { table, col })
    }
  }
  const map = new Map<string, string>()
  for (const rel of relationships) {
    const sourceTable = tableById.get(rel.sourceTableId)
    const targetTable = tableById.get(rel.targetTableId)
    const sourceCol = colById.get(rel.sourceColumnId)
    const targetCol = colById.get(rel.targetColumnId)
    if (!sourceTable || !targetTable || !sourceCol || !targetCol) continue
    const key = buildRelationshipKey(
      sourceTable.name,
      sourceCol.col.name,
      targetTable.name,
      targetCol.col.name
    )
    map.set(key, rel.id)
  }
  return map
}

export function parseSchemaSQL(
  sql: string,
  existing?: {
    tables: Table[]
    relationships: Relationship[]
    functions?: SchemaFunction[]
    triggers?: SchemaTrigger[]
  }
): {
  tables: Table[]
  relationships: Relationship[]
  functions: SchemaFunction[]
  triggers: SchemaTrigger[]
} | null {
  const statements = splitSqlStatements(sql)
  const existingTables = existing?.tables ?? []
  const existingRelationships = existing?.relationships ?? []
  const existingFunctions = existing?.functions ?? []
  const existingTriggers = existing?.triggers ?? []
  const existingByName = new Map(
    existingTables.map((t) => [normalizeName(t.name), t])
  )
  const relationshipIdByKey = deriveExistingRelationshipMap(
    existingTables,
    existingRelationships
  )
  const existingFunctionByName = new Map(
    existingFunctions.map((fn) => [normalizeName(fn.name), fn])
  )
  const existingTriggerByKey = new Map(
    existingTriggers.map((trg) => [
      `${normalizeName(trg.name)}::${normalizeName(trg.tableId)}`,
      trg,
    ])
  )

  const tables: Table[] = []
  const fkRelations: Array<{
    sourceTable: string
    sourceColumn: string
    targetTable: string
    targetColumn: string
  }> = []
  const functions: SchemaFunction[] = []
  const triggers: SchemaTrigger[] = []
  const triggerCandidates: Array<{
    name: string
    tableName: string
    functionName: string
    timing: string
    events: string[]
  }> = []
  const indexesByTable = new Map<string, SchemaIndex[]>()

  let newTableIndex = 0
  const createLayout = (index: number) => ({
    x: 120 + (index % 3) * 320,
    y: 120 + Math.floor(index / 3) * 220,
  })

  for (const rawStmt of statements) {
    const stmt = stripSqlComments(rawStmt)
    if (!stmt) continue
    if (/^CREATE\s+(?:UNIQUE\s+)?INDEX/i.test(stmt)) {
      const idxMatch = stmt.match(
        /CREATE\s+(UNIQUE\s+)?INDEX\s+([^\s]+)\s+ON\s+([^\s(]+)\s*(?:USING\s+(\w+))?\s*\(([^)]+)\)/i
      )
      if (idxMatch) {
        const unique = Boolean(idxMatch[1])
        const name = idxMatch[2].replace(/["`]/g, '')
        const tableName = extractTableName(idxMatch[3])
        const method = idxMatch[4]
        const columnsRaw = idxMatch[5]
        const columns = splitTopLevel(columnsRaw).map((c) =>
          c.replace(/["`]/g, '').trim()
        )
        const existingTable = existingByName.get(normalizeName(tableName))
        const existingIdx = existingTable?.indexes?.find(
          (idx) => normalizeName(idx.name) === normalizeName(name)
        )
        const idx: SchemaIndex = {
          id:
            existingIdx?.id ??
            `idx-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          name,
          columns,
          unique,
          method,
        }
        const list = indexesByTable.get(normalizeName(tableName)) ?? []
        list.push(idx)
        indexesByTable.set(normalizeName(tableName), list)
      }
      continue
    }

    if (/^CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i.test(stmt)) {
      const fnMatch = stmt.match(
        /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([^\s(]+)\s*\(/i
      )
      if (fnMatch) {
        const name = fnMatch[1].replace(/["`]/g, '')
        const langMatch = stmt.match(/LANGUAGE\s+(\w+)/i)
        const returnsMatch = stmt.match(/RETURNS\s+([^\s]+(?:\s+\w+)*)/i)
        const existingFn = existingFunctionByName.get(normalizeName(name))
        const layout = existingFn
          ? { x: existingFn.x ?? 0, y: existingFn.y ?? 0 }
          : {
              x: 820 + (functions.length % 2) * 260,
              y: 120 + Math.floor(functions.length / 2) * 140,
            }
        functions.push({
          id:
            existingFn?.id ??
            `fn-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          name,
          language: langMatch?.[1],
          returns: returnsMatch?.[1],
          definition: rawStmt.trim(),
          x: layout.x,
          y: layout.y,
        })
      }
      continue
    }

    if (/^CREATE\s+TRIGGER/i.test(stmt)) {
      const trgMatch = stmt.match(
        /CREATE\s+TRIGGER\s+([^\s]+)\s+(BEFORE|AFTER|INSTEAD OF)\s+([\s\S]+?)\s+ON\s+([^\s]+)\s+FOR\s+EACH\s+ROW\s+EXECUTE\s+(?:FUNCTION|PROCEDURE)\s+([^\s(]+)/i
      )
      if (trgMatch) {
        const name = trgMatch[1].replace(/["`]/g, '')
        const timing = trgMatch[2]
        const events = trgMatch[3]
          .split(/\s+OR\s+/i)
          .map((e) => e.trim().toUpperCase())
          .filter(Boolean)
        const tableName = extractTableName(trgMatch[4])
        const functionName = trgMatch[5].replace(/["`]/g, '')
        triggerCandidates.push({
          name,
          timing,
          events,
          tableName,
          functionName,
        })
      }
      continue
    }

    if (!/^CREATE\s+TABLE/i.test(stmt)) continue
    const afterCreate = stmt.replace(/^CREATE\s+TABLE/i, '').trim()
    const afterExists = afterCreate.replace(/^IF\s+NOT\s+EXISTS/i, '').trim()
    const openIndex = afterExists.indexOf('(')
    if (openIndex === -1) continue
    const closeIndex = findMatchingParen(afterExists, openIndex)
    if (closeIndex === -1) continue
    const tableName = extractTableName(afterExists.slice(0, openIndex))
    const body = afterExists.slice(openIndex + 1, closeIndex)
    if (!tableName) continue

    const existingTable = existingByName.get(normalizeName(tableName))
    const existingColumnByName = new Map(
      (existingTable?.columns ?? []).map((c) => [normalizeName(c.name), c])
    )

    const columns: Column[] = []
    const pkColumns = new Set<string>()
    const uniqueColumns = new Set<string>()

    const parts = splitTopLevel(body)
    for (const partRaw of parts) {
      let part = partRaw.trim()
      if (!part) continue
      if (/^CONSTRAINT/i.test(part)) {
        part = part.replace(/^CONSTRAINT\s+["`]?[\w-]+["`]?\s+/i, '').trim()
      }
      if (/^PRIMARY\s+KEY/i.test(part)) {
        const match = part.match(/PRIMARY\s+KEY\s*\(([^)]+)\)/i)
        if (match) {
          match[1]
            .split(',')
            .map((c) => normalizeName(c))
            .forEach((c) => pkColumns.add(c))
        }
        continue
      }
      if (/^UNIQUE/i.test(part)) {
        const match = part.match(/UNIQUE\s*\(([^)]+)\)/i)
        if (match) {
          match[1]
            .split(',')
            .map((c) => normalizeName(c))
            .forEach((c) => uniqueColumns.add(c))
        }
        continue
      }
      if (/^FOREIGN\s+KEY/i.test(part)) {
        const match = part.match(
          /FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+([^\s(]+)\s*\(([^)]+)\)/i
        )
        if (match) {
          const sourceCol = normalizeName(match[1])
          const targetTable = extractTableName(match[2])
          const targetCol = normalizeName(match[3])
          fkRelations.push({
            sourceTable: tableName,
            sourceColumn: sourceCol,
            targetTable,
            targetColumn: targetCol,
          })
        }
        continue
      }

      const [nameToken, ...restTokens] = part.split(/\s+/)
      const rawName = nameToken.replace(/["`]/g, '').trim()
      const colKey = normalizeName(rawName)
      if (!colKey) continue
      const rest = restTokens.join(' ')
      const restTokensNormalized = restTokens.map((t) => t.toUpperCase())
      const constraintKeywords = new Set([
        'NOT',
        'NULL',
        'PRIMARY',
        'UNIQUE',
        'DEFAULT',
        'REFERENCES',
        'CHECK',
        'CONSTRAINT',
      ])
      const typeParts: string[] = []
      for (let i = 0; i < restTokens.length; i += 1) {
        if (constraintKeywords.has(restTokensNormalized[i])) break
        typeParts.push(restTokens[i])
      }
      const typeRaw = typeParts.join(' ')
      const nullable = !/NOT\s+NULL/i.test(rest)
      const isPrimaryKey = /PRIMARY\s+KEY/i.test(rest)
      const isUnique = /UNIQUE/i.test(rest)
      let defaultValue: string | undefined
      const defaultMatch = rest.match(
        /DEFAULT\s+(.+?)(?:\s+(?:NOT|PRIMARY|UNIQUE|REFERENCES|CHECK|CONSTRAINT)\b|$)/i
      )
      if (defaultMatch) defaultValue = defaultMatch[1].trim()

      const inlineFkMatch = rest.match(
        /REFERENCES\s+([^\s(]+)\s*\(([^)]+)\)/i
      )
      if (inlineFkMatch) {
        fkRelations.push({
          sourceTable: tableName,
          sourceColumn: colKey,
          targetTable: extractTableName(inlineFkMatch[1]),
          targetColumn: normalizeName(inlineFkMatch[2]),
        })
      }

      const existingColumn = existingColumnByName.get(colKey)
      columns.push({
        id: existingColumn?.id ?? `col-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        name: rawName,
        type: mapSqlTypeToStore(typeRaw),
        nullable,
        isPrimaryKey: isPrimaryKey || pkColumns.has(colKey),
        isUnique: isUnique || uniqueColumns.has(colKey),
        default: defaultValue,
      })
    }

    if (columns.length === 0) continue

    const layout = existingTable
      ? { x: existingTable.x, y: existingTable.y }
      : createLayout(newTableIndex++)

    tables.push({
      id: existingTable?.id ?? `table-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      name: tableName,
      columns,
      indexes: existingTable?.indexes ?? [],
      x: layout.x,
      y: layout.y,
    })
  }

  if (tables.length === 0) return null

  for (const table of tables) {
    const indexed = indexesByTable.get(normalizeName(table.name)) ?? []
    if (indexed.length > 0) {
      table.indexes = indexed
    }
  }

  const tableByName = new Map(tables.map((t) => [normalizeName(t.name), t]))
  const columnByTable = new Map<string, Map<string, Column>>()
  for (const table of tables) {
    columnByTable.set(
      normalizeName(table.name),
      new Map(table.columns.map((c) => [normalizeName(c.name), c]))
    )
  }

  const relationships: Relationship[] = []
  for (const rel of fkRelations) {
    const sourceTable = tableByName.get(normalizeName(rel.sourceTable))
    const targetTable = tableByName.get(normalizeName(rel.targetTable))
    const sourceCol = columnByTable
      .get(normalizeName(rel.sourceTable))
      ?.get(normalizeName(rel.sourceColumn))
    const targetCol = columnByTable
      .get(normalizeName(rel.targetTable))
      ?.get(normalizeName(rel.targetColumn))
    if (!sourceTable || !targetTable || !sourceCol || !targetCol) continue
    const key = buildRelationshipKey(
      sourceTable.name,
      sourceCol.name,
      targetTable.name,
      targetCol.name
    )
    relationships.push({
      id: relationshipIdByKey.get(key) ?? `rel-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      sourceTableId: sourceTable.id,
      sourceColumnId: sourceCol.id,
      targetTableId: targetTable.id,
      targetColumnId: targetCol.id,
      type:
        targetCol.isUnique || targetCol.isPrimaryKey
          ? 'one-to-one'
          : 'one-to-many',
    })
  }

  for (const trg of triggerCandidates) {
    const table = tableByName.get(normalizeName(trg.tableName))
    if (!table) continue
    const existingKey = `${normalizeName(trg.name)}::${normalizeName(
      table.id
    )}`
    const existingTrg = existingTriggerByKey.get(existingKey)
    const layout = existingTrg
      ? { x: existingTrg.x ?? 0, y: existingTrg.y ?? 0 }
      : {
          x: table.x + 240,
          y: table.y - 40,
        }
    triggers.push({
      id:
        existingTrg?.id ??
        `trg-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      name: trg.name,
      tableId: table.id,
      functionName: trg.functionName,
      timing: trg.timing,
      events: trg.events,
      x: layout.x,
      y: layout.y,
    })
  }

  return { tables, relationships, functions, triggers }
}

function mapStoreColumnToSchemaColumn(
  column: Column,
  foreignKey?: ForeignKeyRef | null
): SchemaColumn {
  return {
    id: column.id,
    name: column.name,
    data_type: column.type,
    nullable: column.nullable,
    default_value: column.default ?? null,
    is_primary_key: column.isPrimaryKey,
    is_unique: column.isUnique,
    foreign_key: foreignKey ?? null,
  }
}

export function projectToSummary(project: SchemaProject): SchemaProjectSummary {
  return {
    id: project.id,
    name: project.name,
    description: project.description ?? '',
    app_type: project.app_type ?? '',
    created_at: project.created_at,
    updated_at: project.updated_at,
    table_count: project.tables.length,
  }
}

export function projectToStore(
  project: SchemaProject,
  existing?: { tables: Table[]; relationships: Relationship[] }
) {
  let tables: Table[] = project.tables.map((table, index) => {
    const existingTable = existing?.tables.find(
      (t) => normalizeName(t.name) === normalizeName(table.name)
    )
    const layout = table.position ?? (existingTable ? { x: existingTable.x, y: existingTable.y } : {
      x: 120 + (index % 3) * 320,
      y: 120 + Math.floor(index / 3) * 220,
    })
    const existingColumnByName = new Map(
      (existingTable?.columns ?? []).map((c) => [normalizeName(c.name), c])
    )
    return {
      id: table.id ?? existingTable?.id ?? `table-${Date.now()}-${index}`,
      name: table.name,
      x: layout.x,
      y: layout.y,
      indexes: (table.indexes ?? []).map((idx) => ({
        id: idx.id,
        name: idx.name,
        columns: idx.columns,
        unique: idx.unique ?? false,
        method: idx.method,
      })),
      columns: table.columns.map((col, colIndex) => {
        const existingColumn = existingColumnByName.get(normalizeName(col.name))
        return {
          id: col.id ?? existingColumn?.id ?? `col-${Date.now()}-${colIndex}`,
          name: col.name,
          type: mapSqlTypeToStore(col.data_type),
          nullable: col.nullable ?? true,
          isPrimaryKey: col.is_primary_key ?? false,
          isUnique: col.is_unique ?? false,
          default: col.default_value ?? undefined,
        }
      }),
    }
  })

  let relationships: Relationship[] = []
  const tableById = new Map(tables.map((t) => [t.id, t]))
  const columnById = new Map<string, Column>()
  for (const table of tables) {
    for (const column of table.columns) {
      columnById.set(column.id, column)
    }
  }

  for (const table of project.tables) {
    for (const column of table.columns) {
      if (!column.foreign_key) continue
      const sourceTable = tableById.get(table.id)
      const sourceColumn = columnById.get(column.id)
      const targetTable = tableById.get(column.foreign_key.target_table_id)
      const targetColumn = columnById.get(column.foreign_key.target_column_id)
      if (!sourceTable || !sourceColumn || !targetTable || !targetColumn) continue
      relationships.push({
        id: `rel-${column.id}-${column.foreign_key.target_column_id}`,
        sourceTableId: sourceTable.id,
        sourceColumnId: sourceColumn.id,
        targetTableId: targetTable.id,
        targetColumnId: targetColumn.id,
        type: 'one-to-many',
      })
    }
  }

  let functions: SchemaFunction[] = (project.functions ?? []).map((fn) => ({
    id: fn.id,
    name: fn.name,
    language: fn.language,
    returns: fn.returns,
    definition: fn.definition,
    x: fn.x ?? 0,
    y: fn.y ?? 0,
  }))
  let triggers: SchemaTrigger[] = (project.triggers ?? []).map((trg) => ({
    id: trg.id,
    name: trg.name,
    tableId: trg.table_id,
    functionName: trg.function_name,
    timing: trg.timing,
    events: trg.events ?? [],
    x: trg.x ?? 0,
    y: trg.y ?? 0,
  }))

  if (project.code && (!tables.length || relationships.length === 0)) {
    const parsed = parseSchemaSQL(project.code, {
      tables,
      relationships,
      functions,
      triggers,
    })
    if (parsed) {
      tables = parsed.tables
      relationships = parsed.relationships
      if (functions.length === 0) functions = parsed.functions
      if (triggers.length === 0) triggers = parsed.triggers
    }
  }

  const canvasItems: CanvasItem[] = (project.canvas_items ?? []).map((item) => ({
    id: item.id,
    kind:
      item.kind === 'image'
        ? 'image'
        : item.kind === 'cron'
          ? 'cron'
          : 'note',
    x: item.x,
    y: item.y,
    text: item.text ?? undefined,
    imageUrl: item.image_url ?? undefined,
    schedule: item.schedule ?? undefined,
    task: item.task ?? undefined,
  }))

  const code = project.code && project.code.trim().length > 0
    ? project.code
    : generateSQL(tables, relationships, functions, triggers)

  return {
    projectId: project.id,
    projectName: project.name,
    projectDescription: project.description ?? '',
    projectAppType: project.app_type ?? 'database',
    projectCreatedAt: project.created_at,
    projectUpdatedAt: project.updated_at,
    tables,
    relationships,
    functions,
    triggers,
    canvasItems,
    code,
  }
}

export function storeToProject(
  state: {
    projectId: string | null
    projectName: string
    projectDescription: string
    projectAppType: string
    projectCreatedAt: string | null
    projectUpdatedAt: string | null
    tables: Table[]
    relationships: Relationship[]
    functions?: SchemaFunction[]
    triggers?: SchemaTrigger[]
    canvasItems?: CanvasItem[]
    code: string
  },
  updatedAtOverride?: string
): SchemaProject {
  const now = updatedAtOverride ?? new Date().toISOString()
  const createdAt = state.projectCreatedAt ?? now
  const relationshipsBySource = new Map<string, Relationship[]>()
  for (const rel of state.relationships) {
    const list = relationshipsBySource.get(rel.sourceColumnId) ?? []
    list.push(rel)
    relationshipsBySource.set(rel.sourceColumnId, list)
  }

  const tables: SchemaTable[] = state.tables.map((table) => ({
    id: table.id,
    name: table.name,
    position: { x: table.x, y: table.y },
    columns: table.columns.map((col) => {
      const rel = relationshipsBySource.get(col.id)?.[0]
      const foreignKey: ForeignKeyRef | null = rel
        ? {
            target_table_id: rel.targetTableId,
            target_column_id: rel.targetColumnId,
          }
        : null
      return mapStoreColumnToSchemaColumn(col, foreignKey)
    }),
    indexes: (table.indexes ?? []).map((idx) => ({
      id: idx.id,
      name: idx.name,
      columns: idx.columns,
      unique: idx.unique,
      method: idx.method ?? '',
    })),
  }))

  return {
    id: state.projectId ?? `project-${Date.now()}`,
    name: state.projectName.trim() || 'Untitled Project',
    app_type: state.projectAppType ?? 'database',
    description: state.projectDescription ?? '',
    tables,
    version_history: [],
    functions: (state.functions ?? []).map<PersistedFunction>((fn) => ({
      id: fn.id,
      name: fn.name,
      language: fn.language ?? '',
      returns: fn.returns ?? '',
      definition: fn.definition ?? '',
      x: fn.x ?? 0,
      y: fn.y ?? 0,
    })),
    triggers: (state.triggers ?? []).map<PersistedTrigger>((trg) => ({
      id: trg.id,
      name: trg.name,
      table_id: trg.tableId,
      function_name: trg.functionName,
      timing: trg.timing ?? '',
      events: trg.events ?? [],
      x: trg.x ?? 0,
      y: trg.y ?? 0,
    })),
    canvas_items: (state.canvasItems ?? []).map<PersistedCanvasItem>((item) => ({
      id: item.id,
      kind: item.kind,
      x: item.x,
      y: item.y,
      text: item.text ?? undefined,
      image_url: item.imageUrl ?? undefined,
      schedule: item.schedule ?? undefined,
      task: item.task ?? undefined,
    })),
    created_at: createdAt,
    updated_at: now,
    code: state.code ?? '',
  }
}

export function buildNewProject(
  args: { id: string; name?: string; description?: string; appType?: string } = {
    id: `project-${Date.now()}`,
  }
): SchemaProject {
  const now = new Date().toISOString()
  const baseTables: Table[] = JSON.parse(
    JSON.stringify(DEFAULT_SCHEMA_STATE.tables)
  )
  const baseRelationships: Relationship[] = JSON.parse(
    JSON.stringify(DEFAULT_SCHEMA_STATE.relationships)
  )
  const code = generateSQL(baseTables, baseRelationships, [], [])
  return storeToProject(
    {
      projectId: args.id,
      projectName: args.name ?? 'Untitled Project',
      projectDescription: args.description ?? '',
      projectAppType: args.appType ?? 'database',
      projectCreatedAt: now,
      projectUpdatedAt: now,
      tables: baseTables,
      relationships: baseRelationships,
      code,
    },
    now
  )
}
