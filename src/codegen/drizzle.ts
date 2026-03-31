import type { Column, Table } from '@/lib/schema-store'
import { createInputColumns, toPascalCaseTypeName } from '@/codegen/column-utils'

function drizzleColExpr(col: Column): string {
  const chain: string[] = []
  switch (col.type) {
    case 'uuid':
      chain.push(`uuid("${col.name}")`)
      break
    case 'integer':
      chain.push(`integer("${col.name}")`)
      break
    case 'numeric':
      chain.push(`numeric("${col.name}")`)
      break
    case 'boolean':
      chain.push(`boolean("${col.name}")`)
      break
    case 'timestamp':
      chain.push(`timestamp("${col.name}", { mode: "date" })`)
      break
    case 'json':
      chain.push(`jsonb("${col.name}")`)
      break
    case 'text':
      chain.push(`text("${col.name}")`)
      break
    case 'string':
    default:
      chain.push(`varchar("${col.name}", { length: 255 })`)
      break
  }
  let expr = chain[0]!
  if (col.isPrimaryKey) {
    if (col.type === 'uuid') expr += '.primaryKey().defaultRandom()'
    else expr += '.primaryKey()'
  }
  if (col.isUnique && !col.isPrimaryKey) expr += '.unique()'
  if (!col.nullable && !col.isPrimaryKey) expr += '.notNull()'
  return `  ${col.name}: ${expr},`
}

function tsScalarForCreate(col: Column): string {
  switch (col.type) {
    case 'string':
    case 'text':
      return 'string'
    case 'integer':
    case 'numeric':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'uuid':
      return 'string'
    case 'json':
      return 'Record<string, unknown>'
    default:
      return 'unknown'
  }
}

export function generateDrizzleExport(tables: Table[]): string {
  const lines: string[] = [
    'import { pgTable, uuid, varchar, text, integer, numeric, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";',
    '',
  ]
  for (const table of tables) {
    const varName = table.name.replace(/[^a-zA-Z0-9_]/g, '_')
    lines.push(`export const ${varName} = pgTable("${table.name}", {`)
    for (const col of table.columns) {
      lines.push(drizzleColExpr(col))
    }
    lines.push('});')
    lines.push('')

    const typeName = toPascalCaseTypeName(table.name)
    const createCols = createInputColumns(table)
    lines.push(`export type ${typeName}CreateInput = {`)
    if (createCols.length === 0) {
      lines.push('  // no insertable columns')
    } else {
      for (const col of createCols) {
        const opt = col.nullable ? '?' : ''
        const nu = col.nullable ? ' | null' : ''
        lines.push(`  ${col.name}${opt}: ${tsScalarForCreate(col)}${nu};`)
      }
    }
    lines.push('};')
    lines.push('')
  }
  return lines.join('\n').trimEnd() + '\n'
}
