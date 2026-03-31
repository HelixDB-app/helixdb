import type { Column, Table } from '@/lib/schema-store'
import { createInputColumns, toPascalCaseTypeName } from '@/codegen/column-utils'

function tsScalarType(col: Column): string {
  switch (col.type) {
    case 'string':
    case 'text':
      return 'string'
    case 'integer':
    case 'numeric':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'timestamp':
      return 'Date'
    case 'uuid':
      return 'string'
    case 'json':
      return 'Record<string, unknown>'
    default:
      return 'unknown'
  }
}

function fieldLine(col: Column): string {
  const optionalMark = col.nullable ? '?' : ''
  const nullUnion = col.nullable ? ' | null' : ''
  return `${col.name}${optionalMark}: ${tsScalarType(col)}${nullUnion}`
}

/** Legacy-compatible: full row interfaces only (used by Export menu SQL→TS download). */
export function generateTypeScriptInterfacesOnly(tables: Table[]): string {
  const lines: string[] = []
  for (const table of tables) {
    const typeName = toPascalCaseTypeName(table.name)
    lines.push(`export interface ${typeName} {`)
    for (const col of table.columns) {
      lines.push(`  ${fieldLine(col)}`)
    }
    lines.push('}')
    lines.push('')
  }
  return lines.join('\n').trimEnd() + '\n'
}

/** Full row interfaces + CreateInput types (omits PK + timestamps). */
export function generateTypeScriptExport(tables: Table[]): string {
  const lines: string[] = []
  for (const table of tables) {
    const typeName = toPascalCaseTypeName(table.name)
    lines.push(`export interface ${typeName} {`)
    for (const col of table.columns) {
      lines.push(`  ${fieldLine(col)}`)
    }
    lines.push('}')
    lines.push('')

    const createCols = createInputColumns(table)
    lines.push(`export type ${typeName}CreateInput = {`)
    if (createCols.length === 0) {
      lines.push('  // no insertable columns (only PK / timestamps)')
    } else {
      for (const col of createCols) {
        lines.push(`  ${fieldLine(col)}`)
      }
    }
    lines.push('}')
    lines.push('')
  }
  return lines.join('\n').trimEnd() + '\n'
}
