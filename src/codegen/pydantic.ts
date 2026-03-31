import type { Column, Table } from '@/lib/schema-store'
import { createInputColumns, toPascalCaseTypeName } from '@/codegen/column-utils'

function pyType(col: Column): string {
  switch (col.type) {
    case 'string':
    case 'text':
    case 'uuid':
      return 'str'
    case 'integer':
      return 'int'
    case 'numeric':
      return 'float'
    case 'boolean':
      return 'bool'
    case 'json':
      return 'dict[str, Any]'
    default:
      return 'str'
  }
}

export function generatePydanticExport(tables: Table[]): string {
  const lines: string[] = [
    'from __future__ import annotations',
    '',
    'from typing import Any, Optional',
    '',
    'from pydantic import BaseModel, Field',
    '',
  ]
  for (const table of tables) {
    const typeName = `${toPascalCaseTypeName(table.name)}CreateInput`
    const createCols = createInputColumns(table)
    lines.push(`class ${typeName}(BaseModel):`)
    if (createCols.length === 0) {
      lines.push('    pass  # no insertable columns (only PK / timestamps)')
    } else {
      for (const col of createCols) {
        const desc = JSON.stringify(col.name)
        const inner = pyType(col)
        if (col.nullable) {
          lines.push(
            `    ${col.name}: Optional[${inner}] = Field(default=None, description=${desc})`
          )
        } else {
          lines.push(`    ${col.name}: ${inner} = Field(description=${desc})`)
        }
      }
    }
    lines.push('')
  }
  return lines.join('\n').trimEnd() + '\n'
}
