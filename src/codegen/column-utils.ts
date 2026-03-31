import type { Column } from '@/lib/schema-store'

/** Columns allowed on "create input" DTOs: omit PK and all timestamps. */
export function includeInCreateInput(col: Column): boolean {
  if (col.isPrimaryKey) return false
  if (col.type === 'timestamp') return false
  return true
}

/** `users` → `Users` */
export function toPascalCaseTypeName(tableName: string): string {
  return tableName
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('')
}

export function createInputColumns(table: { columns: Column[] }): Column[] {
  return table.columns.filter(includeInCreateInput)
}
