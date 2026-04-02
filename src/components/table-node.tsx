'use client'

import { memo, useMemo, useState } from 'react'
import { Handle, Position, NodeProps } from 'reactflow'
import { KeyRound, Plus, Trash2 } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useSchemaStore } from '@/lib/schema-store'
import type { Column } from '@/lib/schema-store'
import {
  ERD_TABLE_CARD_WIDTH,
  HEADER_HEIGHT,
  ROW_HEIGHT,
  createSchemaColumnId,
} from '@/lib/schema-canvas-layout'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardHeader,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

const COLUMN_TYPES = [
  'string',
  'integer',
  'numeric',
  'boolean',
  'text',
  'timestamp',
  'uuid',
  'json',
] as const

/**
 * ERD grid: key slot | field name | constraints (NN / UQ) | type
 * Matches professional diagram tools: types form one vertical column, flags don’t crowd the name.
 */
const ERD_GRID =
  'grid grid-cols-[1.25rem_minmax(0,1fr)_2.25rem_5.75rem] items-center gap-x-2.5'

export type TableNodeData = {
  tableName: string
  tableId: string
  headerHex?: string
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

function tableNodeDataEqual(a: TableNodeData, b: TableNodeData): boolean {
  if (a.tableId !== b.tableId || a.tableName !== b.tableName) return false
  if (a.headerHex !== b.headerHex) return false
  if (a.columns.length !== b.columns.length) return false
  for (let i = 0; i < a.columns.length; i += 1) {
    const x = a.columns[i]
    const y = b.columns[i]
    if (
      x.id !== y.id ||
      x.name !== y.name ||
      x.type !== y.type ||
      x.nullable !== y.nullable ||
      x.isPrimaryKey !== y.isPrimaryKey ||
      x.isUnique !== y.isUnique
    ) {
      return false
    }
  }
  const ai = a.indexes ?? []
  const bi = b.indexes ?? []
  if (ai.length !== bi.length) return false
  for (let i = 0; i < ai.length; i += 1) {
    const x = ai[i]
    const y = bi[i]
    if (
      x.id !== y.id ||
      x.name !== y.name ||
      x.unique !== y.unique ||
      x.method !== y.method ||
      x.columns.join('\0') !== y.columns.join('\0')
    ) {
      return false
    }
  }
  return true
}

function constraintLabel(col: {
  nullable: boolean
  isPrimaryKey: boolean
  isUnique: boolean
}): string | null {
  const parts: string[] = []
  if (!col.nullable) parts.push('NN')
  if (col.isUnique && !col.isPrimaryKey) parts.push('UQ')
  if (parts.length === 0) return null
  return parts.join('·')
}

function TableNodeInner({ data, selected }: NodeProps<TableNodeData>) {
  const { deleteTable, setSelectedTableId, updateColumn, addColumn, updateTable } =
    useSchemaStore(
      useShallow((s) => ({
        deleteTable: s.deleteTable,
        setSelectedTableId: s.setSelectedTableId,
        updateColumn: s.updateColumn,
        addColumn: s.addColumn,
        updateTable: s.updateTable,
      }))
    )
  const [editingTable, setEditingTable] = useState(false)
  const [editingColumnId, setEditingColumnId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [draftType, setDraftType] = useState<string>('string')

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
      type: (draftType || column.type) as Column['type'],
    })
    setEditingColumnId(null)
  }

  const handleAddColumn = () => {
    const nextIndex = data.columns.length + 1
    addColumn(data.tableId, {
      id: createSchemaColumnId(),
      name: `column_${nextIndex}`,
      type: 'string',
      nullable: true,
      isPrimaryKey: false,
      isUnique: false,
    })
  }

  return (
    <Card
      style={{ width: ERD_TABLE_CARD_WIDTH, minWidth: ERD_TABLE_CARD_WIDTH }}
      className={cn(
        'schema-card schema-card--erd group relative max-w-none gap-0 overflow-hidden rounded-xl border py-0 text-xs shadow-sm',
        selected && 'schema-card--selected'
      )}
      onClick={() => setSelectedTableId(data.tableId)}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest('button, input')) return
        useSchemaStore.getState().setDesignerEditTableId(data.tableId)
      }}
    >
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

      <CardHeader
        className="schema-card-header flex min-h-9 flex-row items-center justify-between space-y-0 px-3.5 py-2.5"
        style={
          data.headerHex && /^#[0-9A-Fa-f]{6}$/i.test(data.headerHex)
            ? {
                backgroundColor: `color-mix(in srgb, ${data.headerHex} 38%, transparent)`,
                borderBottom: `1px solid color-mix(in srgb, ${data.headerHex} 50%, transparent)`,
              }
            : undefined
        }
      >
        {editingTable ? (
          <Input
            className="nodrag nopan h-8 font-mono text-sm font-semibold tracking-tight"
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
            type="button"
            className="schema-card-title min-w-0 flex-1 truncate text-left font-mono text-sm font-semibold tracking-tight text-foreground"
            title="Double-click to rename"
            onDoubleClick={(e) => {
              e.stopPropagation()
              setEditingTable(true)
            }}
          >
            {data.tableName}
          </button>
        )}
        <div className="flex shrink-0 items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="nodrag nopan h-8 w-8 text-muted-foreground hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation()
                  handleAddColumn()
                }}
                aria-label="Add column"
              >
                <Plus className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Add column</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="nodrag nopan h-8 w-8 text-muted-foreground hover:text-destructive"
                onClick={(e) => {
                  e.stopPropagation()
                  deleteTable(data.tableId)
                }}
                aria-label="Delete table"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Delete table</TooltipContent>
          </Tooltip>
        </div>
      </CardHeader>

      <Separator className="bg-border/70" />

      <div
        className={cn(
          ERD_GRID,
          'min-h-6 border-b border-border/60 bg-muted/35 px-3 py-2'
        )}
        aria-hidden
      >
        <span />
        <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Field
        </span>
        <span
          className="text-center text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/80"
          title="Constraints: NN = not null, UQ = unique"
        >
          —
        </span>
        <span className="text-right text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Type
        </span>
      </div>

      <CardContent className="px-0 pb-0 pt-0">
        {data.columns.map((col) => {
          const isEditing = editingColumnId === col.id
          const flags = constraintLabel(col)
          return (
            <div
              key={col.id}
              role="button"
              tabIndex={0}
              className={cn(
                ERD_GRID,
                'border-b border-border/40 px-3 py-1.5 transition-colors last:border-b-0',
                'min-h-[30px] hover:bg-muted/40',
                isEditing && 'bg-muted/55'
              )}
              onClick={(e) => {
                e.stopPropagation()
                if (!isEditing) startEditColumn(col.id)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  if (!isEditing) startEditColumn(col.id)
                }
              }}
            >
              {isEditing ? (
                <div
                  className="nodrag nopan col-span-4 flex flex-wrap items-center gap-2 py-0.5"
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  <Input
                    className="h-8 min-w-[7rem] flex-1 text-xs"
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value)}
                    onBlur={commitColumn}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitColumn()
                      if (e.key === 'Escape') setEditingColumnId(null)
                    }}
                    autoFocus
                  />
                  <Select
                    value={draftType}
                    onValueChange={(v) => setDraftType(v)}
                  >
                    <SelectTrigger
                      className="nodrag nopan h-8 w-[6.5rem] text-xs"
                      size="sm"
                      onPointerDown={(e) => e.stopPropagation()}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="z-[200]">
                      {COLUMN_TYPES.map((type) => (
                        <SelectItem key={type} value={type} className="text-xs">
                          {type}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                <>
                  <span className="flex justify-center">
                    {col.isPrimaryKey ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="inline-flex cursor-default">
                            <KeyRound
                              className="h-4 w-4 text-amber-500 dark:text-amber-400"
                              aria-hidden
                              strokeWidth={2.25}
                            />
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="top">Primary key</TooltipContent>
                      </Tooltip>
                    ) : (
                      <span className="block h-4 w-4" aria-hidden />
                    )}
                  </span>
                  <span className="min-w-0 truncate text-[13px] font-medium leading-snug text-foreground">
                    {col.name}
                  </span>
                  {flags ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="block cursor-default text-center font-mono text-[10px] font-semibold leading-tight text-muted-foreground">
                          {flags}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="max-w-[12rem] text-xs">
                        {[
                          !col.nullable ? 'Not null (NN)' : null,
                          col.isUnique && !col.isPrimaryKey ? 'Unique (UQ)' : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </TooltipContent>
                    </Tooltip>
                  ) : (
                    <span className="block text-center" aria-hidden>
                      &nbsp;
                    </span>
                  )}
                  <span
                    className="truncate text-right font-mono text-[11px] tabular-nums tracking-tight text-muted-foreground"
                    title={col.type}
                  >
                    {col.type}
                  </span>
                </>
              )}
            </div>
          )
        })}
        {data.columns.length === 0 && (
          <p className="px-3 py-4 text-center text-[12px] text-muted-foreground">
            No columns — use + to add
          </p>
        )}
      </CardContent>

      {data.indexes && data.indexes.length > 0 && (
        <div className="border-t border-border/70 bg-muted/30 px-3 py-2.5">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Indexes
          </p>
          <div className="space-y-1.5">
            {data.indexes.map((idx) => (
              <div
                key={idx.id}
                className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 border-b border-border/25 pb-1.5 text-[11px] leading-snug last:border-0 last:pb-0"
              >
                <span className="min-w-0 truncate text-foreground">
                  {idx.name}
                  {idx.unique ? (
                    <span className="text-muted-foreground"> · unique</span>
                  ) : null}
                </span>
                <span className="max-w-[7.5rem] shrink-0 truncate text-right font-mono text-[10px] text-muted-foreground">
                  {idx.columns.join(', ')}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  )
}

export const TableNode = memo(
  TableNodeInner,
  (prev, next) =>
    prev.id === next.id &&
    prev.selected === next.selected &&
    tableNodeDataEqual(prev.data, next.data)
)

TableNode.displayName = 'TableNode'
