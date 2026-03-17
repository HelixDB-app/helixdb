'use client'

import { useMemo, useState } from 'react'
import { Handle, Position, NodeProps } from 'reactflow'
import { Plus, Trash2 } from 'lucide-react'
import { useSchemaStore } from '@/lib/schema-store'
import { cn } from '@/lib/utils'

const COLUMN_TYPES = [
  'string',
  'integer',
  'numeric',
  'boolean',
  'text',
  'timestamp',
  'uuid',
  'json',
]

const ROW_HEIGHT = 28
const HEADER_HEIGHT = 36

export type TableNodeData = {
  tableName: string
  tableId: string
  columns: Array<{
    id: string
    name: string
    type: string
    nullable: boolean
    isPrimaryKey: boolean
    isUnique: boolean
  }>
  indexes?: Array<{
    id: string
    name: string
    columns: string[]
    unique: boolean
    method?: string
  }>
}

export function TableNode({ data, selected }: NodeProps<TableNodeData>) {
  const {
    deleteTable,
    setSelectedTableId,
    updateColumn,
    addColumn,
    updateTable,
  } = useSchemaStore()
  const [editingTable, setEditingTable] = useState(false)
  const [editingColumnId, setEditingColumnId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [draftType, setDraftType] = useState('string')

  const columnsById = useMemo(
    () => new Map(data.columns.map((col) => [col.id, col])),
    [data.columns]
  )

  const startEditColumn = (colId: string) => {
    const column = columnsById.get(colId)
    if (!column) return
    setEditingColumnId(colId)
    setDraftName(column.name)
    setDraftType(column.type)
  }

  const commitColumn = () => {
    if (!editingColumnId) return
    const column = columnsById.get(editingColumnId)
    if (!column) return
    updateColumn(data.tableId, editingColumnId, {
      name: draftName.trim() || column.name,
      type: (draftType || column.type) as any,
    })
    setEditingColumnId(null)
  }

  const handleAddColumn = () => {
    const nextIndex = data.columns.length + 1
    addColumn(data.tableId, {
      id: `col-${Date.now()}`,
      name: `column_${nextIndex}`,
      type: 'string',
      nullable: true,
      isPrimaryKey: false,
      isUnique: false,
    })
  }

  return (
    <div
      className={cn(
        'schema-card group relative',
        selected && 'schema-card--selected'
      )}
      onClick={() => setSelectedTableId(data.tableId)}
    >
      {/* Handles */}
      {data.columns.map((col, index) => {
        const top = HEADER_HEIGHT + index * ROW_HEIGHT + ROW_HEIGHT / 2
        return (
          <div key={col.id}>
            <Handle
              type="target"
              position={Position.Left}
              id={`${col.id}:target`}
              style={{ top }}
              className="schema-handle"
            />
            <Handle
              type="source"
              position={Position.Right}
              id={`${col.id}:source`}
              style={{ top }}
              className="schema-handle"
            />
          </div>
        )
      })}

      {/* Header */}
      <div className="schema-card-header flex items-center justify-between px-3 py-2">
        {editingTable ? (
          <input
            className="nodrag h-6 w-full rounded border border-border bg-background px-2 text-xs font-semibold text-foreground outline-none"
            value={data.tableName}
            onChange={(e) =>
              updateTable(data.tableId, { name: e.target.value })
            }
            onBlur={() => setEditingTable(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setEditingTable(false)
            }}
            autoFocus
          />
        ) : (
          <button
            className="schema-card-title text-sm font-semibold text-foreground text-left"
            onDoubleClick={(e) => {
              e.stopPropagation()
              setEditingTable(true)
            }}
          >
            {data.tableName}
          </button>
        )}
        <div className="flex items-center gap-1">
          <button
            onClick={(e) => {
              e.stopPropagation()
              handleAddColumn()
            }}
            className="text-muted-foreground hover:text-foreground"
            title="Add column"
          >
            <Plus className="h-4 w-4" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation()
              deleteTable(data.tableId)
            }}
            className="text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Columns */}
      <div className="p-2">
        {data.columns.map((col) => {
          const isEditing = editingColumnId === col.id
          const badgeClass = col.isPrimaryKey
            ? 'schema-badge--pk'
            : col.isUnique
              ? 'schema-badge--uq'
              : 'schema-badge--empty'
          return (
            <div
              key={col.id}
              className="schema-row text-xs text-foreground"
              onClick={(e) => {
                e.stopPropagation()
                if (!isEditing) startEditColumn(col.id)
              }}
            >
              <span className={cn('schema-badge', badgeClass)}>
                {col.isPrimaryKey ? 'PK' : col.isUnique ? 'UQ' : 'NA'}
              </span>
              {isEditing ? (
                <div className="schema-row-editor flex items-center gap-2">
                  <input
                    className="nodrag h-6 w-24 rounded border border-border bg-background px-1 text-xs outline-none"
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value)}
                    onBlur={commitColumn}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitColumn()
                      if (e.key === 'Escape') setEditingColumnId(null)
                    }}
                    autoFocus
                  />
                  <select
                    className="nodrag h-6 rounded border border-border bg-background px-1 text-xs outline-none"
                    value={draftType}
                    onChange={(e) => setDraftType(e.target.value)}
                    onBlur={commitColumn}
                  >
                    {COLUMN_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {type}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <>
                  <span className="schema-col-name">{col.name}</span>
                  <span className="schema-col-type">{col.type}</span>
                </>
              )}
            </div>
          )
        })}
        {data.columns.length === 0 && (
          <div className="py-2 px-2 text-xs text-muted-foreground">
            No columns
          </div>
        )}
      </div>

      {/* Indexes */}
      {data.indexes && data.indexes.length > 0 && (
        <div className="border-t border-border bg-muted/40 px-3 py-2 text-[11px]">
          <p className="font-semibold text-muted-foreground">Indexes</p>
          <div className="mt-1 space-y-1">
            {data.indexes.map((idx) => (
              <div key={idx.id} className="flex items-center justify-between">
                <span className="text-foreground">
                  {idx.name}
                  {idx.unique ? ' (unique)' : ''}
                </span>
                <span className="text-muted-foreground">
                  {idx.columns.join(', ')}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
