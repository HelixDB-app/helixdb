import type { Column, Table } from '@/lib/schema-store'
import { createInputColumns, toPascalCaseTypeName } from '@/codegen/column-utils'

function zodExpr(col: Column): string {
  let z = ''
  switch (col.type) {
    case 'uuid':
      z = 'z.string().uuid()'
      break
    case 'integer':
      z = 'z.number().int()'
      break
    case 'numeric':
      z = 'z.number()'
      break
    case 'boolean':
      z = 'z.boolean()'
      break
    case 'timestamp':
      z = 'z.coerce.date()'
      break
    case 'json':
      z = 'z.record(z.string(), z.unknown())'
      break
    case 'text':
    case 'string':
    default:
      z = 'z.string()'
      break
  }
  if (col.nullable) z += '.nullable()'
  return z
}

export function generateZodExport(tables: Table[]): string {
  const lines: string[] = ['import { z } from "zod";', '']
  for (const table of tables) {
    const typeName = toPascalCaseTypeName(table.name)
    const createCols = createInputColumns(table)
    if (createCols.length === 0) {
      lines.push(
        `export const ${typeName}CreateInputSchema = z.object({});`
      )
    } else {
      lines.push(`export const ${typeName}CreateInputSchema = z.object({`)
      for (const col of createCols) {
        lines.push(`  ${col.name}: ${zodExpr(col)},`)
      }
      lines.push('});')
    }
    lines.push('')
    lines.push(
      `export type ${typeName}CreateInput = z.infer<typeof ${typeName}CreateInputSchema>;`
    )
    lines.push('')
  }
  return lines.join('\n').trimEnd() + '\n'
}
