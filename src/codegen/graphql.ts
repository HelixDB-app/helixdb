import type { Column, Table } from '@/lib/schema-store'
import { createInputColumns, toPascalCaseTypeName } from '@/codegen/column-utils'

function gqlScalar(col: Column): string {
  switch (col.type) {
    case 'uuid':
    case 'string':
    case 'text':
      return 'String'
    case 'integer':
      return 'Int'
    case 'numeric':
      return 'Float'
    case 'boolean':
      return 'Boolean'
    case 'timestamp':
      return 'String'
    case 'json':
      return 'JSON'
    default:
      return 'String'
  }
}

function gqlField(col: Column): string {
  const bang = col.nullable ? '' : '!'
  return `  ${col.name}: ${gqlScalar(col)}${bang}`
}

export function generateGraphQLExport(tables: Table[]): string {
  const lines: string[] = []
  for (const table of tables) {
    const typeName = toPascalCaseTypeName(table.name)
    const createCols = createInputColumns(table)
    if (createCols.length === 0) {
      lines.push(`# ${typeName}CreateInput omitted — no insertable fields (only PK / timestamps).`)
      lines.push('')
      continue
    }
    lines.push(`input ${typeName}CreateInput {`)
    for (const col of createCols) {
      lines.push(gqlField(col))
    }
    lines.push('}')
    lines.push('')
  }
  return lines.join('\n').trimEnd() + '\n'
}
