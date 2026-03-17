'use client'

import { useState } from 'react'
import { ChevronDown, ChevronRight, Plus, Trash2 } from 'lucide-react'
import { useSchemaStore } from '@/lib/schema-store'
import { Button } from '@/components/ui/button'
import { TableProperties } from './table-properties'
import { AddTableDialog } from './add-table-dialog'
import { cn } from '@/lib/utils'

export function SchemaExplorer() {
  const {
    tables,
    selectedTableId,
    functions,
    triggers,
    addColumn,
    updateColumn,
    deleteColumn,
    setSelectedTableId,
  } = useSchemaStore()

  const [expandedTables, setExpandedTables] = useState<Set<string>>(
    new Set(tables.map((t) => t.id))
  )

  const toggleTable = (tableId: string) => {
    setExpandedTables((prev) => {
      const next = new Set(prev)
      if (next.has(tableId)) {
        next.delete(tableId)
      } else {
        next.add(tableId)
      }
      return next
    })
  }

  const addNewColumn = (tableId: string) => {
    const table = tables.find((t) => t.id === tableId)
    if (!table) return

    addColumn(tableId, {
      id: `col-${Date.now()}`,
      name: `column_${table.columns.length + 1}`,
      type: 'string',
      nullable: true,
      isPrimaryKey: false,
      isUnique: false,
    })
  }

  return (
    <div className="flex flex-col h-full bg-background border-l border-border">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border p-3">
        <h2 className="text-sm font-semibold text-foreground">Schema</h2>
        <AddTableDialog
          trigger={
            <Button size="sm" variant="ghost" className="h-8 w-8 p-0">
              <Plus className="h-4 w-4" />
            </Button>
          }
        />
      </div>

      {/* Tables List */}
      <div className="flex-1 overflow-y-auto p-2 space-y-4">
        {tables.map((table) => (
          <div key={table.id}>
            {/* Table Item */}
            <div
              className={cn(
                'flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer transition-colors',
                selectedTableId === table.id
                  ? 'bg-primary/10 text-primary'
                  : 'text-foreground hover:bg-muted'
              )}
              onClick={() => {
                setSelectedTableId(table.id)
                toggleTable(table.id)
              }}
            >
              {expandedTables.has(table.id) ? (
                <ChevronDown className="h-4 w-4 flex-shrink-0" />
              ) : (
                <ChevronRight className="h-4 w-4 flex-shrink-0" />
              )}
              <span className="text-sm font-medium flex-1 truncate">
                {table.name}
              </span>
              <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                {table.columns.length}
              </span>
            </div>

            {/* Columns */}
            {expandedTables.has(table.id) && (
              <div className="pl-6 space-y-1 mt-1">
                {table.columns.map((col) => (
                  <div
                    key={col.id}
                    className="flex items-center gap-2 px-2 py-1 rounded text-xs text-muted-foreground hover:bg-muted group"
                  >
                    <span className="font-mono text-foreground">{col.name}</span>
                    <span className="text-muted-foreground text-xs">
                      {col.type}
                    </span>
                    {col.isPrimaryKey && <span className="text-primary">🔑</span>}
                    {col.isUnique && !col.isPrimaryKey && (
                      <span className="text-accent">✓</span>
                    )}
                    <div className="ml-auto flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <TableProperties tableId={table.id} column={col} />
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          deleteColumn(table.id, col.id)
                        }}
                        className="p-0.5 hover:text-destructive"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                ))}
                {table.indexes && table.indexes.length > 0 && (
                  <div className="px-2 py-1 text-[11px] text-muted-foreground">
                    Indexes:{' '}
                    {table.indexes.map((idx) => idx.name).join(', ')}
                  </div>
                )}
                <button
                  onClick={() => addNewColumn(table.id)}
                  className="w-full text-left px-2 py-1 rounded text-xs text-muted-foreground hover:bg-muted transition-colors flex items-center gap-2"
                >
                  <Plus className="h-3 w-3" />
                  Add column
                </button>
              </div>
            )}
          </div>
        ))}

        {functions.length > 0 && (
          <div className="pt-2 border-t border-border">
            <div className="flex items-center justify-between px-2 py-1">
              <span className="text-xs font-semibold text-foreground">
                Functions
              </span>
              <span className="text-[10px] text-muted-foreground">
                {functions.length}
              </span>
            </div>
            <div className="space-y-1 px-2">
              {functions.map((fn) => (
                <div
                  key={fn.id}
                  className="rounded-md bg-muted/40 px-2 py-1 text-[11px] text-foreground"
                >
                  {fn.name}
                </div>
              ))}
            </div>
          </div>
        )}

        {triggers.length > 0 && (
          <div className="pt-2 border-t border-border">
            <div className="flex items-center justify-between px-2 py-1">
              <span className="text-xs font-semibold text-foreground">
                Triggers
              </span>
              <span className="text-[10px] text-muted-foreground">
                {triggers.length}
              </span>
            </div>
            <div className="space-y-1 px-2">
              {triggers.map((trg) => {
                const tableName =
                  tables.find((t) => t.id === trg.tableId)?.name ?? 'table'
                return (
                  <div
                    key={trg.id}
                    className="rounded-md bg-muted/40 px-2 py-1 text-[11px] text-foreground"
                  >
                    {trg.name}
                    <span className="ml-2 text-[10px] text-muted-foreground">
                      on {tableName}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
