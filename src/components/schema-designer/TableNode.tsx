'use client'

import { memo, useMemo, useState } from 'react'
import { Handle, Position, type NodeProps } from 'reactflow'
import { ChevronDown, KeyRound, Link2, LucideTableProperties, Radar } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { SchemaColumn, TableNodeData } from '@/lib/schema-designer/types'

const TYPE_COLORS: Record<string, string> = {
  uuid: 'bg-cyan-500/10 text-cyan-200 border-cyan-400/20',
  integer: 'bg-emerald-500/10 text-emerald-200 border-emerald-400/20',
  numeric: 'bg-emerald-500/10 text-emerald-200 border-emerald-400/20',
  text: 'bg-sky-500/10 text-sky-200 border-sky-400/20',
  'varchar(255)': 'bg-sky-500/10 text-sky-200 border-sky-400/20',
  timestamp: 'bg-amber-500/10 text-amber-200 border-amber-400/20',
  date: 'bg-amber-500/10 text-amber-200 border-amber-400/20',
  boolean: 'bg-fuchsia-500/10 text-fuchsia-200 border-fuchsia-400/20',
  jsonb: 'bg-violet-500/10 text-violet-200 border-violet-400/20',
}

function iconForColumn(column: SchemaColumn) {
  if (column.primaryKey) return <KeyRound className="h-3.5 w-3.5 text-amber-300" />
  if (column.references) return <Link2 className="h-3.5 w-3.5 text-cyan-300" />
  if (column.indexed) return <Radar className="h-3.5 w-3.5 text-emerald-300" />
  return <LucideTableProperties className="h-3.5 w-3.5 text-zinc-500" />
}

export const TableNode = memo(function TableNode({ data }: NodeProps<TableNodeData>) {
  const [collapsed, setCollapsed] = useState(false)
  const highlighted = useMemo(
    () => new Set(data.highlightedColumnIds),
    [data.highlightedColumnIds]
  )
  const indexedColumns = useMemo(
    () => new Set(data.table.indexes.flatMap((index) => index.columns)),
    [data.table.indexes]
  )

  return (
    <div
      className={cn(
        'w-[320px] rounded-[26px] border bg-[#131313]/95 shadow-[0_22px_50px_rgba(0,0,0,0.35)] backdrop-blur-xl',
        data.isSelected ? 'border-white/30 ring-1 ring-indigo-400/50' : 'border-white/10'
      )}
      onClick={() => data.onSelect(data.table.id)}
      onDoubleClick={() => data.onEdit(data.table)}
    >
      <div
        className="rounded-t-[25px] border-b border-white/10 px-4 py-3"
        style={{ background: `linear-gradient(135deg, ${data.table.color}, rgba(255,255,255,0.03))` }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-white">{data.table.name}</p>
            <p className="mt-1 text-xs text-white/70">{data.table.columns.length} columns</p>
          </div>
          <div className="flex items-center gap-2">
            <Badge className="rounded-full border-white/10 bg-black/20 text-white">
              {data.table.indexes.length} idx
            </Badge>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                setCollapsed((current) => !current)
              }}
              className="flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-black/15 text-white/70 transition hover:text-white"
            >
              <ChevronDown className={`h-4 w-4 transition-transform ${collapsed ? '-rotate-90' : ''}`} />
            </button>
          </div>
        </div>
      </div>

      {!collapsed ? (
        <div className="max-h-[320px] overflow-y-auto px-2 py-2">
          {data.table.columns.map((column) => {
            const enrichedColumn = {
              ...column,
              indexed: column.indexed || indexedColumns.has(column.name),
            }

            return (
              <Tooltip key={column.id}>
                <TooltipTrigger asChild>
                  <div
                    className={cn(
                      'group relative mb-1 rounded-[18px] border border-transparent px-3 py-2 transition last:mb-0',
                      highlighted.has(column.id)
                        ? 'bg-cyan-400/10 ring-1 ring-cyan-400/30'
                        : 'hover:bg-white/[0.03]'
                    )}
                  >
                    <Handle
                      id={`${column.id}:target`}
                      type="target"
                      position={Position.Left}
                      style={{
                        top: '50%',
                        left: -5,
                        background: data.table.color,
                        transform: 'translateY(-50%)',
                      }}
                      className="!h-3 !w-3 !border-2 !border-[#111111]"
                    />
                    <Handle
                      id={`${column.id}:source`}
                      type="source"
                      position={Position.Right}
                      style={{
                        top: '50%',
                        right: -5,
                        background: data.table.color,
                        transform: 'translateY(-50%)',
                      }}
                      className="!h-3 !w-3 !border-2 !border-[#111111]"
                    />
                    <div className="grid grid-cols-[18px_minmax(0,1fr)_auto_auto] items-center gap-2 text-xs">
                      <span>{iconForColumn(enrichedColumn)}</span>
                      <span className={cn('truncate text-zinc-200', (column.primaryKey || column.references) && 'font-semibold text-white')}>
                        {column.name}
                      </span>
                      <Badge className={cn('rounded-full border px-2 py-0 text-[10px]', TYPE_COLORS[column.type] ?? 'border-white/10 bg-white/5 text-zinc-200')}>
                        {column.type}
                      </Badge>
                      <span className={cn('text-xs', column.nullable ? 'text-zinc-500' : 'text-zinc-200')}>
                        {column.nullable ? '○' : '●'}
                      </span>
                    </div>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="left" className="max-w-xs rounded-2xl border-white/10 bg-[#181818] text-zinc-100">
                  <div className="space-y-1 text-xs">
                    <p className="font-medium text-white">{column.name}</p>
                    <p>Type: {column.type}</p>
                    <p>Nullable: {column.nullable ? 'Yes' : 'No'}</p>
                    <p>Indexed: {enrichedColumn.indexed ? 'Yes' : 'No'}</p>
                    {column.default ? <p>Default: {column.default}</p> : null}
                    {column.references ? <p>FK: {column.references.table}.{column.references.column}</p> : null}
                    {column.description ? <p className="text-zinc-400">{column.description}</p> : null}
                  </div>
                </TooltipContent>
              </Tooltip>
            )
          })}
        </div>
      ) : null}

      <div className="border-t border-white/10 px-4 py-3 text-xs text-zinc-400">
        <p className="line-clamp-1">{data.table.description || 'Double-click to edit this table.'}</p>
      </div>
    </div>
  )
})
