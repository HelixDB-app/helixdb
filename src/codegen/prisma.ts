import type { Column, Table } from '@/lib/schema-store'
import { createInputColumns, toPascalCaseTypeName } from '@/codegen/column-utils'

function prismaScalar(col: Column): { base: string; decorators: string[] } {
  const decorators: string[] = []
  switch (col.type) {
    case 'uuid':
      decorators.push('@db.Uuid')
      return { base: 'String', decorators }
    case 'integer':
      return { base: 'Int', decorators }
    case 'numeric':
      return { base: 'Decimal', decorators }
    case 'boolean':
      return { base: 'Boolean', decorators }
    case 'timestamp':
      return { base: 'DateTime', decorators }
    case 'json':
      return { base: 'Json', decorators }
    case 'text':
      decorators.push('@db.Text')
      return { base: 'String', decorators }
    case 'string':
    default:
      return { base: 'String', decorators }
  }
}

function prismaFieldLine(col: Column): string {
  const { base, decorators } = prismaScalar(col)
  if (col.isPrimaryKey) {
    decorators.push('@id')
    if (col.type === 'uuid') decorators.push('@default(uuid())')
    if (col.type === 'integer') decorators.push('@default(autoincrement())')
  }
  if (col.isUnique && !col.isPrimaryKey) decorators.push('@unique')

  const optional = col.nullable ? '?' : ''
  const tail = [base, ...decorators].join(' ')
  return `  ${col.name}${optional} ${tail}`
}

/** Prisma models + trailing comment for typical create payload fields. */
export function generatePrismaExport(tables: Table[]): string {
  const lines: string[] = []
  for (const table of tables) {
    const modelName = toPascalCaseTypeName(table.name)
    lines.push(`model ${modelName} {`)
    for (const col of table.columns) {
      lines.push(prismaFieldLine(col))
    }
    lines.push('}')
    const createCols = createInputColumns(table)
    const names = createCols.map((c) => c.name).join(', ')
    lines.push(
      `// CreateInput-style: omit PK + DateTime; create uses { ${names || '/* fields */'} }`
    )
    lines.push('')
  }
  return lines.join('\n').trimEnd() + '\n'
}
