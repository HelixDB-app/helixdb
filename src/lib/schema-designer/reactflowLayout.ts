import type { Edge, Node } from 'reactflow'
import type { SchemaData, TableSchema } from '@/lib/schema-designer/types'

const NODE_WIDTH = 320
const NODE_HEIGHT = 232
const NODE_GAP_X = 120
const NODE_GAP_Y = 84

function layeredOrder(schema: SchemaData): TableSchema[] {
  const tableById = new Map(schema.tables.map((table) => [table.id, table]))
  const indegree = new Map(schema.tables.map((table) => [table.id, 0]))
  const children = new Map<string, string[]>()

  for (const relationship of schema.relationships) {
    indegree.set(
      relationship.sourceTableId,
      (indegree.get(relationship.sourceTableId) ?? 0) + 1
    )
    const existing = children.get(relationship.targetTableId) ?? []
    children.set(relationship.targetTableId, [...existing, relationship.sourceTableId])
  }

  const queue = schema.tables
    .filter((table) => (indegree.get(table.id) ?? 0) === 0)
    .map((table) => table.id)
  const ordered: TableSchema[] = []
  const visited = new Set<string>()

  while (queue.length > 0) {
    const nextId = queue.shift()
    if (!nextId || visited.has(nextId)) continue
    visited.add(nextId)
    const table = tableById.get(nextId)
    if (table) ordered.push(table)

    for (const childId of children.get(nextId) ?? []) {
      const nextIndegree = (indegree.get(childId) ?? 0) - 1
      indegree.set(childId, nextIndegree)
      if (nextIndegree <= 0) queue.push(childId)
    }
  }

  for (const table of schema.tables) {
    if (!visited.has(table.id)) ordered.push(table)
  }

  return ordered
}

export function applySchemaLayout(
  schema: SchemaData,
  direction: 'TB' | 'LR' = 'LR'
): SchemaData {
  const ordered = layeredOrder(schema)
  const levelMap = new Map<string, number>()

  for (const table of ordered) {
    const incoming = schema.relationships.filter(
      (relationship) => relationship.sourceTableId === table.id
    )
    const level = incoming.reduce((highest, relationship) => {
      const parentLevel = levelMap.get(relationship.targetTableId) ?? 0
      return Math.max(highest, parentLevel + 1)
    }, 0)
    levelMap.set(table.id, level)
  }

  const tablesByLevel = new Map<number, TableSchema[]>()
  for (const table of ordered) {
    const level = levelMap.get(table.id) ?? 0
    const existing = tablesByLevel.get(level) ?? []
    tablesByLevel.set(level, [...existing, table])
  }

  const nextTables = schema.tables.map((table) => {
    const level = levelMap.get(table.id) ?? 0
    const siblings = tablesByLevel.get(level) ?? []
    const index = siblings.findIndex((candidate) => candidate.id === table.id)
    const position =
      direction === 'LR'
        ? {
            x: level * (NODE_WIDTH + NODE_GAP_X),
            y: index * (NODE_HEIGHT + NODE_GAP_Y),
          }
        : {
            x: index * (NODE_WIDTH + NODE_GAP_X),
            y: level * (NODE_HEIGHT + NODE_GAP_Y),
          }

    return {
      ...table,
      position,
    }
  })

  return {
    ...schema,
    tables: nextTables,
  }
}

export function schemaToFlow(schema: SchemaData): { nodes: Node[]; edges: Edge[] } {
  return {
    nodes: schema.tables.map((table) => ({
      id: table.id,
      type: 'schema-table',
      position: table.position ?? { x: 0, y: 0 },
      data: table,
    })),
    edges: schema.relationships.map((relationship) => ({
      id: relationship.id,
      source: relationship.sourceTableId,
      target: relationship.targetTableId,
      sourceHandle: `${relationship.sourceColumnId}:source`,
      targetHandle: `${relationship.targetColumnId}:target`,
      type: 'schema-relationship',
      data: {
        kind: relationship.kind,
        color: relationship.color,
        label: relationship.label,
      },
      selectable: true,
    })),
  }
}
