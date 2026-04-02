/**
 * Lightweight heuristics for common schema issues (no DB connection).
 */

import type { Relationship, Table } from '@/lib/schema-store'

export function schemaPerfHints(tables: Table[], relationships: Relationship[]): string[] {
  const hints: string[] = []
  const tableById = new Map(tables.map((t) => [t.id, t]))

  for (const rel of relationships) {
    const src = tableById.get(rel.sourceTableId)
    if (!src) continue
    const fkCol = src.columns.find((c) => c.id === rel.sourceColumnId)
    if (!fkCol) continue
    const hasIndex = (src.indexes ?? []).some((ix) =>
      ix.columns.includes(fkCol.name)
    )
    if (!hasIndex && !fkCol.isPrimaryKey) {
      hints.push(`Consider indexing FK column "${src.name}.${fkCol.name}" for join performance.`)
    }
  }

  for (const t of tables) {
    if (t.columns.length > 40) {
      hints.push(`Table "${t.name}" has many columns (${t.columns.length}) — consider splitting or vertical partitioning.`)
    }
  }

  if (relationships.length > tables.length * 4) {
    hints.push('High relationship density — watch for N+1 query patterns in ORMs.')
  }

  return Array.from(new Set(hints)).slice(0, 6)
}
