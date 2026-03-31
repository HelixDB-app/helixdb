import {
  Table,
  Relationship,
  SchemaFunction,
  SchemaTrigger,
  CanvasItem,
} from './schema-store'
import { generateTypeScriptInterfacesOnly } from '@/codegen/ts'

export function generateSQL(
  tables: Table[],
  relationships: Relationship[],
  functions: SchemaFunction[] = [],
  triggers: SchemaTrigger[] = []
): string {
  const lines: string[] = []

  // Create tables
  tables.forEach((table) => {
    lines.push(`CREATE TABLE ${table.name} (`)

    const columnDefs = table.columns.map((col) => {
      let def = `  ${col.name} ${col.type.toUpperCase()}`

      if (!col.nullable) {
        def += ' NOT NULL'
      }

      if (col.isPrimaryKey) {
        def += ' PRIMARY KEY'
      }

      if (col.isUnique && !col.isPrimaryKey) {
        def += ' UNIQUE'
      }

      if (col.default) {
        def += ` DEFAULT ${col.default}`
      }

      return def
    })

    lines.push(columnDefs.join(',\n'))

    // Add foreign key constraints
    const tableRelationships = relationships.filter(
      (rel) => rel.sourceTableId === table.id
    )

    if (tableRelationships.length > 0) {
      const constraints = tableRelationships.map((rel) => {
        const sourceCol = table.columns.find((col) => col.id === rel.sourceColumnId)
        const targetTable = tables.find((t) => t.id === rel.targetTableId)
        const targetCol = targetTable?.columns.find((col) => col.id === rel.targetColumnId)

        return `  FOREIGN KEY (${sourceCol?.name}) REFERENCES ${targetTable?.name}(${targetCol?.name})`
      })

      lines.push(',')
      lines.push(constraints.join(',\n'))
    }

    lines.push(');')
    lines.push('')
  })

  // Create indexes
  const indexes = tables.flatMap((table) =>
    (table.indexes ?? []).map((idx) => ({ table, index: idx }))
  )
  if (indexes.length > 0) {
    indexes.forEach(({ table, index }) => {
      const unique = index.unique ? 'UNIQUE ' : ''
      const method = index.method ? ` USING ${index.method}` : ''
      const cols = index.columns.join(', ')
      lines.push(
        `CREATE ${unique}INDEX ${index.name} ON ${table.name}${method} (${cols});`
      )
    })
    lines.push('')
  }

  // Functions
  if (functions.length > 0) {
    functions.forEach((fn) => {
      const def = fn.definition?.trim()
      if (def) {
        lines.push(def.endsWith(';') ? def : `${def};`)
      } else {
        const returns = fn.returns || 'void'
        const language = fn.language || 'plpgsql'
        lines.push(
          `CREATE FUNCTION ${fn.name}() RETURNS ${returns} LANGUAGE ${language} AS $$\nBEGIN\n  -- TODO: implement\nEND;\n$$;`
        )
      }
      lines.push('')
    })
  }

  // Triggers
  if (triggers.length > 0) {
    triggers.forEach((trg) => {
      const table = tables.find((t) => t.id === trg.tableId)
      if (!table) return
      const timing = trg.timing ?? 'AFTER'
      const events =
        trg.events && trg.events.length > 0 ? trg.events.join(' OR ') : 'INSERT'
      lines.push(
        `CREATE TRIGGER ${trg.name} ${timing} ${events} ON ${table.name} FOR EACH ROW EXECUTE FUNCTION ${trg.functionName}();`
      )
    })
    lines.push('')
  }

  return lines.join('\n')
}

export function generateTypeScript(tables: Table[]): string {
  return generateTypeScriptInterfacesOnly(tables)
}

export function generateJSON(
  tables: Table[],
  relationships: Relationship[],
  functions: SchemaFunction[] = [],
  triggers: SchemaTrigger[] = [],
  canvasItems: CanvasItem[] = []
): string {
  const schema = {
    tables: tables.map((table) => ({
      name: table.name,
      columns: table.columns.map((col) => ({
        name: col.name,
        type: col.type,
        nullable: col.nullable,
        isPrimaryKey: col.isPrimaryKey,
        isUnique: col.isUnique,
        default: col.default,
      })),
      indexes: (table.indexes ?? []).map((idx) => ({
        name: idx.name,
        columns: idx.columns,
        unique: idx.unique,
        method: idx.method,
      })),
    })),
    relationships: relationships.map((rel) => ({
      sourceTable: tables.find((t) => t.id === rel.sourceTableId)?.name,
      sourceColumn: tables
        .find((t) => t.id === rel.sourceTableId)
        ?.columns.find((c) => c.id === rel.sourceColumnId)?.name,
      targetTable: tables.find((t) => t.id === rel.targetTableId)?.name,
      targetColumn: tables
        .find((t) => t.id === rel.targetTableId)
        ?.columns.find((c) => c.id === rel.targetColumnId)?.name,
      type: rel.type,
    })),
    functions: functions.map((fn) => ({
      name: fn.name,
      language: fn.language,
      returns: fn.returns,
      definition: fn.definition,
    })),
    triggers: triggers.map((trg) => ({
      name: trg.name,
      tableId: trg.tableId,
      functionName: trg.functionName,
      timing: trg.timing,
      events: trg.events,
    })),
    canvas: canvasItems.map((item) => ({
      id: item.id,
      kind: item.kind,
      x: item.x,
      y: item.y,
      text: item.text,
      imageUrl: item.imageUrl,
      schedule: item.schedule,
      task: item.task,
    })),
  }

  return JSON.stringify(schema, null, 2)
}
